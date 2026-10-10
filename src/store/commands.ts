// `@bot !command` ledger (slack_command_events), per-thread mute (slack_thread_controls) and the
// read-only work summaries behind `!status`. The ledger never stores message text.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { AGENT_COMMANDS } from "../commands/parse.ts";
import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { isoDateTime, nonEmpty, outboxPayloadSchema } from "./schema.ts";
import type { SlackOutboxPayload } from "./types.ts";

/**
 * Ledger kinds. The column has no CHECK (the table is shared with PR-K2's memory commands), so this
 * list is the validation: later lanes append their kinds here.
 */
export const SLACK_COMMAND_KINDS = [...AGENT_COMMANDS] as const;
export const slackCommandKindSchema = z.enum(SLACK_COMMAND_KINDS);
export type SlackCommandKind = z.infer<typeof slackCommandKindSchema>;
export const COMMAND_OUTCOMES = ["started", "succeeded", "denied", "rejected", "failed"] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];
/** Stable reason codes, never free text. */
const commandReasonSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export interface BeginCommandInput {
  readonly workspaceId: string;
  readonly eventKey: string;
  readonly deliveryId: string;
  readonly conversationId: string;
  /** null = top level. */
  readonly threadTs: string | null;
  readonly actorUserId: string;
  readonly commandKind: SlackCommandKind;
  readonly taskId: string | null;
  readonly now: string;
}

/**
 * Claims the event for command execution. `duplicate` when the event key was already claimed (the
 * `app_mention`/`message` pair for one `ts`, or a Socket Mode redelivery) or already ingested as a
 * prompt; the caller then sends nothing.
 */
export function beginCommand(database: Database, input: BeginCommandInput): "accepted" | "duplicate" {
  const now = isoDateTime.parse(input.now);
  const workspaceId = requiredId(input.workspaceId, "workspaceId");
  const eventKey = requiredId(input.eventKey, "eventKey");
  const begin = database.transaction((): "accepted" | "duplicate" => {
    const ingested = database
      .query("SELECT 1 FROM slack_events WHERE workspace_id = ? AND event_key = ?")
      .get(workspaceId, eventKey);
    if (ingested !== null) return "duplicate";
    const result = database
      .query(
        `INSERT INTO slack_command_events (
          workspace_id, event_key, delivery_id, conversation_id, thread_ts, actor_user_id,
          command_kind, task_id, outcome, reason, memory_id, received_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', NULL, NULL, ?, ?)
        ON CONFLICT (workspace_id, event_key) DO NOTHING`,
      )
      .run(
        workspaceId,
        eventKey,
        requiredId(input.deliveryId, "deliveryId"),
        requiredId(input.conversationId, "conversationId"),
        input.threadTs === null ? null : requiredId(input.threadTs, "threadTs"),
        requiredId(input.actorUserId, "actorUserId"),
        slackCommandKindSchema.parse(input.commandKind),
        input.taskId === null ? null : requiredId(input.taskId, "taskId"),
        now,
        now,
      );
    return result.changes === 1 ? "accepted" : "duplicate";
  });
  return begin.immediate();
}

/** Whether the event was claimed as a command, so a redelivery never also becomes a prompt. */
export function isCommandEvent(database: Database, input: { readonly workspaceId: string; readonly eventKey: string }): boolean {
  return (
    database
      .query("SELECT 1 FROM slack_command_events WHERE workspace_id = ? AND event_key = ?")
      .get(requiredId(input.workspaceId, "workspaceId"), requiredId(input.eventKey, "eventKey")) !== null
  );
}

export interface SettleCommandInput {
  readonly workspaceId: string;
  readonly eventKey: string;
  readonly outcome: Exclude<CommandOutcome, "started">;
  readonly reason: string | null;
  /** The profile whose authority the command ran under, for the audit row. */
  readonly profileId: string;
  readonly now: string;
}

/** Settles a started ledger row and writes its audit row. Runs inside the caller's transaction. */
function settleCommandRow(database: Database, input: SettleCommandInput): void {
  const now = isoDateTime.parse(input.now);
  const reason = input.reason === null ? null : commandReasonSchema.parse(input.reason);
  const row = z
    .object({ actor_user_id: nonEmpty, command_kind: slackCommandKindSchema, task_id: nonEmpty.nullable() })
    .nullable()
    .parse(
      database
        .query(
          `SELECT actor_user_id, command_kind, task_id FROM slack_command_events
           WHERE workspace_id = ? AND event_key = ? AND outcome = 'started'`,
        )
        .get(requiredId(input.workspaceId, "workspaceId"), requiredId(input.eventKey, "eventKey")),
    );
  if (row === null) throw new Error("started command not found");
  database
    .query(
      `UPDATE slack_command_events SET outcome = ?, reason = ?, updated_at = ?
       WHERE workspace_id = ? AND event_key = ?`,
    )
    .run(input.outcome, reason, now, input.workspaceId, input.eventKey);
  writeAudit(database, {
    actorType: "slack-user",
    actorId: row.actor_user_id,
    authority: requiredId(input.profileId, "profileId"),
    source: input.eventKey,
    target: row.task_id ?? input.eventKey,
    action: input.outcome === "denied" ? "slack.command.denied" : "slack.command.executed",
    result: input.outcome,
    correlationId: input.eventKey,
    metadata: { command: row.command_kind, ...(reason === null ? {} : { reason }) },
    createdAt: now,
  });
}

export function settleCommand(database: Database, input: SettleCommandInput): void {
  database.transaction(() => settleCommandRow(database, input)).immediate();
}

export interface ThreadKey {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
}

function threadKey(input: ThreadKey): [string, string, string] {
  return [
    requiredId(input.workspaceId, "workspaceId"),
    requiredId(input.conversationId, "conversationId"),
    requiredId(input.threadTs, "threadTs"),
  ];
}

export function isThreadMuted(database: Database, input: ThreadKey): boolean {
  return (
    database
      .query(
        `SELECT 1 FROM slack_thread_controls
         WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ? AND muted_at IS NOT NULL`,
      )
      .get(...threadKey(input)) !== null
  );
}

/** Writes the mute state and its audit row; false when the thread was already in that state. */
function writeThreadMute(
  database: Database,
  input: ThreadKey & {
    readonly muted: boolean;
    readonly actorUserId: string;
    readonly source: "command" | "feedback" | "mention";
    readonly authority: string;
    readonly correlationId: string;
    readonly now: string;
  },
): boolean {
  const key = threadKey(input);
  if (isThreadMuted(database, input) === input.muted) return false;
  const actor = requiredId(input.actorUserId, "actorUserId");
  if (input.muted) {
    const source = input.source === "mention" ? "command" : input.source;
    database
      .query(
        `INSERT INTO slack_thread_controls (
          workspace_id, conversation_id, thread_ts, muted_at, muted_by, mute_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, conversation_id, thread_ts) DO UPDATE SET
          muted_at = excluded.muted_at, muted_by = excluded.muted_by,
          mute_source = excluded.mute_source, updated_at = excluded.updated_at`,
      )
      .run(...key, input.now, actor, source, input.now);
  } else {
    database
      .query(
        `UPDATE slack_thread_controls SET muted_at = NULL, muted_by = NULL, mute_source = NULL, updated_at = ?
         WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ?`,
      )
      .run(input.now, ...key);
  }
  writeAudit(database, {
    actorType: "slack-user",
    actorId: actor,
    authority: input.authority,
    source: input.correlationId,
    target: `${key[1]}:${key[2]}`,
    action: input.muted ? "thread.muted" : "thread.unmuted",
    result: input.muted ? "muted" : "unmuted",
    correlationId: input.correlationId,
    metadata: { reason: input.source },
    createdAt: input.now,
  });
  return true;
}

export interface CommandOutboxInput {
  readonly taskId: string;
  readonly clientMessageId: string;
  readonly payload: SlackOutboxPayload;
}

export interface SetThreadMuteInput extends ThreadKey {
  readonly muted: boolean;
  readonly actorUserId: string;
  readonly source: "command" | "feedback";
  /** The `!mute`/`!unmute` ledger row settled in the same transaction. */
  readonly command: { readonly eventKey: string; readonly profileId: string };
  /** Public notice, enqueued only when the state changed. */
  readonly outbox?: CommandOutboxInput;
  readonly now: string;
}

/**
 * `!mute`/`!unmute`: state, audit, outbox notice and ledger settle in one IMMEDIATE transaction, so
 * they cannot diverge. "unchanged" settles the command as rejected (already-muted / not-muted).
 */
export function setThreadMute(database: Database, input: SetThreadMuteInput): "changed" | "unchanged" {
  const now = isoDateTime.parse(input.now);
  const apply = database.transaction((): "changed" | "unchanged" => {
    const changed = writeThreadMute(database, {
      ...input,
      authority: input.command.profileId,
      correlationId: input.command.eventKey,
      now,
    });
    if (changed && input.outbox !== undefined) {
      const outboxId = crypto.randomUUID();
      insertOutboxMessage(database, {
        outboxId,
        taskId: requiredId(input.outbox.taskId, "taskId"),
        correlationId: input.command.eventKey,
        conversationId: input.conversationId,
        threadTs: input.threadTs,
        clientMessageId: requiredId(input.outbox.clientMessageId, "clientMessageId"),
        payload: outboxPayloadSchema.parse(input.outbox.payload),
        createdAt: now,
      });
      writeAudit(database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "slack-write",
        source: input.command.eventKey,
        target: outboxId,
        action: "slack.outbox.enqueued",
        result: "pending",
        correlationId: input.command.eventKey,
        metadata: { clientMessageId: input.outbox.clientMessageId },
        createdAt: now,
      });
    }
    settleCommandRow(database, {
      workspaceId: input.workspaceId,
      eventKey: input.command.eventKey,
      outcome: changed ? "succeeded" : "rejected",
      reason: changed ? null : input.muted ? "already-muted" : "not-muted",
      profileId: input.command.profileId,
      now,
    });
    return changed ? "changed" : "unchanged";
  });
  return apply.immediate();
}

/**
 * A direct mention in a muted thread unmutes it (Claude Tag rule). Called inside the ingest
 * transaction on the accepted path only, so a redelivered mention cannot flip it twice.
 */
export function unmuteThreadForMention(
  database: Database,
  input: ThreadKey & { readonly actorUserId: string; readonly profileId: string; readonly eventKey: string; readonly now: string },
): boolean {
  return writeThreadMute(database, {
    ...input,
    muted: false,
    source: "mention",
    authority: input.profileId,
    correlationId: input.eventKey,
  });
}

export interface ThreadWorkStatus {
  readonly muted: boolean;
  /** Earliest start of a turn that is running or holding the thread. */
  readonly workingSince: string | null;
  /** Earliest open approval or question. */
  readonly waitingSince: string | null;
  /** Requests not started yet. */
  readonly queued: number;
}

const OPEN_INTERACTIONS_SQL = `
  SELECT MIN(i.created_at) FROM interactions i
  JOIN operations o ON o.operation_id = i.operation_id
  WHERE o.task_id = t.task_id AND o.status IN ('pending', 'inflight')
    AND i.kind IN ('approval', 'user-input') AND i.state = 'pending'`;
const WORKING_SQL = `
  SELECT MIN(COALESCE(o.t3_turn_started_at, o.t3_turn_dispatched_at, o.updated_at)) FROM operations o
  WHERE o.task_id = t.task_id AND (o.status = 'inflight' OR (o.status = 'pending' AND o.t3_turn_started_at IS NOT NULL))`;
const QUEUED_SQL = `
  SELECT COUNT(*) FROM operations o
  WHERE o.task_id = t.task_id AND o.status = 'pending' AND o.t3_turn_started_at IS NULL`;

const taskWorkRowSchema = z.object({
  working_since: isoDateTime.nullable(),
  waiting_since: isoDateTime.nullable(),
  queued: z.number().int().nonnegative(),
});

/** Store-only, so it answers while T3 is down. Never reads message text. */
export function getThreadStatus(database: Database, input: ThreadKey & { readonly taskId: string }): ThreadWorkStatus {
  const row = taskWorkRowSchema.nullable().parse(
    database
      .query(
        `SELECT (${WORKING_SQL}) AS working_since, (${OPEN_INTERACTIONS_SQL}) AS waiting_since, (${QUEUED_SQL}) AS queued
         FROM tasks t WHERE t.task_id = ?`,
      )
      .get(requiredId(input.taskId, "taskId")),
  );
  if (row === null) throw new Error("task not found");
  return {
    muted: isThreadMuted(database, input),
    workingSince: row.working_since,
    waitingSince: row.waiting_since,
    queued: row.queued,
  };
}

export interface ConversationWorkStatus {
  /** Threads with a running turn and nothing waiting on people. */
  readonly working: number;
  /** Threads waiting on an approval or question. */
  readonly waiting: number;
  /** Requests not started yet, across threads. */
  readonly queued: number;
}

export function getConversationStatus(
  database: Database,
  input: { readonly workspaceId: string; readonly conversationId: string },
): ConversationWorkStatus {
  const rows = z.array(taskWorkRowSchema).parse(
    database
      .query(
        `SELECT (${WORKING_SQL}) AS working_since, (${OPEN_INTERACTIONS_SQL}) AS waiting_since, (${QUEUED_SQL}) AS queued
         FROM tasks t WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.state = 'active'`,
      )
      .all(requiredId(input.workspaceId, "workspaceId"), requiredId(input.conversationId, "conversationId")),
  );
  let working = 0;
  let waiting = 0;
  let queued = 0;
  for (const row of rows) {
    if (row.waiting_since !== null) waiting += 1;
    else if (row.working_since !== null) working += 1;
    queued += row.queued;
  }
  return { working, waiting, queued };
}
