// Thread context notes: updates in a bound thread that are context, never requests (bot messages,
// non-allowlisted humans, edits). Each is shown once, on the next human turn of its task, and is
// consumed when that turn's text is frozen (see resolveOperationTurnText).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { isoDateTime, nonEmpty } from "./schema.ts";
import type { ThreadNote } from "./types.ts";

/** Pending notes per task; a new note past this drops the oldest pending one. */
export const MAX_PENDING_THREAD_NOTES = 50;
/** Code points kept of a note's text (and of an edit's previous text). */
export const MAX_THREAD_NOTE_CHARS = 4_000;

export interface RecordThreadNoteInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  /** `C:ts` for messages, `C:ts:edit:<edited.ts>` for edits: the idempotency key. */
  readonly sourceEventKey: string;
  readonly sourceDeliveryId: string;
  readonly kind: "message" | "edit";
  readonly speakerKind: "human" | "bot";
  readonly speakerId: string;
  readonly speakerLabel: string | null;
  readonly steeringAllowed: boolean;
  readonly messageTs: string;
  readonly text: string;
  readonly previousText: string | null;
  /** Ordering key: the message ts, or `edited.ts` for edits. */
  readonly sourceOrderKey: string;
  readonly now: string;
}

/** Null when the thread has no active task (the binding closed since the router looked). */
export type RecordThreadNoteResult = { readonly noteId: string; readonly duplicate: boolean } | null;

function capCodePoints(text: string): string {
  const codePoints = Array.from(text);
  return codePoints.length <= MAX_THREAD_NOTE_CHARS
    ? text
    : codePoints.slice(0, MAX_THREAD_NOTE_CHARS - 1).join("") + "…";
}

export function recordThreadNote(database: Database, input: RecordThreadNoteInput): RecordThreadNoteResult {
  const now = isoDateTime.parse(input.now);
  const workspaceId = requiredId(input.workspaceId, "workspaceId");
  const sourceEventKey = requiredId(input.sourceEventKey, "sourceEventKey");
  const record = database.transaction((): RecordThreadNoteResult => {
    const existing = z.object({ note_id: nonEmpty }).nullable().parse(
      database
        .query("SELECT note_id FROM thread_context_notes WHERE workspace_id = ? AND source_event_key = ?")
        .get(workspaceId, sourceEventKey),
    );
    if (existing !== null) return { noteId: existing.note_id, duplicate: true };
    const task = z.object({ task_id: nonEmpty }).nullable().parse(
      database
        .query(
          `SELECT task_id FROM tasks
           WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ? AND state = 'active'`,
        )
        .get(
          workspaceId,
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
        ),
    );
    if (task === null) return null;
    const pending = database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM thread_context_notes WHERE task_id = ? AND consumed_by_operation_id IS NULL",
      )
      .get(task.task_id)?.count ?? 0;
    if (pending >= MAX_PENDING_THREAD_NOTES) {
      // A spammy bot cannot grow a task's notes without bound: the oldest pending note goes.
      const oldest = database
        .query<{ note_id: string }, [string, number]>(
          `SELECT note_id FROM thread_context_notes WHERE task_id = ? AND consumed_by_operation_id IS NULL
           ORDER BY source_order_key, note_id LIMIT ?`,
        )
        .all(task.task_id, pending - MAX_PENDING_THREAD_NOTES + 1);
      for (const row of oldest) {
        database.query("DELETE FROM thread_context_notes WHERE note_id = ?").run(row.note_id);
        writeAudit(database, {
          actorType: "system",
          actorId: "thread-notes",
          authority: "thread-context",
          source: row.note_id,
          target: task.task_id,
          action: "thread-note.dropped",
          result: "pending-cap",
          correlationId: task.task_id,
          metadata: { pendingCap: MAX_PENDING_THREAD_NOTES },
          createdAt: now,
        });
      }
    }
    const noteId = randomUUID();
    database
      .query(
        `INSERT INTO thread_context_notes (
          note_id, task_id, workspace_id, conversation_id, thread_ts, source_event_key, source_delivery_id,
          kind, speaker_kind, speaker_id, speaker_label, steering_allowed, message_ts, text, previous_text,
          source_order_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        noteId,
        task.task_id,
        workspaceId,
        input.conversationId,
        input.threadTs,
        sourceEventKey,
        requiredId(input.sourceDeliveryId, "sourceDeliveryId"),
        input.kind,
        input.speakerKind,
        requiredId(input.speakerId, "speakerId"),
        input.speakerLabel,
        input.steeringAllowed ? 1 : 0,
        requiredId(input.messageTs, "messageTs"),
        capCodePoints(input.text),
        input.previousText === null ? null : capCodePoints(input.previousText),
        requiredId(input.sourceOrderKey, "sourceOrderKey"),
        now,
      );
    writeAudit(database, {
      actorType: input.speakerKind === "bot" ? "slack-bot" : "slack-user",
      actorId: input.speakerId,
      authority: "thread-context",
      source: sourceEventKey,
      target: task.task_id,
      action: "thread-note.recorded",
      result: "pending",
      correlationId: task.task_id,
      metadata: { kind: input.kind, speakerKind: input.speakerKind },
      createdAt: now,
    });
    return { noteId, duplicate: false };
  });
  return record.immediate();
}

const noteRowSchema = z.object({
  note_id: nonEmpty,
  kind: z.enum(["message", "edit"]),
  speaker_kind: z.enum(["human", "bot"]),
  speaker_id: nonEmpty,
  speaker_label: z.string().nullable(),
  steering_allowed: z.union([z.literal(0), z.literal(1)]),
  message_ts: nonEmpty,
  text: z.string(),
  previous_text: z.string().nullable(),
});

/** A task's unconsumed notes, oldest first. */
export function listPendingThreadNotes(
  database: Database,
  taskId: string,
  limit = MAX_PENDING_THREAD_NOTES,
): ThreadNote[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
  return z.array(noteRowSchema).parse(
    database
      .query(
        `SELECT note_id, kind, speaker_kind, speaker_id, speaker_label, steering_allowed, message_ts, text,
                previous_text
         FROM thread_context_notes WHERE task_id = ? AND consumed_by_operation_id IS NULL
         ORDER BY source_order_key, note_id LIMIT ?`,
      )
      .all(requiredId(taskId, "taskId"), limit),
  ).map((row) => ({
    noteId: row.note_id,
    kind: row.kind,
    speakerKind: row.speaker_kind,
    speakerId: row.speaker_id,
    speakerLabel: row.speaker_label,
    steeringAllowed: row.steering_allowed === 1,
    messageTs: row.message_ts,
    text: row.text,
    previousText: row.previous_text,
  }));
}

/** The text an ingested Slack message was stored with (bot mention stripped), or null. */
export function findIngestedText(database: Database, workspaceId: string, eventKey: string): string | null {
  const row = z.object({ text: z.string() }).nullable().parse(
    database
      .query("SELECT text FROM slack_events WHERE workspace_id = ? AND event_key = ?")
      .get(requiredId(workspaceId, "workspaceId"), requiredId(eventKey, "eventKey")),
  );
  return row?.text ?? null;
}

/**
 * Marks notes consumed by an operation. Runs inside the caller's transaction (the one that freezes
 * the turn text). Notes already consumed or on another task are left alone; returns the count marked.
 */
export function consumeThreadNotes(
  database: Database,
  input: { readonly operationId: string; readonly taskId: string; readonly noteIds: readonly string[]; readonly now: string },
): number {
  let consumed = 0;
  for (const noteId of new Set(input.noteIds)) {
    consumed += database
      .query(
        `UPDATE thread_context_notes SET consumed_by_operation_id = ?, consumed_at = ?
         WHERE note_id = ? AND task_id = ? AND consumed_by_operation_id IS NULL`,
      )
      .run(input.operationId, input.now, noteId, input.taskId).changes;
  }
  return consumed;
}
