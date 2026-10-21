// `!stop` and `!restart` (PR-H2). Stop reuses the Stop button's cancellation (requestTaskCancellation),
// so both read "Stopped by <@U>." on the status message. Restart rotates the task to a fresh T3 thread
// (the next session generation, on branch `taskBranchName(id, generation)`) and records the old one
// in N1's task_retired_t3_threads. While a turn still holds the old session, `restart_requested_at`
// gates the task's queue (claimNextOperation) until the restart worker rotates it.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { settleCommandRow } from "./commands.ts";
import { requiredId } from "./context.ts";
import { closeOperationInteractions, OPERATION_SETTLED, requestTaskCancellation } from "./interactions.ts";
import { retirableTaskSchema, retireCurrentThread } from "./lifecycle.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { isoDateTime, nonEmpty, outboxPayloadSchema } from "./schema.ts";
import { settleStatusMessage } from "./status.ts";
import type { SlackOutboxPayload } from "./types.ts";

/** Error code of an operation the restart ended: its T3 thread was retired under it. */
export const SESSION_RESTARTED = "session-restarted";
const USER_CANCELLED = "user-cancelled";

/** Holds the old session: running, or sent to T3 and released (only a claim could confirm it). */
const HOLDS_SESSION_SQL = `(o.status = 'inflight' OR (o.status = 'pending' AND
  (o.t3_turn_started_at IS NOT NULL OR o.t3_turn_dispatched_at IS NOT NULL)))`;

export interface StopTaskInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  /** The `!command` event key: the cancellation's source action, so a redelivery is a duplicate. */
  readonly commandKey: string;
  /** The command message's ts. Requests queued before it are dropped; later ones are new requests. */
  readonly commandOrderKey: string;
  readonly now: string;
}

export type StopTaskResult =
  /** A turn holds the session; its interrupt is queued (the status message shows "Stopping"). */
  | { readonly kind: "interrupting"; readonly dropped: number }
  | { readonly kind: "dropped-only"; readonly dropped: number }
  | { readonly kind: "nothing"; readonly dropped: 0 };

/**
 * Stops the task's work, inside the caller's transaction: requests queued before the command and
 * never sent to T3 fail as `user-cancelled`, and a turn holding the session is interrupted through
 * the Stop button's path. Writes the `task.stop.requested` audit row; posts nothing itself.
 */
export function stopTask(database: Database, input: StopTaskInput): StopTaskResult {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  const actorUserId = requiredId(input.actorUserId, "actorUserId");
  const queued = z.array(z.object({ operation_id: nonEmpty })).parse(
    database
      .query(
        `SELECT operation_id FROM operations
         WHERE task_id = ? AND status = 'pending' AND t3_turn_started_at IS NULL AND t3_turn_dispatched_at IS NULL
           AND source_order_key < ?
         ORDER BY source_order_key, operation_id`,
      )
      .all(taskId, requiredId(input.commandOrderKey, "commandOrderKey")),
  );
  for (const { operation_id: operationId } of queued) {
    const cancelled = database
      .query(
        `UPDATE operations SET status = 'failed', last_error_code = ?, blocked_until = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'pending' AND t3_turn_started_at IS NULL AND t3_turn_dispatched_at IS NULL`,
      )
      .run(USER_CANCELLED, now, operationId);
    if (cancelled.changes !== 1) throw new Error("queued operation changed during stop");
    closeOperationInteractions(database, { operationId, errorCode: OPERATION_SETTLED, now });
    settleStatusMessage(database, { operationId, now });
    writeAudit(database, {
      actorType: "slack-user",
      actorId: actorUserId,
      authority: "task-cancel",
      source: input.commandKey,
      target: operationId,
      action: "operation.cancelled",
      result: "failed",
      correlationId: operationId,
      metadata: { errorCode: USER_CANCELLED, turnStarted: false },
      createdAt: now,
    });
  }
  const holding = database
    .query(`SELECT 1 FROM operations o WHERE o.task_id = ? AND ${HOLDS_SESSION_SQL} LIMIT 1`)
    .get(taskId);
  let interrupting = false;
  if (holding !== null) {
    // The Stop button's path: the interrupt goes to T3 through the interaction worker, and the
    // coordinator settles the turn as "Stopped by <@U>." Never-sent requests were dropped above,
    // so it targets the turn holding the session.
    const cancellation = requestTaskCancellation(database, {
      taskId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      threadTs: input.threadTs,
      actorUserId,
      sourceActionId: `command:${requiredId(input.commandKey, "commandKey")}`,
      now,
    });
    interrupting = cancellation.kind !== "denied";
  }
  const dropped = queued.length;
  const result: StopTaskResult = interrupting
    ? { kind: "interrupting", dropped }
    : dropped > 0
      ? { kind: "dropped-only", dropped }
      : { kind: "nothing", dropped: 0 };
  if (result.kind !== "nothing") {
    writeAudit(database, {
      actorType: "slack-user",
      actorId: actorUserId,
      authority: "task-cancel",
      source: input.commandKey,
      target: taskId,
      action: "task.stop.requested",
      result: result.kind,
      correlationId: input.commandKey,
      metadata: { command: "stop", dropped },
      createdAt: now,
    });
  }
  return result;
}

export interface CommandOutbox {
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: SlackOutboxPayload;
}

/** Queues one public reply for the task, inside the caller's transaction. */
export function enqueueCommandOutbox(
  database: Database,
  input: CommandOutbox & { readonly taskId: string; readonly correlationId: string; readonly now: string },
): void {
  const outboxId = crypto.randomUUID();
  insertOutboxMessage(database, {
    outboxId,
    taskId: input.taskId,
    correlationId: input.correlationId,
    conversationId: input.conversationId,
    threadTs: input.threadTs,
    clientMessageId: requiredId(input.clientMessageId, "clientMessageId"),
    payload: outboxPayloadSchema.parse(input.payload),
    createdAt: input.now,
  });
  writeAudit(database, {
    actorType: "service",
    actorId: "agent-tag",
    authority: "slack-write",
    source: input.correlationId,
    target: outboxId,
    action: "slack.outbox.enqueued",
    result: "pending",
    correlationId: input.correlationId,
    metadata: { clientMessageId: input.clientMessageId },
    createdAt: input.now,
  });
}

export interface RotateTaskSessionInput {
  readonly taskId: string;
  /** Rotated although a turn still holds the old session (the restart timeout passed). */
  readonly forced: boolean;
  readonly actorId: string;
  readonly now: string;
}

/**
 * Moves an active task to its next session generation, inside the caller's transaction: the current
 * T3 thread is retired (for the session stop and N2's cleanup), the task gets a fresh thread id that
 * the next turn bootstraps on its own branch, and the restart request clears. Work still tied to the
 * old thread ends: a turn sent to T3 whose lease lapsed fails (`user-cancelled` when a Stop is
 * pending for it, else `session-restarted`), and approvals or questions left open fail. A turn whose
 * lease is live (a forced rotation) keeps running on the retired thread and may still post its reply.
 */
export function rotateTaskSession(database: Database, input: RotateTaskSessionInput): number {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  const task = retirableTaskSchema.extend({ state: z.enum(["active", "closed"]) }).parse(
    database
      .query(
        `SELECT state, session_generation, t3_project_id, t3_thread_id, t3_thread_started_at, repository_root
         FROM tasks WHERE task_id = ?`,
      )
      .get(taskId),
  );
  if (task.state !== "active") throw new Error("only an active task can restart");
  const generation = task.session_generation;
  retireCurrentThread(database, { taskId, task, reason: "restart", now });
  const next = generation + 1;
  const threadId = `agent-tag-thread-${crypto.randomUUID()}`;
  // Like a reopen (tasks.ts reopenTask): the applied model, the injected memory digest and the PR
  // belonged to the retired thread and branch; the chosen model, schedules, memory and mute stay.
  database
    .query(
      `UPDATE tasks SET session_generation = ?, t3_thread_id = ?, t3_thread_started_at = NULL,
         t3_model_selection_json = NULL, t3_rejected_model_selection_json = NULL, memory_digest = NULL,
         restart_requested_at = NULL, restart_requested_by = NULL, restart_command_key = NULL,
         last_activity_at = ?, updated_at = ?
       WHERE task_id = ? AND state = 'active' AND session_generation = ?`,
    )
    .run(next, threadId, now, now, taskId, generation);
  database.query("DELETE FROM task_pull_requests WHERE task_id = ?").run(taskId);

  const stranded = z.array(z.object({ operation_id: nonEmpty, stopped: z.number().int() })).parse(
    database
      .query(
        `SELECT o.operation_id, EXISTS (SELECT 1 FROM interactions c WHERE c.operation_id = o.operation_id
           AND c.kind = 'cancel') AS stopped
         FROM operations o
         WHERE o.task_id = ? AND ${HOLDS_SESSION_SQL} AND (o.status = 'pending' OR o.lease_expires_at <= ?)`,
      )
      .all(taskId, now),
  );
  for (const row of stranded) {
    database
      .query(
        `UPDATE operations SET status = 'failed', last_error_code = ?, blocked_until = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status IN ('pending', 'inflight')`,
      )
      .run(row.stopped === 1 ? USER_CANCELLED : SESSION_RESTARTED, now, row.operation_id);
    closeOperationInteractions(database, { operationId: row.operation_id, errorCode: SESSION_RESTARTED, now });
    settleStatusMessage(database, { operationId: row.operation_id, now });
  }
  // Approvals and questions a settled turn left for a later turn to adopt: no later turn runs on
  // the retired thread, so they can never be answered.
  const awaiting = z.array(z.object({ operation_id: nonEmpty })).parse(
    database
      .query(
        `SELECT DISTINCT i.operation_id FROM interactions i JOIN operations o ON o.operation_id = i.operation_id
         WHERE i.task_id = ? AND i.kind != 'cancel' AND i.state = 'pending' AND o.status IN ('succeeded', 'failed')`,
      )
      .all(taskId),
  );
  for (const row of awaiting) {
    closeOperationInteractions(database, { operationId: row.operation_id, errorCode: SESSION_RESTARTED, now });
  }
  writeAudit(database, {
    actorType: "service",
    actorId: requiredId(input.actorId, "actorId"),
    authority: "task-lifecycle",
    source: taskId,
    target: threadId,
    action: "task.session.rotated",
    result: input.forced ? "forced" : "rotated",
    correlationId: taskId,
    metadata: { command: "restart", generation: next, dropped: stranded.length },
    createdAt: now,
  });
  return next;
}

export interface RequestTaskRestartInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly commandKey: string;
  readonly commandOrderKey: string;
  /**
   * The confirmation once rotated (`cmd:<key>:ready`), and the notice while the turn stops (`cmd:<key>`),
   * given how many queued requests the restart dropped.
   */
  readonly replies: {
    readonly ready: (dropped: number) => SlackOutboxPayload;
    readonly restarting: (dropped: number) => SlackOutboxPayload;
  };
  readonly now: string;
}

export type RequestTaskRestartResult =
  | { readonly kind: "rotated"; readonly generation: number; readonly dropped: number }
  /** A turn holds the session: it is being stopped and the worker rotates once it ends. */
  | { readonly kind: "pending" }
  | { readonly kind: "already-pending" }
  /** The task closed; its next request starts a fresh session anyway. */
  | { readonly kind: "closed" };

/**
 * `!restart`, inside the caller's transaction. Requests queued before the command are dropped. With
 * no turn holding the session it rotates now and queues the confirmation; otherwise it records the
 * request (gating the queue), interrupts the turn and queues the "Restarting" notice.
 */
export function requestTaskRestart(database: Database, input: RequestTaskRestartInput): RequestTaskRestartResult {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  const actorUserId = requiredId(input.actorUserId, "actorUserId");
  const task = z.object({ state: z.enum(["active", "closed"]), restart_requested_at: isoDateTime.nullable() }).parse(
    database.query("SELECT state, restart_requested_at FROM tasks WHERE task_id = ?").get(taskId),
  );
  if (task.state !== "active") return { kind: "closed" };
  if (task.restart_requested_at !== null) return { kind: "already-pending" };
  const commandKey = requiredId(input.commandKey, "commandKey");
  const outbox = (suffix: string, payload: SlackOutboxPayload): void => {
    enqueueCommandOutbox(database, {
      taskId,
      correlationId: commandKey,
      conversationId: input.conversationId,
      threadTs: input.threadTs,
      clientMessageId: `cmd:${commandKey}${suffix}`,
      payload,
      now,
    });
  };
  writeAudit(database, {
    actorType: "slack-user",
    actorId: actorUserId,
    authority: "task-lifecycle",
    source: commandKey,
    target: taskId,
    action: "task.restart.requested",
    result: "requested",
    correlationId: commandKey,
    metadata: { command: "restart" },
    createdAt: now,
  });
  const stop = stopTask(database, { ...input, now });
  if (stop.kind !== "interrupting") {
    const generation = rotateTaskSession(database, { taskId, forced: false, actorId: actorUserId, now });
    outbox(":ready", input.replies.ready(stop.dropped));
    return { kind: "rotated", generation, dropped: stop.dropped };
  }
  database
    .query(
      `UPDATE tasks SET restart_requested_at = ?, restart_requested_by = ?, restart_command_key = ?, updated_at = ?
       WHERE task_id = ? AND state = 'active' AND restart_requested_at IS NULL`,
    )
    .run(now, actorUserId, commandKey, now, taskId);
  outbox("", input.replies.restarting(stop.dropped));
  return { kind: "pending" };
}

export interface PendingRestart {
  readonly taskId: string;
  readonly profileId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly commandKey: string;
  /** No turn holds a live lease on the old session any more. */
  readonly ready: boolean;
}

/** Restarts waiting on their turn, oldest first. */
export function listPendingRestarts(database: Database, input: { readonly now: string; readonly limit: number }): readonly PendingRestart[] {
  const now = isoDateTime.parse(input.now);
  return z
    .array(
      z.object({
        task_id: nonEmpty,
        profile_id: nonEmpty,
        conversation_id: nonEmpty,
        thread_ts: nonEmpty,
        restart_requested_at: isoDateTime,
        restart_requested_by: nonEmpty,
        restart_command_key: nonEmpty,
        busy: z.number().int(),
      }),
    )
    .parse(
      database
        .query(
          `SELECT t.task_id, t.profile_id, t.conversation_id, t.thread_ts, t.restart_requested_at,
                  t.restart_requested_by, t.restart_command_key,
                  EXISTS (SELECT 1 FROM operations o WHERE o.task_id = t.task_id AND o.status = 'inflight'
                    AND o.lease_expires_at > ?) AS busy
           FROM tasks t WHERE t.restart_requested_at IS NOT NULL AND t.state = 'active'
           ORDER BY t.restart_requested_at, t.task_id LIMIT ?`,
        )
        .all(now, z.number().int().positive().parse(input.limit)),
    )
    .map((row) => ({
      taskId: row.task_id,
      profileId: row.profile_id,
      conversationId: row.conversation_id,
      threadTs: row.thread_ts,
      requestedAt: row.restart_requested_at,
      requestedBy: row.restart_requested_by,
      commandKey: row.restart_command_key,
      ready: row.busy === 0,
    }));
}

export interface CompleteTaskRestartInput {
  readonly taskId: string;
  /** The request being completed, so a newer request is never completed by a stale listing. */
  readonly commandKey: string;
  readonly forced: boolean;
  readonly ready: SlackOutboxPayload;
  readonly now: string;
}

/**
 * Rotates a pending restart and queues its confirmation, in one IMMEDIATE transaction. Unless
 * forced, a turn holding a live lease (rechecked here) keeps it waiting: `false`.
 */
export function completeTaskRestart(database: Database, input: CompleteTaskRestartInput): boolean {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  return database.transaction((): boolean => {
    const task = z.object({ conversation_id: nonEmpty, thread_ts: nonEmpty, restart_requested_by: nonEmpty }).nullable().parse(
      database
        .query(
          `SELECT conversation_id, thread_ts, restart_requested_by FROM tasks
           WHERE task_id = ? AND state = 'active' AND restart_command_key = ?`,
        )
        .get(taskId, requiredId(input.commandKey, "commandKey")),
    );
    if (task === null) return false;
    if (!input.forced) {
      const busy = database
        .query("SELECT 1 FROM operations WHERE task_id = ? AND status = 'inflight' AND lease_expires_at > ? LIMIT 1")
        .get(taskId, now);
      if (busy !== null) return false;
    }
    rotateTaskSession(database, { taskId, forced: input.forced, actorId: "restart-worker", now });
    enqueueCommandOutbox(database, {
      taskId,
      correlationId: input.commandKey,
      conversationId: task.conversation_id,
      threadTs: task.thread_ts,
      clientMessageId: `cmd:${input.commandKey}:ready`,
      payload: input.ready,
      now,
    });
    return true;
  }).immediate();
}

export interface PendingSessionStop {
  readonly taskId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly commandId: string;
  readonly retiredAt: string;
}

/** Retired T3 threads whose session has not been stopped yet (due now), oldest first. */
export function listPendingSessionStops(database: Database, input: { readonly now: string; readonly limit: number }): readonly PendingSessionStop[] {
  const now = isoDateTime.parse(input.now);
  return z
    .array(
      z.object({
        task_id: nonEmpty,
        generation: z.number().int().positive(),
        t3_thread_id: nonEmpty,
        session_stop_command_id: nonEmpty,
        retired_at: isoDateTime,
      }),
    )
    .parse(
      database
        .query(
          `SELECT task_id, generation, t3_thread_id, session_stop_command_id, retired_at FROM task_retired_t3_threads
           WHERE session_stopped_at IS NULL AND thread_created = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY retired_at, task_id, generation LIMIT ?`,
        )
        .all(now, z.number().int().positive().parse(input.limit)),
    )
    .map((row) => ({
      taskId: row.task_id,
      generation: row.generation,
      threadId: row.t3_thread_id,
      commandId: row.session_stop_command_id,
      retiredAt: row.retired_at,
    }));
}

export interface RecordSessionStopInput {
  readonly taskId: string;
  readonly generation: number;
  /** `stopped`: T3 accepted it; `rejected`: T3 refused it for good; `retry`: try again at `retryAt`. */
  readonly outcome: "stopped" | "rejected" | "retry";
  readonly errorCode?: string | undefined;
  readonly retryAt?: string | undefined;
  readonly now: string;
}

export function recordSessionStop(database: Database, input: RecordSessionStopInput): void {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  const generation = z.number().int().positive().parse(input.generation);
  database.transaction(() => {
    if (input.outcome === "retry") {
      database
        .query(
          `UPDATE task_retired_t3_threads SET next_attempt_at = ?, last_error_code = ?
           WHERE task_id = ? AND generation = ? AND session_stopped_at IS NULL`,
        )
        .run(isoDateTime.parse(input.retryAt), input.errorCode ?? null, taskId, generation);
      return;
    }
    const result = database
      .query(
        `UPDATE task_retired_t3_threads SET session_stopped_at = ?, next_attempt_at = NULL, last_error_code = ?
         WHERE task_id = ? AND generation = ? AND session_stopped_at IS NULL`,
      )
      .run(now, null, taskId, generation);
    if (result.changes !== 1) return;
    writeAudit(database, {
      actorType: "service",
      actorId: "restart-worker",
      authority: "task-lifecycle",
      source: `${taskId}:g${generation}`,
      target: taskId,
      action: "task.session.stopped",
      result: input.outcome,
      correlationId: taskId,
      metadata: { generation, ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }) },
      createdAt: now,
    });
  }).immediate();
}

export interface CommandSettlement {
  readonly profileId: string;
}

/**
 * `!stop` as one IMMEDIATE transaction: the stop, its public reply when requests were dropped
 * (`cmd:<key>`), and the command ledger settlement. A started turn needs no reply of its own: its
 * status message turns into "Stopped by <@U>.".
 */
export function stopTaskCommand(
  database: Database,
  input: StopTaskInput & CommandSettlement & { readonly droppedReply: (result: StopTaskResult) => SlackOutboxPayload | null },
): StopTaskResult {
  const now = isoDateTime.parse(input.now);
  return database.transaction((): StopTaskResult => {
    const result = stopTask(database, input);
    const reply = input.droppedReply(result);
    if (reply !== null) {
      enqueueCommandOutbox(database, {
        taskId: input.taskId,
        correlationId: input.commandKey,
        conversationId: input.conversationId,
        threadTs: input.threadTs,
        clientMessageId: `cmd:${input.commandKey}`,
        payload: reply,
        now,
      });
    }
    settleCommandRow(database, {
      workspaceId: input.workspaceId,
      eventKey: input.commandKey,
      outcome: result.kind === "nothing" ? "rejected" : "succeeded",
      reason: result.kind === "nothing" ? "nothing-running" : null,
      profileId: input.profileId,
      now,
    });
    return result;
  }).immediate();
}

/** `!restart` as one IMMEDIATE transaction with its command ledger settlement. */
export function restartTaskCommand(
  database: Database,
  input: RequestTaskRestartInput & CommandSettlement,
): RequestTaskRestartResult {
  const now = isoDateTime.parse(input.now);
  return database.transaction((): RequestTaskRestartResult => {
    const result = requestTaskRestart(database, input);
    const rejected = result.kind === "already-pending" || result.kind === "closed";
    settleCommandRow(database, {
      workspaceId: input.workspaceId,
      eventKey: input.commandKey,
      outcome: rejected ? "rejected" : "succeeded",
      reason: rejected ? result.kind : null,
      profileId: input.profileId,
      now,
    });
    return result;
  }).immediate();
}
