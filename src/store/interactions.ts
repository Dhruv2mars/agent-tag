// Approval and cancel interactions: recording prompts, human responses, and response delivery to T3
// with per-row backoff (`blocked_until`) for retryable failures.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId, parseStoredJson } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { insertOutboxMessage } from "./outbox.ts";
import {
  interactionIdentitySchema,
  interactionRowSchema,
  isoDateTime,
  nonEmpty,
  outboxIdentitySchema,
  outboxPayloadSchema,
} from "./schema.ts";
import type { ClaimedInteractionResponse, SlackOutboxPayload } from "./types.ts";

export type RecordPendingInteractionResult = {
  readonly kind: "accepted" | "duplicate";
  readonly interactionId: string;
  readonly outboxId: string;
};

export type SubmitInteractionResponseResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | { readonly kind: "denied" };

/**
 * `interrupt-requested`: the operation started (or may have started) a T3 turn and the interaction
 * worker will interrupt it once the turn is confirmed.
 * `cancelled-queued`: the operation never sent its T3 turn and was cancelled in the store directly.
 */
export type CancellationDisposition = "interrupt-requested" | "cancelled-queued";

export type RequestTaskCancellationResult =
  | {
      readonly kind: "accepted" | "duplicate";
      readonly interactionId: string;
      readonly commandId: string;
      readonly disposition: CancellationDisposition;
    }
  | { readonly kind: "denied" };

export interface RecordPendingInteractionInput {
  readonly taskId: string;
  readonly operationId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
  readonly prompt: unknown;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly message: (interactionId: string) => SlackOutboxPayload;
  readonly now: string;
}

export function recordPendingInteraction(
  database: Database,
  input: RecordPendingInteractionInput,
): RecordPendingInteractionResult {
  const now = isoDateTime.parse(input.now);
  const record = database.transaction(() => {
    const prior = interactionIdentitySchema.nullable().parse(
      database
        .query(
          "SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = ?",
        )
        .get(
          requiredId(input.threadId, "threadId"),
          requiredId(input.requestId, "requestId"),
          input.kind,
        ),
    );
    if (prior !== null) {
      const outbox = outboxIdentitySchema.parse(
        database
          .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
          .get(`${prior.interaction_id}:prompt`),
      );
      return { kind: "duplicate" as const, interactionId: prior.interaction_id, outboxId: outbox.outbox_id };
    }

    const interactionId = crypto.randomUUID();
    const responseCommandId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const message = outboxPayloadSchema.parse(input.message(interactionId));
    database
      .query(
        `INSERT INTO interactions (
          interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
          state, response_command_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        interactionId,
        requiredId(input.taskId, "taskId"),
        requiredId(input.operationId, "operationId"),
        input.threadId,
        input.requestId,
        input.kind,
        JSON.stringify(input.prompt),
        responseCommandId,
        now,
        now,
      );
    insertOutboxMessage(database, {
      outboxId,
      taskId: input.taskId,
      correlationId: interactionId,
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      clientMessageId: `${interactionId}:prompt`,
      payload: message,
      createdAt: now,
    });
    writeAudit(database, {
      actorType: "provider",
      actorId: "t3",
      authority: "interaction-request",
      source: input.requestId,
      target: interactionId,
      action: `interaction.${input.kind}.requested`,
      result: "pending",
      correlationId: input.operationId,
      metadata: {},
      createdAt: now,
    });
    return { kind: "accepted" as const, interactionId, outboxId };
  });
  return record.immediate();
}

export interface SubmitInteractionResponseInput {
  readonly interactionId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly sourceActionId: string;
  readonly response: unknown;
  readonly now: string;
}

export function submitInteractionResponse(
  database: Database,
  input: SubmitInteractionResponseInput,
): SubmitInteractionResponseResult {
  const now = isoDateTime.parse(input.now);
  const submit = database.transaction(() => {
    const rowSchema = z.object({
      interaction_id: nonEmpty,
      response_command_id: nonEmpty,
      source_action_id: nonEmpty.nullable(),
      state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
    });
    const row = rowSchema.nullable().parse(
      database
        .query(
          `SELECT i.interaction_id, i.response_command_id, i.source_action_id, i.state
           FROM interactions i JOIN tasks t ON t.task_id = i.task_id
           WHERE i.interaction_id = ? AND t.workspace_id = ? AND t.conversation_id = ?
             AND t.thread_ts = ? AND t.state = 'active'
             AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)`,
        )
        .get(
          requiredId(input.interactionId, "interactionId"),
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          requiredId(input.actorUserId, "actorUserId"),
        ),
    );
    if (row === null) return { kind: "denied" as const };
    if (row.source_action_id === input.sourceActionId || row.state !== "pending") {
      return { kind: "duplicate" as const, commandId: row.response_command_id };
    }
    const updated = database
      .query(
        `UPDATE interactions SET state = 'response-pending', response_json = ?,
           response_actor_id = ?, source_action_id = ?, updated_at = ?
         WHERE interaction_id = ? AND state = 'pending'`,
      )
      .run(
        JSON.stringify(input.response),
        requiredId(input.actorUserId, "actorUserId"),
        requiredId(input.sourceActionId, "sourceActionId"),
        now,
        row.interaction_id,
      );
    if (updated.changes !== 1) {
      return { kind: "duplicate" as const, commandId: row.response_command_id };
    }
    database
      .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
      .run(now, row.interaction_id);
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "interaction-response",
      source: input.sourceActionId,
      target: row.interaction_id,
      action: "interaction.response.submitted",
      result: "response-pending",
      correlationId: row.interaction_id,
      metadata: {},
      createdAt: now,
    });
    return { kind: "accepted" as const, commandId: row.response_command_id };
  });
  return submit.immediate();
}

export interface RequestTaskCancellationInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly sourceActionId: string;
  readonly now: string;
}

const cancelPromptSchema = z.object({
  disposition: z.enum(["interrupt-requested", "cancelled-queued"]).optional(),
});

function cancelDisposition(promptJson: string): CancellationDisposition {
  return cancelPromptSchema.parse(parseStoredJson(promptJson)).disposition ?? "interrupt-requested";
}

/**
 * Cancels the task's current operation. An operation that has attempted to dispatch its T3 turn is
 * interrupted (through a queued `cancel` interaction the worker sends to T3), even if the receipt
 * was lost. Only an operation that never sent `thread.turn.start` is cancelled here in the store.
 */
export function requestTaskCancellation(
  database: Database,
  input: RequestTaskCancellationInput,
): RequestTaskCancellationResult {
  const now = isoDateTime.parse(input.now);
  const taskId = requiredId(input.taskId, "taskId");
  const actorUserId = requiredId(input.actorUserId, "actorUserId");
  const sourceActionId = requiredId(input.sourceActionId, "sourceActionId");
  const request = database.transaction((): RequestTaskCancellationResult => {
    const task = z.object({ thread_id: nonEmpty }).nullable().parse(
      database
        .query(
          `SELECT t.t3_thread_id AS thread_id FROM tasks t
           WHERE t.task_id = ? AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ?
             AND (t.conversation_type = 'channel' OR t.owner_user_id = ?) AND t.state = 'active'`,
        )
        .get(
          taskId,
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          actorUserId,
        ),
    );
    if (task === null) return { kind: "denied" };

    const priorRowSchema = z.object({
      interaction_id: nonEmpty,
      response_command_id: nonEmpty,
      prompt_json: nonEmpty,
    });
    // A redelivered Slack action must not cancel the next operation in the queue.
    const replay = priorRowSchema.nullable().parse(
      database
        .query(
          `SELECT interaction_id, response_command_id, prompt_json FROM interactions
           WHERE source_action_id = ? AND task_id = ? AND kind = 'cancel'`,
        )
        .get(sourceActionId, taskId),
    );
    if (replay !== null) {
      return {
        kind: "duplicate",
        interactionId: replay.interaction_id,
        commandId: replay.response_command_id,
        disposition: cancelDisposition(replay.prompt_json),
      };
    }

    const targetSchema = z.object({
      operation_id: nonEmpty,
      status: z.enum(["pending", "inflight"]),
      t3_turn_started_at: isoDateTime.nullable(),
      t3_turn_dispatched_at: isoDateTime.nullable(),
    });
    const target = targetSchema.nullable().parse(
      database
        .query(
          `SELECT o.operation_id, o.status, o.t3_turn_started_at, o.t3_turn_dispatched_at FROM operations o
           WHERE o.task_id = ? AND o.status IN ('pending', 'inflight')
           ORDER BY CASE o.status WHEN 'inflight' THEN 0 ELSE 1 END, o.source_order_key, o.operation_id
           LIMIT 1`,
        )
        .get(taskId),
    );
    if (target === null) return { kind: "denied" };
    const requestId = `cancel:${target.operation_id}`;
    const prior = priorRowSchema.extend({ state: nonEmpty, retries_exhausted: z.number().int() }).nullable().parse(
      database
        .query(
          `SELECT interaction_id, response_command_id, prompt_json, state, retries_exhausted FROM interactions
           WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'`,
        )
        .get(task.thread_id, requestId),
    );
    if (prior !== null && prior.state === "failed" && prior.retries_exhausted === 1) {
      // Transient T3 errors exhausted the earlier attempt's retries while the operation still runs.
      // A fresh action (redeliveries were deduplicated above) requeues it with the same command id,
      // so T3 deduplicates the interrupt if an earlier attempt landed without a receipt.
      const requeued = database
        .query(
          `UPDATE interactions SET state = 'response-pending', attempts = 0, retries_exhausted = 0,
             last_error_code = NULL, blocked_until = NULL, lease_owner = NULL, lease_expires_at = NULL,
             response_actor_id = ?, source_action_id = ?, updated_at = ?
           WHERE interaction_id = ? AND state = 'failed' AND retries_exhausted = 1`,
        )
        .run(actorUserId, sourceActionId, now, prior.interaction_id);
      if (requeued.changes !== 1) throw new Error("exhausted cancellation changed during requeue");
      writeAudit(database, {
        actorType: "slack-user",
        actorId: actorUserId,
        authority: "task-cancel",
        source: sourceActionId,
        target: target.operation_id,
        action: "task.cancellation.requested",
        result: "requeued",
        correlationId: target.operation_id,
        metadata: { disposition: cancelDisposition(prior.prompt_json), interactionId: prior.interaction_id },
        createdAt: now,
      });
      return {
        kind: "accepted",
        interactionId: prior.interaction_id,
        commandId: prior.response_command_id,
        disposition: cancelDisposition(prior.prompt_json),
      };
    }
    if (prior !== null) {
      return {
        kind: "duplicate",
        interactionId: prior.interaction_id,
        commandId: prior.response_command_id,
        disposition: cancelDisposition(prior.prompt_json),
      };
    }

    // A turn whose dispatch was attempted may be running in T3 even if its receipt was lost, so only
    // an operation that never sent `thread.turn.start` is dropped locally. The rest wait for the
    // coordinator's idempotent replay to confirm the turn, then interrupt it.
    const queued = target.status === "pending" && target.t3_turn_started_at === null &&
      target.t3_turn_dispatched_at === null;
    const disposition: CancellationDisposition = queued ? "cancelled-queued" : "interrupt-requested";
    const interactionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    if (queued) {
      const cancelled = database
        .query(
          `UPDATE operations SET status = 'failed', last_error_code = 'user-cancelled', blocked_until = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'pending' AND t3_turn_started_at IS NULL
             AND t3_turn_dispatched_at IS NULL`,
        )
        .run(now, target.operation_id);
      if (cancelled.changes !== 1) throw new Error("queued operation changed during cancellation");
    }
    database
      .query(
        `INSERT INTO interactions (
          interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
          state, response_command_id, response_json, response_actor_id, source_action_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'cancel', ?, ?, ?, '{}', ?, ?, ?, ?)`,
      )
      .run(
        interactionId,
        taskId,
        target.operation_id,
        task.thread_id,
        requestId,
        JSON.stringify({ disposition }),
        queued ? "resolved" : "response-pending",
        commandId,
        actorUserId,
        sourceActionId,
        now,
        now,
      );
    writeAudit(database, {
      actorType: "slack-user",
      actorId: actorUserId,
      authority: "task-cancel",
      source: sourceActionId,
      target: target.operation_id,
      action: "task.cancellation.requested",
      result: queued ? "cancelled" : "response-pending",
      correlationId: target.operation_id,
      metadata: { disposition },
      createdAt: now,
    });
    if (queued) {
      const clientMessageId = `${target.operation_id}:cancelled`;
      const outboxId = crypto.randomUUID();
      insertOutboxMessage(database, {
        outboxId,
        taskId,
        correlationId: target.operation_id,
        conversationId: input.conversationId,
        threadTs: input.threadTs,
        clientMessageId,
        payload: outboxPayloadSchema.parse({ text: "Cancelled." }),
        createdAt: now,
      });
      writeAudit(database, {
        actorType: "slack-user",
        actorId: actorUserId,
        authority: "task-cancel",
        source: target.operation_id,
        target: taskId,
        action: "operation.cancelled",
        result: "failed",
        correlationId: target.operation_id,
        metadata: { errorCode: "user-cancelled", turnStarted: false },
        createdAt: now,
      });
      writeAudit(database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "slack-write",
        source: target.operation_id,
        target: outboxId,
        action: "slack.outbox.enqueued",
        result: "pending",
        correlationId: target.operation_id,
        metadata: { clientMessageId },
        createdAt: now,
      });
    }
    return { kind: "accepted", interactionId, commandId, disposition };
  });
  return request.immediate();
}

export interface ClaimNextInteractionResponseInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export function claimNextInteractionResponse(
  database: Database,
  input: ClaimNextInteractionResponseInput,
): ClaimedInteractionResponse | null {
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedInteractionResponse | null => {
    const candidate = interactionIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT interaction_id FROM interactions
           WHERE (state = 'response-pending' AND (blocked_until IS NULL OR blocked_until <= ?))
              OR (state = 'inflight' AND lease_expires_at <= ?)
           ORDER BY created_at, interaction_id LIMIT 1`,
        )
        .get(now, now),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE interactions SET state = 'inflight', attempts = attempts + 1, blocked_until = NULL,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE interaction_id = ? AND (
           (state = 'response-pending' AND (blocked_until IS NULL OR blocked_until <= ?))
           OR (state = 'inflight' AND lease_expires_at <= ?))`,
      )
      .run(workerId, expiresAt, now, candidate.interaction_id, now, now);
    if (updated.changes !== 1) return null;
    const row = interactionRowSchema.parse(
      database
        .query(
          `SELECT i.interaction_id, i.task_id, i.operation_id, i.thread_id, i.request_id, i.kind,
                  i.response_command_id, i.response_json, i.response_actor_id, i.attempts, i.lease_expires_at,
                  o.status AS operation_status, o.last_error_code AS operation_error_code,
                  o.message_id AS operation_message_id, o.t3_turn_dispatched_at, o.t3_turn_started_at, o.t3_turn_id
           FROM interactions i JOIN operations o ON o.operation_id = i.operation_id
           WHERE i.interaction_id = ?`,
        )
        .get(candidate.interaction_id),
    );
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "interaction-response",
      source: row.interaction_id,
      target: row.thread_id,
      action: "interaction.response.claimed",
      result: "inflight",
      correlationId: row.operation_id,
      metadata: { attempt: row.attempts },
      createdAt: now,
    });
    return {
      interactionId: row.interaction_id,
      taskId: row.task_id,
      operationId: row.operation_id,
      threadId: row.thread_id,
      requestId: row.request_id,
      kind: row.kind,
      commandId: row.response_command_id,
      actorUserId: row.response_actor_id,
      response: parseStoredJson(row.response_json),
      attempt: row.attempts,
      leaseExpiresAt: row.lease_expires_at,
      operationStatus: row.operation_status,
      operationErrorCode: row.operation_error_code,
      operationMessageId: row.operation_message_id,
      turnDispatched: row.t3_turn_dispatched_at !== null || row.t3_turn_started_at !== null,
      turnStarted: row.t3_turn_started_at !== null,
      turnId: row.t3_turn_id,
    };
  });
  return claim.immediate();
}

export interface CompleteInteractionResponseInput {
  readonly interactionId: string;
  readonly workerId: string;
  readonly now: string;
}

export function completeInteractionResponse(
  database: Database,
  input: CompleteInteractionResponseInput,
): void {
  const now = isoDateTime.parse(input.now);
  const complete = database.transaction(() => {
    const result = database
      .query(
        `UPDATE interactions SET state = 'resolved', blocked_until = NULL, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE interaction_id = ? AND state = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        now,
        requiredId(input.interactionId, "interactionId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "interaction");
    database
      .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
      .run(now, input.interactionId);
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "interaction-response",
      source: input.interactionId,
      target: input.interactionId,
      action: "interaction.response.completed",
      result: "resolved",
      correlationId: input.interactionId,
      metadata: {},
      createdAt: now,
    });
  });
  complete.immediate();
}

export interface FailInteractionResponseInput {
  readonly interactionId: string;
  readonly workerId: string;
  readonly errorCode: string;
  /** Retryable failures return to `response-pending`; terminal ones become `failed`. */
  readonly retryable: boolean;
  /** For a retryable failure: the row is not claimable again before this time (backoff). */
  readonly blockedUntil?: string;
  /** For a terminal failure: one Slack notice posted to the task thread, at most once per interaction. */
  readonly notice?: string;
  /** A terminal failure caused only by transient errors exhausting the retry budget. */
  readonly retriesExhausted?: boolean;
  readonly now: string;
}

export function failInteractionResponse(database: Database, input: FailInteractionResponseInput): void {
  const now = isoDateTime.parse(input.now);
  const state = input.retryable ? "response-pending" : "failed";
  const blockedUntil = input.retryable && input.blockedUntil !== undefined
    ? isoDateTime.parse(input.blockedUntil)
    : null;
  const notice = input.retryable ? undefined : input.notice;
  const interactionId = requiredId(input.interactionId, "interactionId");
  const fail = database.transaction(() => {
    const result = database
      .query(
        `UPDATE interactions SET state = ?, last_error_code = ?, blocked_until = ?, retries_exhausted = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE interaction_id = ? AND state = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        state,
        requiredId(input.errorCode, "errorCode"),
        blockedUntil,
        !input.retryable && input.retriesExhausted === true ? 1 : 0,
        now,
        interactionId,
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "interaction");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "interaction-response",
      source: interactionId,
      target: interactionId,
      action: "interaction.response.failed",
      result: state,
      correlationId: interactionId,
      metadata: { errorCode: input.errorCode, retryable: input.retryable, blockedUntil },
      createdAt: now,
    });
    if (notice === undefined) return;
    const clientMessageId = `${interactionId}:failed`;
    const prior = outboxIdentitySchema.nullable().parse(
      database.query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?").get(clientMessageId),
    );
    if (prior !== null) return;
    const thread = z.object({ task_id: nonEmpty, conversation_id: nonEmpty, thread_ts: nonEmpty }).parse(
      database
        .query(
          `SELECT t.task_id, t.conversation_id, t.thread_ts
           FROM interactions i JOIN tasks t ON t.task_id = i.task_id WHERE i.interaction_id = ?`,
        )
        .get(interactionId),
    );
    const outboxId = crypto.randomUUID();
    insertOutboxMessage(database, {
      outboxId,
      taskId: thread.task_id,
      correlationId: interactionId,
      conversationId: thread.conversation_id,
      threadTs: thread.thread_ts,
      clientMessageId,
      payload: outboxPayloadSchema.parse({ text: notice }),
      createdAt: now,
    });
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "slack-write",
      source: interactionId,
      target: outboxId,
      action: "slack.outbox.enqueued",
      result: "pending",
      correlationId: interactionId,
      metadata: { clientMessageId },
      createdAt: now,
    });
  });
  fail.immediate();
}
