import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { SlackEventRouter, type SlackIngressResult } from "../src/slack/events.ts";
import { AgentTagStore } from "../src/store/store.ts";
import {
  MAX_PENDING_THREAD_NOTES,
  MAX_THREAD_NOTE_CHARS,
  type RecordThreadNoteInput,
} from "../src/store/thread-notes.ts";

const receivedAt = "2026-09-21T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering", repositoryRoot: "/srv/repos/example" }],
  limits: { maxConcurrentTasks: 2 },
});

function mentionBody(eventId: string, ts: string, text = "<@U0BOT> investigate this"): unknown {
  return {
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: { type: "app_mention", user: "U1", channel: "C1", ts, text },
  };
}

function acceptedTaskId(result: SlackIngressResult): string {
  if (result.kind !== "accepted") throw new Error(`expected an accepted mention, got ${JSON.stringify(result)}`);
  return result.receipt.taskId;
}

/** A note on thread 1000.000001 (the first fixture task) unless overridden. */
function noteInput(overrides: Partial<RecordThreadNoteInput> = {}): RecordThreadNoteInput {
  return {
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    sourceEventKey: "C1:1000.000010",
    sourceDeliveryId: "delivery-note",
    kind: "message",
    speakerKind: "bot",
    speakerId: "B2",
    speakerLabel: "CI",
    steeringAllowed: false,
    messageTs: "1000.000010",
    text: "build passed",
    previousText: null,
    sourceOrderKey: "1000.000010",
    now: receivedAt,
    ...overrides,
  };
}

interface Fixture {
  readonly store: AgentTagStore;
  readonly path: string;
  /** Bound to C1 thread 1000.000001. */
  readonly taskId: string;
  /** Bound to C1 thread 2000.000001, a second task that must never see the first task's notes. */
  readonly otherTaskId: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-thread-notes-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => receivedAt });
  try {
    const taskId = acceptedTaskId(router.ingest(mentionBody("Ev1", "1000.000001")));
    const otherTaskId = acceptedTaskId(router.ingest(mentionBody("Ev2", "2000.000001")));
    await run({ store, path, taskId, otherTaskId });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-thread-notes-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

/** Reads one raw column through a second connection, the way the retention tests inspect the file. */
function readRaw<T>(path: string, sql: string, ...params: string[]): T | null {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database.query<T, string[]>(sql).get(...params) ?? null;
  } finally {
    database.close();
  }
}

function codePointCount(text: string): number {
  return Array.from(text).length;
}

describe("thread context notes", () => {
  test("records a note once per source event key on an active bound thread", async () => {
    await withFixture(({ store, taskId }) => {
      const first = store.recordThreadNote(noteInput());
      if (first === null) throw new Error("note was not recorded on the bound thread");
      expect(first).toEqual({ noteId: expect.any(String), duplicate: false });

      expect(store.recordThreadNote(noteInput({ text: "retried delivery" }))).toEqual({
        noteId: first.noteId,
        duplicate: true,
      });
      expect(store.listPendingThreadNotes(taskId).map((note) => note.noteId)).toEqual([first.noteId]);
    });
  });

  test("returns null when no active task is bound to the thread", async () => {
    await withFixture(({ store, path, taskId }) => {
      expect(store.recordThreadNote(noteInput({ threadTs: "9999.000001", sourceEventKey: "C1:9999.000010" }))).toBeNull();
      expect(store.recordThreadNote(noteInput({ conversationId: "C9", sourceEventKey: "C9:1000.000010" }))).toBeNull();
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);

      // A closed binding (the only other state tasks.state allows) also gets no note. No store API
      // closes a task yet, so the state is set directly on a second connection.
      const closer = new Database(path, { strict: true });
      try {
        closer.query("UPDATE tasks SET state = 'closed' WHERE task_id = ?").run(taskId);
      } finally {
        closer.close();
      }
      expect(store.recordThreadNote(noteInput({ sourceEventKey: "C1:1000.000011", sourceOrderKey: "1000.000011" }))).toBeNull();
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
      expect(readRaw<{ count: number }>(path, "SELECT COUNT(*) AS count FROM thread_context_notes")).toEqual({ count: 0 });
    });
  });

  test("caps text and previous text at 4000 code points, counting astral characters once", async () => {
    await withFixture(({ store, path, taskId }) => {
      // Each emoji is one code point but two UTF-16 units, so a UTF-16 cap would keep only 2000 of them.
      const emoji = "\u{1F600}";
      const oversized = emoji.repeat(MAX_THREAD_NOTE_CHARS + 1);
      expect(oversized.length).toBe((MAX_THREAD_NOTE_CHARS + 1) * 2);

      const edited = store.recordThreadNote(
        noteInput({
          kind: "edit",
          sourceEventKey: "C1:1000.000020:edit:1000.000011",
          messageTs: "1000.000020",
          sourceOrderKey: "1000.000011",
          text: oversized,
          previousText: oversized,
        }),
      );
      const exact = store.recordThreadNote(
        noteInput({
          sourceEventKey: "C1:1000.000030",
          messageTs: "1000.000030",
          sourceOrderKey: "1000.000030",
          text: emoji.repeat(MAX_THREAD_NOTE_CHARS),
        }),
      );
      if (edited === null || exact === null) throw new Error("capped notes were not recorded");

      const pending = new Map(store.listPendingThreadNotes(taskId).map((note) => [note.noteId, note]));
      const expectedCapped = `${emoji.repeat(MAX_THREAD_NOTE_CHARS - 1)}…`;
      const cappedNote = pending.get(edited.noteId);
      expect(cappedNote?.text).toBe(expectedCapped);
      expect(cappedNote?.previousText).toBe(expectedCapped);
      expect(codePointCount(cappedNote?.text ?? "")).toBe(MAX_THREAD_NOTE_CHARS);
      expect(cappedNote?.text.endsWith("…")).toBe(true);

      // Exactly at the cap is kept whole, not truncated with an ellipsis.
      expect(pending.get(exact.noteId)?.text).toBe(emoji.repeat(MAX_THREAD_NOTE_CHARS));
      expect(pending.get(exact.noteId)?.previousText).toBeNull();

      // The stored row matches what listPending returned.
      expect(readRaw<{ text: string }>(path, "SELECT text FROM thread_context_notes WHERE note_id = ?", edited.noteId)?.text)
        .toBe(expectedCapped);
    });
  });

  test("lists pending notes oldest first with mapped fields and never another task's notes", async () => {
    await withFixture(({ store, taskId, otherTaskId }) => {
      const later = store.recordThreadNote(
        noteInput({ sourceEventKey: "C1:1000.000030", messageTs: "1000.000030", sourceOrderKey: "1000.000030", text: "third" }),
      );
      const first = store.recordThreadNote(
        noteInput({
          sourceEventKey: "C1:1000.000010",
          messageTs: "1000.000010",
          sourceOrderKey: "1000.000010",
          speakerKind: "human",
          speakerId: "U2",
          speakerLabel: null,
          steeringAllowed: true,
          text: "first",
        }),
      );
      const editedNote = store.recordThreadNote(
        noteInput({
          kind: "edit",
          sourceEventKey: "C1:1000.000020:edit:1000.000015",
          messageTs: "1000.000020",
          sourceOrderKey: "1000.000015",
          text: "second, edited",
          previousText: "second",
        }),
      );
      const tieA = store.recordThreadNote(
        noteInput({ sourceEventKey: "C1:1000.000021", messageTs: "1000.000021", sourceOrderKey: "1000.000020", text: "tie a" }),
      );
      const tieB = store.recordThreadNote(
        noteInput({ sourceEventKey: "C1:1000.000022", messageTs: "1000.000022", sourceOrderKey: "1000.000020", text: "tie b" }),
      );
      // Sorts before everything on the first task if the query ignored the task filter.
      store.recordThreadNote(
        noteInput({
          threadTs: "2000.000001",
          sourceEventKey: "C1:2000.000005",
          messageTs: "2000.000005",
          sourceOrderKey: "1000.000005",
          text: "other task",
        }),
      );
      if ([later, first, editedNote, tieA, tieB].some((note) => note === null)) throw new Error("notes not recorded");
      const ids = (note: typeof first) => note?.noteId ?? "";
      const tied = [ids(tieA), ids(tieB)].sort();

      expect(store.listPendingThreadNotes(taskId)).toEqual([
        {
          noteId: ids(first),
          kind: "message",
          speakerKind: "human",
          speakerId: "U2",
          speakerLabel: null,
          steeringAllowed: true,
          messageTs: "1000.000010",
          text: "first",
          previousText: null,
        },
        {
          noteId: ids(editedNote),
          kind: "edit",
          speakerKind: "bot",
          speakerId: "B2",
          speakerLabel: "CI",
          steeringAllowed: false,
          messageTs: "1000.000020",
          text: "second, edited",
          previousText: "second",
        },
        ...tied.map((noteId) => ({
          noteId,
          kind: "message" as const,
          speakerKind: "bot" as const,
          speakerId: "B2",
          speakerLabel: "CI",
          steeringAllowed: false,
          messageTs: noteId === ids(tieA) ? "1000.000021" : "1000.000022",
          text: noteId === ids(tieA) ? "tie a" : "tie b",
          previousText: null,
        })),
        {
          noteId: ids(later),
          kind: "message",
          speakerKind: "bot",
          speakerId: "B2",
          speakerLabel: "CI",
          steeringAllowed: false,
          messageTs: "1000.000030",
          text: "third",
          previousText: null,
        },
      ]);
      expect(store.listPendingThreadNotes(otherTaskId).map((note) => note.text)).toEqual(["other task"]);
    });
  });

  test("keeps at most 50 pending notes per task, dropping the oldest with an audit row", async () => {
    await withFixture(({ store, taskId }) => {
      expect(MAX_PENDING_THREAD_NOTES).toBe(50);
      const recorded: Array<{ readonly noteId: string; readonly sourceEventKey: string }> = [];
      for (let index = 0; index <= MAX_PENDING_THREAD_NOTES; index += 1) {
        const ts = `1000.${String(index + 100).padStart(6, "0")}`;
        const sourceEventKey = `C1:${ts}`;
        const result = store.recordThreadNote(
          noteInput({ sourceEventKey, messageTs: ts, sourceOrderKey: ts, text: `distinct note body ${index}` }),
        );
        if (result === null || result.duplicate) throw new Error(`note ${index} was not recorded`);
        recorded.push({ noteId: result.noteId, sourceEventKey });
      }
      expect(recorded).toHaveLength(51);

      const pending = store.listPendingThreadNotes(taskId);
      expect(pending).toHaveLength(MAX_PENDING_THREAD_NOTES);
      expect(pending.map((note) => note.messageTs)).toEqual(
        recorded.slice(1).map((_, index) => `1000.${String(index + 101).padStart(6, "0")}`),
      );
      expect(pending.some((note) => note.noteId === recorded[0]?.noteId)).toBe(false);

      const audit = store.listAuditRecords({ limit: 10_000 });
      const dropped = audit.filter((record) => record.action === "thread-note.dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        source: recorded[0]?.noteId,
        target: taskId,
        result: "pending-cap",
        metadata: { pendingCap: MAX_PENDING_THREAD_NOTES },
      });

      // The recorded row names only the kind and speaker, never the note body.
      const recordedAudit = audit.find(
        (record) => record.action === "thread-note.recorded" && record.source === recorded[0]?.sourceEventKey,
      );
      expect(recordedAudit?.metadata).toEqual({ kind: "message", speakerKind: "bot" });
      expect(JSON.stringify(recordedAudit)).not.toContain("distinct note body 0");
    });
  });

  test("resolving the turn text consumes exactly the notes it shows, once", async () => {
    await withFixture(({ store, path, taskId, otherTaskId }) => {
      const first = store.recordThreadNote(noteInput({ sourceEventKey: "C1:1000.000010", sourceOrderKey: "1000.000010" }));
      const second = store.recordThreadNote(
        noteInput({ sourceEventKey: "C1:1000.000011", messageTs: "1000.000011", sourceOrderKey: "1000.000011", text: "second" }),
      );
      const otherNote = store.recordThreadNote(
        noteInput({
          threadTs: "2000.000001",
          sourceEventKey: "C1:2000.000010",
          messageTs: "2000.000010",
          sourceOrderKey: "2000.000010",
          text: "other task note",
        }),
      );
      if (first === null || second === null || otherNote === null) throw new Error("notes not recorded");
      const firstShown = first.noteId;
      const secondShown = second.noteId;

      const claimed = store.claimNextOperation({
        workerId: "worker-a",
        now: receivedAt,
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      if (claimed === null || claimed.taskId !== taskId) throw new Error("first task's operation was not claimed");

      expect(
        store.resolveOperationTurnText({
          operationId: claimed.operationId,
          workerId: "worker-a",
          proposedText: "frozen prompt",
          consumeNoteIds: [firstShown, secondShown, otherNote.noteId],
          now: receivedAt,
        }),
      ).toBe("frozen prompt");

      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
      expect(store.listPendingThreadNotes(otherTaskId).map((note) => note.noteId)).toEqual([otherNote.noteId]);
      expect(readRaw<{ consumed_by_operation_id: string }>(
        path,
        "SELECT consumed_by_operation_id FROM thread_context_notes WHERE note_id = ?",
        firstShown,
      )?.consumed_by_operation_id).toBe(claimed.operationId);
      expect(readRaw<{ consumed_by_operation_id: string | null }>(
        path,
        "SELECT consumed_by_operation_id FROM thread_context_notes WHERE note_id = ?",
        otherNote.noteId,
      )?.consumed_by_operation_id).toBeNull();

      const resolvedAudit = store
        .listAuditRecords({ limit: 10_000 })
        .filter((record) => record.action === "operation.turn-text.resolved" && record.source === claimed.operationId);
      expect(resolvedAudit).toHaveLength(1);
      expect(resolvedAudit[0]?.metadata).toEqual({ notesConsumed: 2 });

      // A later note stays pending: a retry returns the frozen text and must not consume anything.
      const late = store.recordThreadNote(
        noteInput({ sourceEventKey: "C1:1000.000050", messageTs: "1000.000050", sourceOrderKey: "1000.000050", text: "late" }),
      );
      if (late === null) throw new Error("late note not recorded");
      expect(
        store.resolveOperationTurnText({
          operationId: claimed.operationId,
          workerId: "worker-a",
          proposedText: "changed prompt after retry",
          consumeNoteIds: [late.noteId],
          now: receivedAt,
        }),
      ).toBe("frozen prompt");
      expect(store.listPendingThreadNotes(taskId).map((note) => note.noteId)).toEqual([late.noteId]);
      expect(readRaw<{ consumed_by_operation_id: string | null }>(
        path,
        "SELECT consumed_by_operation_id FROM thread_context_notes WHERE note_id = ?",
        late.noteId,
      )?.consumed_by_operation_id).toBeNull();
    });
  });

  test("finds the text an ingested Slack message was stored with, without the bot mention", async () => {
    await withFixture(({ store }) => {
      expect(store.findIngestedText("T1", "C1:1000.000001")).toBe("investigate this");
      expect(store.findIngestedText("T1", "C1:9999.000001")).toBeNull();
      expect(store.findIngestedText("T9", "C1:1000.000001")).toBeNull();
    });
  });
});
