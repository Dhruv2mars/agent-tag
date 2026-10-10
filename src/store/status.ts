// Live status messages (PR-F3): one Slack message per turn that says what the agent is doing and
// carries the Stop button while the turn runs. It is posted once as `${operationId}:status` and then
// edited in place through outbox refresh rows (refresh_kind 'status-message'), which render this
// table's current row at delivery time (see message-edits.ts), so an edit never shows an older state
// than the store. Terminal states are sticky and render without the Stop button; every operation
// settle path calls settleStatusMessage in its own transaction.
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { parseStoredJson, requiredId } from "./context.ts";
import { enqueueMessageRefresh } from "./message-edits.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { isoDateTime, nonEmpty, outboxIdentitySchema, outboxPayloadSchema } from "./schema.ts";
import type { SlackOutboxPayload } from "./types.ts";

export const STATUS_STATES = ["running", "waiting", "stopping", "done", "stopped", "failed", "expired"] as const;
export type StatusState = (typeof STATUS_STATES)[number];
const LIVE_STATES: ReadonlySet<StatusState> = new Set(["running", "waiting", "stopping"]);

export function isTerminalStatus(state: StatusState): boolean {
  return !LIVE_STATES.has(state);
}

const planStepSchema = z.object({
  step: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type StatusPlanStep = z.infer<typeof planStepSchema>;

const progressSchema = z.object({
  plan: z.array(planStepSchema).default([]),
  recent: z.array(z.string()).default([]),
  toolCount: z.number().int().nonnegative().default(0),
});
/** What the status message shows besides its headline (see src/progress.ts). */
export type StatusProgress = z.infer<typeof progressSchema>;

export interface StatusMessageView {
  readonly operationId: string;
  readonly taskId: string;
  readonly state: StatusState;
  readonly progress: StatusProgress;
  /** Who pressed Stop, once known. */
  readonly actorUserId: string | null;
  readonly startedAt: string;
  readonly settledAt: string | null;
}

/** The `client_message_id` of an operation's status post. */
export function statusPostId(operationId: string): string {
  return `${operationId}:status`;
}

/** Interaction-expiry failures render as "expired" (see waits.ts). */
const EXPIRED_ERROR_CODE = "InteractionExpired";
const USER_CANCELLED = "user-cancelled";
const BUCKET_WINDOW_MS = 60_000;

const viewRowSchema = z.object({
  operation_id: nonEmpty,
  task_id: nonEmpty,
  state: z.enum(STATUS_STATES),
  view_json: nonEmpty,
  actor_user_id: nonEmpty.nullable(),
  started_at: isoDateTime,
  settled_at: isoDateTime.nullable(),
});

function toView(row: z.infer<typeof viewRowSchema>): StatusMessageView {
  const progress = progressSchema.safeParse(parseStoredJson(row.view_json));
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    state: row.state,
    progress: progress.success ? progress.data : { plan: [], recent: [], toolCount: 0 },
    actorUserId: row.actor_user_id,
    startedAt: row.started_at,
    settledAt: row.settled_at,
  };
}

export function getStatusMessageView(database: Database, operationId: string): StatusMessageView | null {
  const row = viewRowSchema.nullable().parse(
    database
      .query(
        `SELECT operation_id, task_id, state, view_json, actor_user_id, started_at, settled_at
         FROM status_messages WHERE operation_id = ?`,
      )
      .get(requiredId(operationId, "operationId")),
  );
  return row === null ? null : toView(row);
}

/** Queues an edit of the status post; null `notBefore` sends it as soon as the post is settled. */
function refresh(database: Database, operationId: string, now: string, notBefore: string | null): boolean {
  const result = enqueueMessageRefresh(database, {
    targetClientMessageId: statusPostId(operationId),
    refreshKind: "status-message",
    refreshKey: operationId,
    now,
    ...(notBefore === null ? {} : { notBefore }),
  });
  return result !== null && !result.reused;
}

function audit(database: Database, operationId: string, action: "status.opened" | "status.terminal", result: string, now: string, actorId?: string): void {
  writeAudit(database, {
    actorType: actorId === undefined ? "service" : "slack-user",
    actorId: actorId ?? "agent-tag",
    authority: "slack-write",
    source: operationId,
    target: statusPostId(operationId),
    action,
    result,
    correlationId: operationId,
    metadata: {},
    createdAt: now,
  });
}

export interface OpenStatusMessageInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  /** Renders the first post from the new row. */
  readonly message: (view: StatusMessageView) => SlackOutboxPayload;
  /** The first progress edit is not sent sooner than this after the post. */
  readonly intervalMs: number;
  readonly now: string;
}

export type OpenStatusMessageResult = { readonly kind: "opened" | "reattached" };

/**
 * Posts the operation's status message, once. A claim that resumes the operation (after a release,
 * a retry or a human wait) re-attaches to the same row instead, and a wait turns back into running.
 * Status messages of the task's earlier operations that settled without one (a crash between
 * settle hooks cannot happen, but rows from before an upgrade can) are made terminal first, so a
 * thread never shows two live Stop buttons.
 */
export function openStatusMessage(database: Database, input: OpenStatusMessageInput): OpenStatusMessageResult {
  const now = isoDateTime.parse(input.now);
  const operationId = requiredId(input.operationId, "operationId");
  const taskId = requiredId(input.taskId, "taskId");
  const open = database.transaction((): OpenStatusMessageResult => {
    const existing = getStatusMessageView(database, operationId);
    if (existing !== null) {
      if (existing.state === "waiting") {
        database
          .query("UPDATE status_messages SET state = 'running', updated_at = ? WHERE operation_id = ? AND state = 'waiting'")
          .run(now, operationId);
        refresh(database, operationId, now, null);
      }
      return { kind: "reattached" };
    }
    const earlier = z.array(z.object({ operation_id: nonEmpty })).parse(
      database
        .query(
          `SELECT operation_id FROM status_messages
           WHERE task_id = ? AND operation_id <> ? AND state IN ('running', 'waiting', 'stopping')`,
        )
        .all(taskId, operationId),
    );
    for (const row of earlier) settleStatusMessage(database, { operationId: row.operation_id, now });

    database
      .query(
        `INSERT INTO status_messages (
          operation_id, task_id, state, view_json, started_at, next_refresh_at, created_at, updated_at
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        taskId,
        JSON.stringify({ plan: [], recent: [], toolCount: 0 }),
        now,
        new Date(Date.parse(now) + input.intervalMs).toISOString(),
        now,
        now,
      );
    const view = getStatusMessageView(database, operationId);
    if (view === null) throw new Error("status message was not stored");
    const clientMessageId = statusPostId(operationId);
    const prior = outboxIdentitySchema.nullable().parse(
      database.query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?").get(clientMessageId),
    );
    if (prior === null) {
      insertOutboxMessage(database, {
        outboxId: crypto.randomUUID(),
        taskId,
        correlationId: operationId,
        conversationId: requiredId(input.conversationId, "conversationId"),
        threadTs: requiredId(input.threadTs, "threadTs"),
        clientMessageId,
        payload: outboxPayloadSchema.parse(input.message(view)),
        createdAt: now,
      });
    }
    audit(database, operationId, "status.opened", "running", now);
    return { kind: "opened" };
  });
  return open.immediate();
}

export interface UpdateStatusProgressInput {
  readonly operationId: string;
  readonly progress: StatusProgress;
  /** Least time between two edits of one status message. */
  readonly intervalMs: number;
  /** Budget for status edits across all messages, per minute. */
  readonly perMinute: number;
  readonly now: string;
}

/**
 * Stores the turn's latest progress and queues one throttled edit. Coalescing: while an edit is
 * pending, later progress only rewrites the row it renders from, so a burst of activity costs one
 * chat.update. Returns false when nothing changed or the message is terminal.
 */
export function updateStatusProgress(database: Database, input: UpdateStatusProgressInput): boolean {
  const now = isoDateTime.parse(input.now);
  const operationId = requiredId(input.operationId, "operationId");
  const viewJson = JSON.stringify(progressSchema.parse(input.progress));
  const update = database.transaction((): boolean => {
    const row = z
      .object({ state: z.enum(STATUS_STATES), view_json: nonEmpty, next_refresh_at: isoDateTime.nullable() })
      .nullable()
      .parse(
        database
          .query("SELECT state, view_json, next_refresh_at FROM status_messages WHERE operation_id = ?")
          .get(operationId),
      );
    if (row === null || isTerminalStatus(row.state) || row.view_json === viewJson) return false;
    const notBefore = new Date(
      Math.max(
        Date.parse(now),
        row.next_refresh_at === null ? 0 : Date.parse(row.next_refresh_at),
        budgetSlot(database, now, input.perMinute),
      ),
    ).toISOString();
    database
      .query("UPDATE status_messages SET view_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(viewJson, now, operationId);
    if (refresh(database, operationId, now, notBefore)) {
      database
        .query("UPDATE status_messages SET next_refresh_at = ? WHERE operation_id = ?")
        .run(new Date(Date.parse(notBefore) + input.intervalMs).toISOString(), operationId);
    }
    return true;
  });
  return update.immediate();
}

/**
 * Earliest send time the global edit budget allows: status edits queued or sent in the last minute
 * beyond `perMinute` push new ones back, spread evenly. Terminal edits are counted but not delayed:
 * there is at most one per turn, and Slack's Retry-After still pauses every row.
 */
function budgetSlot(database: Database, now: string, perMinute: number): number {
  const nowMs = Date.parse(now);
  const since = new Date(nowMs - BUCKET_WINDOW_MS).toISOString();
  const row = z.object({ count: z.number().int() }).parse(
    database
      .query(
        `SELECT COUNT(*) AS count FROM slack_outbox
         WHERE refresh_kind = 'status-message' AND updated_at > ?`,
      )
      .get(since),
  );
  if (row.count < perMinute) return nowMs;
  return nowMs + Math.ceil(((row.count - perMinute + 1) * BUCKET_WINDOW_MS) / perMinute);
}

/** Running → waiting while the turn waits for an approval or answer (the card has the buttons). */
export function markStatusWaiting(database: Database, input: { readonly operationId: string; readonly now: string }): void {
  const now = isoDateTime.parse(input.now);
  const changed = database
    .query("UPDATE status_messages SET state = 'waiting', updated_at = ? WHERE operation_id = ? AND state = 'running'")
    .run(now, requiredId(input.operationId, "operationId"));
  if (changed.changes === 1) refresh(database, input.operationId, now, null);
}

/** Stop was accepted and the interrupt is on its way to T3: "Stopping…" without the button. */
export function markStatusStopping(
  database: Database,
  input: { readonly operationId: string; readonly actorUserId: string; readonly now: string },
): void {
  const now = isoDateTime.parse(input.now);
  const changed = database
    .query(
      `UPDATE status_messages SET state = 'stopping', actor_user_id = ?, updated_at = ?
       WHERE operation_id = ? AND state IN ('running', 'waiting')`,
    )
    .run(requiredId(input.actorUserId, "actorUserId"), now, requiredId(input.operationId, "operationId"));
  if (changed.changes === 1) refresh(database, input.operationId, now, null);
}

/** The Slack user whose Stop (cancel interaction) ended the operation, if any. */
export function cancellingActor(database: Database, operationId: string): string | null {
  const row = z.object({ response_actor_id: nonEmpty.nullable() }).nullable().parse(
    database
      .query(
        `SELECT response_actor_id FROM interactions
         WHERE operation_id = ? AND kind = 'cancel' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(operationId),
  );
  return row?.response_actor_id ?? null;
}

/**
 * Makes a live status message terminal to match its settled operation: done, stopped (by whom),
 * expired or failed. Call inside the transaction that settles the operation. No-op when there is
 * no status message, it is already terminal, or the operation has not settled.
 */
export function settleStatusMessage(database: Database, input: { readonly operationId: string; readonly now: string }): void {
  const now = isoDateTime.parse(input.now);
  const operationId = requiredId(input.operationId, "operationId");
  const row = z
    .object({
      state: z.enum(STATUS_STATES),
      actor_user_id: nonEmpty.nullable(),
      status: nonEmpty,
      last_error_code: z.string().nullable(),
    })
    .nullable()
    .parse(
      database
        .query(
          `SELECT s.state, s.actor_user_id, o.status, o.last_error_code
           FROM status_messages s JOIN operations o ON o.operation_id = s.operation_id
           WHERE s.operation_id = ?`,
        )
        .get(operationId),
    );
  if (row === null || isTerminalStatus(row.state)) return;
  let state: StatusState;
  if (row.status === "succeeded") state = "done";
  else if (row.status !== "failed") return;
  else if (row.last_error_code === USER_CANCELLED) state = "stopped";
  else if (row.last_error_code === EXPIRED_ERROR_CODE) state = "expired";
  else state = "failed";
  const actor = state === "stopped" ? row.actor_user_id ?? cancellingActor(database, operationId) : row.actor_user_id;
  database
    .query(
      `UPDATE status_messages SET state = ?, actor_user_id = ?, settled_at = ?, updated_at = ?
       WHERE operation_id = ? AND state IN ('running', 'waiting', 'stopping')`,
    )
    .run(state, actor, now, now, operationId);
  refresh(database, operationId, now, null);
  audit(database, operationId, "status.terminal", state, now);
}

/** Whether the operation's status post can still be edited (queued, sending or sent). */
export function hasLiveStatusPost(database: Database, operationId: string): string | null {
  const row = z.object({ outbox_id: nonEmpty, status: nonEmpty }).nullable().parse(
    database
      .query("SELECT outbox_id, status FROM slack_outbox WHERE client_message_id = ?")
      .get(statusPostId(operationId)),
  );
  return row === null || row.status === "failed" ? null : row.outbox_id;
}
