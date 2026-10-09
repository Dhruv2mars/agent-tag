import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import {
  createRetentionWorker,
  PRUNED_TEXT,
  pruneDatabaseFile,
  pruneRetainedData,
  retentionCutoff,
  retentionEnabled,
} from "../src/store/retention.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";
import type { RecordThreadNoteInput } from "../src/store/thread-notes.ts";

const oldAt = "2026-01-01T00:00:00.000Z";
const recentAt = "2026-09-20T00:00:00.000Z";
const nowAt = "2026-09-21T00:00:00.000Z";
const policy = { auditDays: 30, outboxDays: 30, messageDays: 30 };

function slackEvent(index: number, receivedAt: string, text: string): SlackEventInput {
  return {
    deliveryId: `delivery-${index}`,
    eventKey: `C1:100${index}.0001`,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: `100${index}.0001`,
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text,
    receivedAt,
    sourceOrderKey: `100${index}.0001`,
  };
}

function plusSeconds(at: string, seconds: number): string {
  return new Date(Date.parse(at) + seconds * 1_000).toISOString();
}

async function withSeededStore(
  run: (input: { readonly store: AgentTagStore; readonly path: string }) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-retention-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    // 1: old turn completed with a delivered reply.
    const delivered = store.ingestSlackEvent(slackEvent(1, oldAt, "old delivered request"));
    if (store.claimNextOperation({ workerId: "w", now: oldAt, leaseMs: 10_000, maxConcurrentTasks: 4 }) === null) {
      throw new Error("operation 1 was not claimed");
    }
    store.completeOperationWithOutbox({
      operationId: delivered.operationId,
      taskId: delivered.taskId,
      workerId: "w",
      resultSequence: 1,
      conversationId: "C1",
      threadTs: "1001.0001",
      text: "old delivered reply",
      now: oldAt,
    });
    const outbox = store.claimNextOutbox({ workerId: "s", now: plusSeconds(oldAt, 1), leaseMs: 10_000 });
    if (outbox === null) throw new Error("outbox 1 was not claimed");
    store.markOutboxDelivered({ outboxId: outbox.outboxId, workerId: "s", slackMessageTs: "1001.0002", now: plusSeconds(oldAt, 2) });

    // 2: old failed turn whose failure notice was quarantined as delivery-outcome-unknown.
    const quarantined = store.ingestSlackEvent(slackEvent(2, plusSeconds(oldAt, 10), "old quarantined request"));
    if (store.claimNextOperation({ workerId: "w", now: plusSeconds(oldAt, 10), leaseMs: 10_000, maxConcurrentTasks: 4 }) === null) {
      throw new Error("operation 2 was not claimed");
    }
    store.failOperationWithOutbox({
      operationId: quarantined.operationId,
      taskId: quarantined.taskId,
      workerId: "w",
      errorCode: "T3ProviderLimit",
      conversationId: "C1",
      threadTs: "1002.0001",
      text: "old quarantined notice",
      now: plusSeconds(oldAt, 10),
    });
    store.claimNextOutbox({ workerId: "s", now: plusSeconds(oldAt, 11), leaseMs: 1_000 });
    store.quarantineExpiredOutbox(plusSeconds(oldAt, 20));

    // 3: old turn still pending (deferred work keeps its text). 4: recent pending turn.
    store.ingestSlackEvent(slackEvent(3, plusSeconds(oldAt, 30), "old pending request"));
    store.ingestSlackEvent(slackEvent(4, recentAt, "recent request"));
    await run({ store, path });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-retention-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function readRows(path: string): {
  readonly events: ReadonlyArray<string>;
  readonly operations: ReadonlyArray<string>;
  readonly outbox: ReadonlyArray<string>;
  readonly auditCount: number;
} {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return {
      events: database
        .query<{ text: string }, []>("SELECT text FROM slack_events ORDER BY event_key")
        .all()
        .map((row) => row.text),
      operations: database
        .query<{ text: string }, []>(
          "SELECT json_extract(payload_json, '$.text') AS text FROM operations ORDER BY source_order_key",
        )
        .all()
        .map((row) => row.text),
      outbox: database
        .query<{ text: string }, []>(
          "SELECT json_extract(payload_json, '$.text') AS text FROM slack_outbox ORDER BY created_at",
        )
        .all()
        .map((row) => row.text),
      auditCount: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM audit_log").get()?.count ?? -1,
    };
  } finally {
    database.close();
  }
}

/** A thread note on the thread of `slackEvent(3, ...)`, the old pending turn in `withSeededStore`. */
function threadNote(overrides: Partial<RecordThreadNoteInput>): RecordThreadNoteInput {
  return {
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1003.0001",
    sourceEventKey: "C1:1003.0003",
    sourceDeliveryId: "delivery-note",
    kind: "message",
    speakerKind: "human",
    speakerId: "U1",
    speakerLabel: null,
    steeringAllowed: false,
    messageTs: "1003.0003",
    text: "note",
    previousText: null,
    sourceOrderKey: "1003.0003",
    now: oldAt,
    ...overrides,
  };
}

function readNotes(path: string): ReadonlyArray<{
  readonly key: string;
  readonly text: string;
  readonly previousText: string | null;
  readonly consumed: boolean;
}> {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database
      .query<{ source_event_key: string; text: string; previous_text: string | null; consumed: number }, []>(
        `SELECT source_event_key, text, previous_text, consumed_by_operation_id IS NOT NULL AS consumed
         FROM thread_context_notes ORDER BY source_event_key`,
      )
      .all()
      .map((row) => ({
        key: row.source_event_key,
        text: row.text,
        previousText: row.previous_text,
        consumed: row.consumed === 1,
      }));
  } finally {
    database.close();
  }
}

describe("data retention", () => {
  test("computes cutoffs and rejects invalid policies", () => {
    expect(retentionCutoff(nowAt, 30)).toBe("2026-08-22T00:00:00.000Z");
    expect(retentionCutoff(nowAt, undefined)).toBeNull();
    expect(() => retentionCutoff(nowAt, 0)).toThrow("positive integer");
    expect(() => retentionCutoff("yesterday", 1)).toThrow("ISO date-time");
    expect(retentionEnabled({})).toBe(false);
    expect(retentionEnabled({ auditDays: 1 })).toBe(true);
  });

  test("redacts settled message bodies, deletes old audit rows, and keeps live work intact", async () => {
    await withSeededStore(({ store, path }) => {
      const before = readRows(path);
      expect(before.events).toEqual([
        "old delivered request",
        "old quarantined request",
        "old pending request",
        "recent request",
      ]);

      const dryRun = pruneDatabaseFile(path, { policy, now: nowAt, dryRun: true });
      expect(readRows(path)).toEqual(before);

      const result = pruneDatabaseFile(path, { policy, now: nowAt });
      expect(result).toEqual({ ...dryRun, dryRun: false });
      expect(result).toMatchObject({ eventsRedacted: 3, operationsRedacted: 2, outboxRedacted: 1 });
      expect(result.auditDeleted).toBeGreaterThan(0);

      const after = readRows(path);
      expect(after.events).toEqual([PRUNED_TEXT, PRUNED_TEXT, PRUNED_TEXT, "recent request"]);
      expect(after.operations).toEqual([PRUNED_TEXT, PRUNED_TEXT, "old pending request", "recent request"]);
      // The quarantined send keeps its payload for operator reconciliation.
      expect(after.outbox).toEqual([PRUNED_TEXT, "old quarantined notice"]);
      expect(after.auditCount).toBe(before.auditCount - result.auditDeleted);

      // The store still parses every remaining audit row and can dispatch pending work.
      expect(store.listAuditRecords().every((record) => record.createdAt >= "2026-08-22")).toBe(true);
      const claimed = store.claimNextOperation({ workerId: "w2", now: nowAt, leaseMs: 10_000, maxConcurrentTasks: 4 });
      expect(claimed?.payload.text).toBe("old pending request");

      expect(pruneDatabaseFile(path, { policy, now: nowAt })).toMatchObject({
        auditDeleted: 0,
        eventsRedacted: 0,
        operationsRedacted: 0,
        outboxRedacted: 0,
      });
    });
  });

  test("redacts the prompts of long-ended schedules and keeps active ones", async () => {
    await withSeededStore(({ store, path }) => {
      const taskId = store.ensureTaskForThread({
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1009.0001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        now: oldAt,
      });
      const schedule = (prompt: string) =>
        store.createSchedule({
          taskId,
          actorUserId: "U1",
          kind: "reminder",
          prompt,
          runAt: plusSeconds(nowAt, 3_600),
          cadenceSeconds: 3_600,
          missedRunPolicy: "skip",
          misfireGraceSeconds: 60,
          overlapPolicy: "skip",
          now: oldAt,
        }).scheduleId;
      const ended = schedule("old ended routine");
      const active = schedule("old active routine");
      const recent = schedule("recently ended routine");
      store.cancelSchedule({ scheduleId: ended, taskId, actorUserId: "U1", now: plusSeconds(oldAt, 60) });
      store.cancelSchedule({ scheduleId: recent, taskId, actorUserId: "U1", now: recentAt });

      expect(pruneDatabaseFile(path, { policy, now: nowAt, dryRun: true }).schedulesRedacted).toBe(1);
      expect(pruneDatabaseFile(path, { policy, now: nowAt }).schedulesRedacted).toBe(1);
      expect(store.getSchedule(ended)?.prompt).toBe(PRUNED_TEXT);
      expect(store.getSchedule(active)?.prompt).toBe("old active routine");
      expect(store.getSchedule(recent)?.prompt).toBe("recently ended routine");
      expect(pruneDatabaseFile(path, { policy, now: nowAt }).schedulesRedacted).toBe(0);
    });
  });

  test("redacts consumed thread notes past messageDays, deletes stale unconsumed ones, keeps recent ones", async () => {
    await withSeededStore(({ store, path }) => {
      // Old notes on the old pending turn's thread (1003.0001), one of them an edit with previous text.
      const oldEdit = store.recordThreadNote(
        threadNote({
          kind: "edit",
          sourceEventKey: "C1:1003.0001:edit:1003.0002",
          messageTs: "1003.0001",
          sourceOrderKey: "1003.0002",
          text: "old consumed edit",
          previousText: "old text before the edit",
        }),
      );
      const oldMessage = store.recordThreadNote(threadNote({ text: "old consumed message" }));
      const oldUnconsumed = store.recordThreadNote(
        threadNote({ sourceEventKey: "C1:1003.0004", messageTs: "1003.0004", sourceOrderKey: "1003.0004", text: "stale note" }),
      );
      // Recent notes: one consumed by the same turn, one still pending on the other (1004.0001) thread.
      const recentConsumed = store.recordThreadNote(
        threadNote({
          sourceEventKey: "C1:1003.0005",
          messageTs: "1003.0005",
          sourceOrderKey: "1003.0005",
          text: "recent consumed note",
          now: recentAt,
        }),
      );
      const recentPending = store.recordThreadNote(
        threadNote({
          threadTs: "1004.0001",
          sourceEventKey: "C1:1004.0002",
          messageTs: "1004.0002",
          sourceOrderKey: "1004.0002",
          text: "recent pending note",
          now: recentAt,
        }),
      );
      if ([oldEdit, oldMessage, oldUnconsumed, recentConsumed, recentPending].some((note) => note === null)) {
        throw new Error("thread notes were not recorded");
      }
      const ids = [oldEdit, oldMessage, recentConsumed].map((note) => note?.noteId ?? "");

      // Consumes the three notes on the old pending turn; the claim and resolve happen at the recent time.
      const claimed = store.claimNextOperation({ workerId: "w3", now: recentAt, leaseMs: 10_000, maxConcurrentTasks: 4 });
      if (claimed?.payload.text !== "old pending request") throw new Error("old pending turn was not claimed");
      expect(
        store.resolveOperationTurnText({
          operationId: claimed.operationId,
          workerId: "w3",
          proposedText: "old pending request",
          consumeNoteIds: ids,
          now: recentAt,
        }),
      ).toBe("old pending request");

      const before = readNotes(path);
      expect(before.map((row) => row.key)).toEqual([
        "C1:1003.0001:edit:1003.0002",
        "C1:1003.0003",
        "C1:1003.0004",
        "C1:1003.0005",
        "C1:1004.0002",
      ]);

      // Dry run: the counts match a real prune, and no row changes.
      const dryRun = pruneDatabaseFile(path, { policy, now: nowAt, dryRun: true });
      expect(dryRun).toMatchObject({ notesRedacted: 2, notesDeleted: 1 });
      expect(readNotes(path)).toEqual(before);

      const result = pruneDatabaseFile(path, { policy, now: nowAt });
      expect(result).toEqual({ ...dryRun, dryRun: false });
      expect(readNotes(path)).toEqual([
        {
          key: "C1:1003.0001:edit:1003.0002",
          text: PRUNED_TEXT,
          previousText: PRUNED_TEXT,
          consumed: true,
        },
        // A message never had previous text, so the redaction leaves it NULL.
        { key: "C1:1003.0003", text: PRUNED_TEXT, previousText: null, consumed: true },
        // Recent consumed notes are untouched, and so are recent pending notes.
        { key: "C1:1003.0005", text: "recent consumed note", previousText: null, consumed: true },
        { key: "C1:1004.0002", text: "recent pending note", previousText: null, consumed: false },
      ]);

      expect(pruneDatabaseFile(path, { policy, now: nowAt })).toMatchObject({ notesRedacted: 0, notesDeleted: 0 });
    });
  });

  test("pruned text is gone from the database file and its WAL", async () => {
    await withSeededStore(async ({ path }) => {
      const pruned = ["old delivered request", "old delivered reply", "old quarantined request"];
      const onDisk = async (): Promise<Buffer> => {
        const parts = await Promise.all(
          ["", "-wal"].map(async (suffix) => {
            const file = Bun.file(`${path}${suffix}`);
            return (await file.exists()) ? Buffer.from(await file.bytes()) : Buffer.alloc(0);
          }),
        );
        return Buffer.concat(parts);
      };
      const before = await onDisk();
      for (const marker of pruned) expect(before.includes(marker)).toBe(true);

      // Force the platform default that leaves freed bytes in place; pruning must override it.
      const database = new Database(path, { readwrite: true, create: false, strict: true });
      try {
        database.exec("PRAGMA secure_delete = OFF");
        expect(database.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete).toBe(0);
        expect(pruneRetainedData(database, { policy, now: nowAt })).toMatchObject({ eventsRedacted: 3 });
        expect(database.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete).toBe(1);
      } finally {
        database.close();
      }

      // pruneDatabaseFile truncates the WAL so stale frames cannot keep the old text, even while the
      // seeded store (standing in for the running service) keeps its own connection open.
      pruneDatabaseFile(path, { policy, now: nowAt });
      const walFile = Bun.file(`${path}-wal`);
      expect((await walFile.exists()) ? walFile.size : 0).toBe(0);
      const after = await onDisk();
      for (const marker of pruned) expect(after.includes(marker)).toBe(false);
      expect(after.includes("old pending request")).toBe(true);
      expect(after.includes("recent request")).toBe(true);
    });
  });

  test("leaves every table untouched when retention is not configured", async () => {
    await withSeededStore(({ path }) => {
      const before = readRows(path);
      expect(pruneDatabaseFile(path, { policy: {}, now: nowAt })).toMatchObject({
        cutoffs: { audit: null, outbox: null, message: null },
        auditDeleted: 0,
        eventsRedacted: 0,
      });
      expect(readRows(path)).toEqual(before);
    });
  });

  test("the maintenance worker prunes at most once per interval", async () => {
    await withSeededStore(async ({ path }) => {
      let clock = Date.parse(nowAt);
      const worker = createRetentionWorker({
        databasePath: path,
        policy: { messageDays: 30 },
        now: () => new Date(clock),
        intervalMs: 60_000,
      });
      expect(await worker.processNext()).toEqual({ kind: "retention-pruned" });
      expect(await worker.processNext()).toEqual({ kind: "idle" });
      clock += 61_000;
      expect(await worker.processNext()).toEqual({ kind: "idle" });

      const disabled = createRetentionWorker({ databasePath: "relative.sqlite", policy: {}, now: () => new Date(clock) });
      expect(await disabled.processNext()).toEqual({ kind: "idle" });
    });
  });

  test("config accepts optional retention days and rejects unknown or invalid fields", () => {
    const parse = (retention: unknown) => agentTagConfigSchema.in.shape.retention.safeParse(retention);
    expect(agentTagConfigSchema.in.shape.retention.parse(undefined)).toEqual({});
    expect(parse({ auditDays: 365, messageDays: 30 }).success).toBe(true);
    expect(parse({ auditDays: 0 }).success).toBe(false);
    expect(parse({ auditDays: 1.5 }).success).toBe(false);
    expect(parse({ forever: true }).success).toBe(false);
  });
});
