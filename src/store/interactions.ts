// Approval and cancel interactions: recording prompts, human responses, and response delivery to T3.
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
  | { readonly kind: "expired" }
  | { readonly kind: "denied" };

/**
 * True once an approval or question has waited `expirySeconds` since it was posted. Responses are
 * refused from that instant, even before the coordinator's next poll closes the wait, so a late click
 * can never be delivered to T3 (B7).
 */
export function interactionResponseExpired(createdAt: string, expirySeconds: number, now: string): boolean {
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0) {
    throw new Error("expirySeconds must be a positive integer");
  }
  return new Date(now).getTime() >= new Date(isoDateTime.parse(createdAt)).getTime() + expirySeconds * 1_000;
}

/**
 * Whether an interaction's operation can still take a response. Once the operation has settled
 * (succeeded, or failed: cancelled, expired, abandoned at its ceiling) nothing tracks its T3 turn, so a late
 * response could deliver an approval or start an untracked turn; it is refused like an expired one.
 */
export function operationAcceptsResponses(status: string): boolean {
  return status === "pending" || status === "inflight";
}

export type RequestTaskCancellationResult =
  | { readonly kind: "accepted" | "duplicate"; readonly interactionId: string; readonly commandId: string }
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
  /** The configured approval/question expiry; responses at or past the deadline are refused. */
  readonly expirySeconds: number;
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
      created_at: isoDateTime,
      operation_status: nonEmpty,
    });
    const row = rowSchema.nullable().parse(
      database
        .query(
          `SELECT i.interaction_id, i.response_command_id, i.source_action_id, i.state, i.created_at,
                  o.status AS operation_status
           FROM interactions i JOIN tasks t ON t.task_id = i.task_id
             JOIN operations o ON o.operation_id = i.operation_id
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
    if (!operationAcceptsResponses(row.operation_status)) return { kind: "expired" as const };
    if (interactionResponseExpired(row.created_at, input.expirySeconds, now)) return { kind: "expired" as const };
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

export function requestTaskCancellation(
  database: Database,
  input: RequestTaskCancellationInput,
): RequestTaskCancellationResult {
  const now = isoDateTime.parse(input.now);
  const request = database.transaction(() => {
    const targetSchema = z.object({ operation_id: nonEmpty, thread_id: nonEmpty });
    const target = targetSchema.nullable().parse(
      database
        .query(
          `SELECT o.operation_id, t.t3_thread_id AS thread_id
           FROM tasks t JOIN operations o ON o.task_id = t.task_id
           WHERE t.task_id = ? AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ?
             AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)
             AND t.state = 'active' AND o.status IN ('pending', 'inflight')
           ORDER BY CASE o.status WHEN 'inflight' THEN 0 ELSE 1 END, o.source_order_key, o.operation_id
           LIMIT 1`,
        )
        .get(
          requiredId(input.taskId, "taskId"),
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          requiredId(input.actorUserId, "actorUserId"),
        ),
    );
    if (target === null) return { kind: "denied" as const };
    const requestId = `cancel:${target.operation_id}`;
    const prior = interactionIdentitySchema.nullable().parse(
      database
        .query("SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'")
        .get(target.thread_id, requestId),
    );
    if (prior !== null) {
      const command = z.object({ response_command_id: nonEmpty }).parse(
        database
          .query("SELECT response_command_id FROM interactions WHERE interaction_id = ?")
          .get(prior.interaction_id),
      );
      return { kind: "duplicate" as const, interactionId: prior.interaction_id, commandId: command.response_command_id };
    }
    const interactionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    database
      .query(
        `INSERT INTO interactions (
          interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
          state, response_command_id, response_json, response_actor_id, source_action_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'cancel', '{}', 'response-pending', ?, '{}', ?, ?, ?, ?)`,
      )
      .run(
        interactionId,
        input.taskId,
        target.operation_id,
        target.thread_id,
        requestId,
        commandId,
        requiredId(input.actorUserId, "actorUserId"),
        requiredId(input.sourceActionId, "sourceActionId"),
        now,
        now,
      );
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "task-cancel",
      source: input.sourceActionId,
      target: target.operation_id,
      action: "task.cancellation.requested",
      result: "response-pending",
      correlationId: target.operation_id,
      metadata: {},
      createdAt: now,
    });
    return { kind: "accepted" as const, interactionId, commandId };
  });
  return request.immediate();
}

export interface ClaimNextInteractionResponseInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

/**
 * INVARIANT: a non-cancel interaction response is dispatched to T3 only while its operation is
 * `pending` or `inflight`. Once the operation has settled nothing tracks its T3 turn, so a late
 * approval could approve work after a cancellation and a late answer could start an untracked
 * message-mode turn. Cancel interactions (turn interrupts) are exempt: they exist to stop the turn
 * of an operation Agent Tag already settled.
 *
 * Every path that can hand a response to T3 upholds it:
 * - terminal operation transitions close the operation's open responses in the same transaction
 *   (`closeOperationInteractions`), including in-flight ones, which lose their lease;
 * - this claim (first claims and reclaims of expired leases alike) only selects dispatchable
 *   responses, and settles any undispatchable one it would otherwise pick up as `failed`
 *   (`operation-settled`), so it can never be retried or reclaimed;
 * - a retryable worker failure returns a response to `response-pending`, i.e. back through this claim;
 * - the worker re-checks just before dispatching (`checkInteractionDispatch`).
 *
 * The counterpart: an accepted response is never closed while its operation still waits for it. The
 * coordinator settles an operation only from a T3 snapshot that reflects every accepted response: it
 * keeps polling while T3 still reports a request that has a response (queued, in flight or delivered),
 * and while T3's latest turn ended before one of the operation's delivered message-mode answers (the
 * turn that continues from it, a new turn or the running turn it steered, has not shown up). So when
 * completion or interruption closes queued and in-flight responses, those are only ones T3 no longer
 * awaits, which T3 would refuse anyway. A response whose delivery never lands ends with its operation
 * via the stall, ceiling or failure paths.
 */
const DISPATCHABLE_RESPONSE = `(i.kind = 'cancel' OR EXISTS (
  SELECT 1 FROM operations o WHERE o.operation_id = i.operation_id AND o.status IN ('pending', 'inflight')))`;
const CLAIMABLE_RESPONSE = `(i.state = 'response-pending' OR (i.state = 'inflight' AND i.lease_expires_at <= ?))`;

export function claimNextInteractionResponse(
  database: Database,
  input: ClaimNextInteractionResponseInput,
): ClaimedInteractionResponse | null {
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedInteractionResponse | null => {
    // Settle claimable responses whose operation has already settled, instead of dispatching them.
    const undispatchable = z
      .array(z.object({ interaction_id: nonEmpty, operation_id: nonEmpty, state: z.enum(["response-pending", "inflight"]) }))
      .parse(
        database
          .query(
            `SELECT i.interaction_id, i.operation_id, i.state FROM interactions i
             WHERE ${CLAIMABLE_RESPONSE} AND NOT ${DISPATCHABLE_RESPONSE}`,
          )
          .all(now),
      );
    for (const row of undispatchable) {
      settleInteraction(database, {
        interactionId: row.interaction_id,
        fromState: row.state,
        errorCode: OPERATION_SETTLED,
        operationId: row.operation_id,
        now,
      });
    }
    const candidate = interactionIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT i.interaction_id FROM interactions i
           WHERE ${CLAIMABLE_RESPONSE} AND ${DISPATCHABLE_RESPONSE}
           ORDER BY i.created_at, i.interaction_id LIMIT 1`,
        )
        .get(now),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE interactions AS i SET state = 'inflight', attempts = attempts + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE i.interaction_id = ? AND ${CLAIMABLE_RESPONSE} AND ${DISPATCHABLE_RESPONSE}`,
      )
      .run(workerId, expiresAt, now, candidate.interaction_id, now);
    if (updated.changes !== 1) return null;
    const row = interactionRowSchema.parse(
      database
        .query(
          `SELECT interaction_id, task_id, operation_id, thread_id, request_id, kind,
                  response_command_id, response_json, response_actor_id, attempts, lease_expires_at
           FROM interactions WHERE interaction_id = ?`,
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
    };
  });
  return claim.immediate();
}

export interface CheckInteractionDispatchInput {
  readonly interactionId: string;
  readonly workerId: string;
  readonly now: string;
}

export type CheckInteractionDispatchResult =
  | { readonly kind: "dispatch" }
  | { readonly kind: "refused"; readonly errorCode: string };

/**
 * The worker's last check before handing a claimed response to T3 (see the invariant at
 * `claimNextInteractionResponse`): the worker must still hold the response's lease, and a non-cancel
 * response's operation must still be pending or inflight. A held response whose operation settled
 * since the claim is closed as `failed` (`operation-settled`) so it is never retried or reclaimed.
 */
export function checkInteractionDispatch(
  database: Database,
  input: CheckInteractionDispatchInput,
): CheckInteractionDispatchResult {
  const interactionId = requiredId(input.interactionId, "interactionId");
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const check = database.transaction((): CheckInteractionDispatchResult => {
    const row = z
      .object({
        operation_id: nonEmpty,
        held: z.number().int(),
        dispatchable: z.number().int(),
        last_error_code: z.string().nullable(),
      })
      .nullable()
      .parse(
        database
          .query(
            `SELECT i.operation_id, i.last_error_code,
                    (i.state = 'inflight' AND i.lease_owner = ? AND i.lease_expires_at > ?) AS held,
                    ${DISPATCHABLE_RESPONSE} AS dispatchable
             FROM interactions i WHERE i.interaction_id = ?`,
          )
          .get(workerId, now, interactionId),
      );
    if (row === null) return { kind: "refused", errorCode: "interaction-missing" };
    if (row.held !== 1) return { kind: "refused", errorCode: row.last_error_code ?? "lease-lost" };
    if (row.dispatchable === 1) return { kind: "dispatch" };
    settleInteraction(database, {
      interactionId,
      fromState: "inflight",
      errorCode: OPERATION_SETTLED,
      operationId: row.operation_id,
      now,
    });
    return { kind: "refused", errorCode: OPERATION_SETTLED };
  });
  return check.immediate();
}

/**
 * The request ids of an operation's answered questions (queued, in flight or delivered). The
 * coordinator waits for T3 to reflect these answers before settling the operation from a turn's state.
 */
export function answeredOperationQuestions(database: Database, operationId: string): ReadonlySet<string> {
  const rows = z
    .array(z.object({ request_id: nonEmpty }))
    .parse(
      database
        .query(
          `SELECT request_id FROM interactions
           WHERE operation_id = ? AND kind = 'user-input' AND state IN ('response-pending', 'inflight', 'resolved')`,
        )
        .all(requiredId(operationId, "operationId")),
    );
  return new Set(rows.map((row) => row.request_id));
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
        `UPDATE interactions SET state = 'resolved', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
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
  readonly retryable: boolean;
  readonly now: string;
}

export function failInteractionResponse(database: Database, input: FailInteractionResponseInput): void {
  const now = isoDateTime.parse(input.now);
  const state = input.retryable ? "response-pending" : "failed";
  const fail = database.transaction(() => {
    const result = database
      .query(
        `UPDATE interactions SET state = ?, last_error_code = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE interaction_id = ? AND state = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        state,
        requiredId(input.errorCode, "errorCode"),
        now,
        requiredId(input.interactionId, "interactionId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "interaction");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "interaction-response",
      source: input.interactionId,
      target: input.interactionId,
      action: "interaction.response.failed",
      result: state,
      correlationId: input.interactionId,
      metadata: { errorCode: input.errorCode, retryable: input.retryable },
      createdAt: now,
    });
  });
  fail.immediate();
}

export interface QueueTurnInterruptInput {
  readonly taskId: string;
  readonly operationId: string;
  readonly threadId: string;
  /** The operation's requester; the interaction worker re-checks their authority before sending. */
  readonly actorUserId: string;
  readonly reason: "interaction-expired" | "turn-ceiling";
  readonly now: string;
}

/**
 * Queues a durable `thread.turn.interrupt` for an operation Agent Tag is abandoning. The interaction
 * worker delivers it with the usual retry/lease rules, and the operation claim query holds the next
 * turn of the task until it is delivered (see `claimNextOperation`). Runs inside the caller's
 * transaction; idempotent per operation.
 */
export function queueTurnInterrupt(database: Database, input: QueueTurnInterruptInput): string {
  const now = isoDateTime.parse(input.now);
  const operationId = requiredId(input.operationId, "operationId");
  const threadId = requiredId(input.threadId, "threadId");
  const requestId = `interrupt:${operationId}`;
  const prior = interactionIdentitySchema.nullable().parse(
    database
      .query("SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'")
      .get(threadId, requestId),
  );
  if (prior !== null) return prior.interaction_id;
  const interactionId = crypto.randomUUID();
  database
    .query(
      `INSERT INTO interactions (
        interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
        state, response_command_id, response_json, response_actor_id, source_action_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'cancel', ?, 'response-pending', ?, '{}', ?, ?, ?, ?)`,
    )
    .run(
      interactionId,
      requiredId(input.taskId, "taskId"),
      operationId,
      threadId,
      requestId,
      JSON.stringify({ reason: input.reason }),
      crypto.randomUUID(),
      requiredId(input.actorUserId, "actorUserId"),
      requestId,
      now,
      now,
    );
  writeAudit(database, {
    actorType: "service",
    actorId: "agent-tag",
    authority: "turn-policy",
    source: operationId,
    target: interactionId,
    action: "interaction.cancel.requested",
    result: "response-pending",
    correlationId: operationId,
    metadata: { reason: input.reason },
    createdAt: now,
  });
  return interactionId;
}

export interface CloseOperationInteractionsInput {
  readonly operationId: string;
  /** Why the operation stopped accepting responses, recorded as each interaction's error code. */
  readonly errorCode: string;
  /**
   * Leave requests still awaiting a human (`pending`) open. They cannot be answered or dispatched
   * while their operation is settled, and a later turn that T3 reports them on can adopt them (see
   * `awaitOperationInteractions`). Used when a turn ends without Agent Tag giving up on it
   * (completed, or interrupted in T3).
   */
  readonly keepAwaitingHuman?: boolean;
  readonly now: string;
}

/** The error code an interaction gets when its operation settles before its response reached T3. */
export const OPERATION_SETTLED = "operation-settled";

const closableStates = ["pending", "response-pending", "inflight"] as const;

/**
 * Closes the approvals and questions an operation still has open when it settles: ones awaiting a
 * human, ones answered but not yet sent to T3, and ones a worker holds (`inflight`). Without this, a
 * queued or reclaimed response could deliver an approval, or answer a message-mode question and
 * start an untracked T3 turn, after the operation failed, was interrupted or was abandoned. An
 * in-flight response loses its lease and becomes `failed`, so it is never retried or reclaimed; a
 * worker already dispatching it can no longer complete or retry it. Every terminal operation
 * transition calls this inside its own transaction; returns how many interactions were closed.
 */
export function closeOperationInteractions(database: Database, input: CloseOperationInteractionsInput): number {
  const operationId = requiredId(input.operationId, "operationId");
  const errorCode = requiredId(input.errorCode, "errorCode");
  const now = isoDateTime.parse(input.now);
  const states = input.keepAwaitingHuman === true
    ? closableStates.filter((state) => state !== "pending")
    : closableStates;
  const open = z
    .array(z.object({ interaction_id: nonEmpty, state: z.enum(closableStates) }))
    .parse(
      database
        .query(
          `SELECT interaction_id, state FROM interactions
           WHERE operation_id = ? AND kind != 'cancel' AND state IN (${states.map(() => "?").join(", ")})
           ORDER BY created_at, interaction_id`,
        )
        .all(operationId, ...states),
    );
  let closed = 0;
  for (const row of open) {
    if (settleInteraction(database, { interactionId: row.interaction_id, fromState: row.state, errorCode, now, operationId })) {
      closed += 1;
    }
  }
  return closed;
}

/** Moves one open interaction to `failed`, dropping any lease, and audits it. Runs in the caller's transaction. */
function settleInteraction(
  database: Database,
  input: {
    readonly interactionId: string;
    readonly fromState: (typeof closableStates)[number];
    readonly errorCode: string;
    readonly operationId: string;
    readonly now: string;
  },
): boolean {
  const result = database
    .query(
      `UPDATE interactions SET state = 'failed', last_error_code = ?, lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
       WHERE interaction_id = ? AND state = ? AND kind != 'cancel'`,
    )
    .run(input.errorCode, input.now, input.interactionId, input.fromState);
  if (result.changes !== 1) return false;
  writeAudit(database, {
    actorType: "service",
    actorId: "agent-tag",
    authority: "turn-policy",
    source: input.interactionId,
    target: input.interactionId,
    action: "interaction.closed",
    result: "failed",
    correlationId: input.operationId,
    metadata: { errorCode: input.errorCode, previousState: input.fromState },
    createdAt: input.now,
  });
  return true;
}
