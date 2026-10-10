// Approval and cancel interactions: recording prompts, human responses, and response delivery to T3
// with per-row backoff (`blocked_until`) for retryable failures.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId, parseStoredJson } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { enqueueInteractionCardRefresh } from "./interaction-cards.ts";
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
 * `interrupt-requested`: the operation started (or may have started) a T3 turn and the interaction
 * worker will interrupt it once the turn is confirmed.
 * `cancelled-queued`: the operation never sent its T3 turn and was cancelled in the store directly.
 */
export type CancellationDisposition = "interrupt-requested" | "cancelled-queued";

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
    unblockInteractionOperation(database, row.interaction_id, now);
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
    enqueueInteractionCardRefresh(database, row.interaction_id, now);
    return { kind: "accepted" as const, commandId: row.response_command_id };
  });
  return submit.immediate();
}

/**
 * Failure codes recorded only after T3 itself reported the turn ended: an observed `error` turn
 * (`classifyT3TurnFailure`) or a cancellation (an observed interrupt, or a turn never sent). Any other
 * failure is local (settlement timeout, service errors, revoked authority) and leaves the T3 turn's
 * outcome unknown, so cancellation must still interrupt it.
 */
export const T3_TURN_ENDED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "T3ProviderAuthPolicy",
  "T3ProviderAuth",
  "T3ProviderLimit",
  "T3TurnError",
  "user-cancelled",
]);

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
 * Requeues a cancellation whose transient T3 errors exhausted its retries. It keeps the same command
 * id, so T3 deduplicates the interrupt if an earlier attempt landed without a receipt. The superseded
 * action id stays recorded so its late redelivery is still a duplicate.
 */
function requeueExhaustedCancellation(
  database: Database,
  prior: {
    readonly interaction_id: string;
    readonly response_command_id: string;
    readonly prompt_json: string;
    readonly source_action_id: string | null;
    readonly operation_id: string;
  },
  input: { readonly actorUserId: string; readonly sourceActionId: string; readonly now: string },
): RequestTaskCancellationResult {
  if (prior.source_action_id !== null) {
    database
      .query(
        `INSERT OR IGNORE INTO interaction_source_actions (source_action_id, interaction_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(prior.source_action_id, prior.interaction_id, input.now);
  }
  const requeued = database
    .query(
      `UPDATE interactions SET state = 'response-pending', attempts = 0, retries_exhausted = 0,
         last_error_code = NULL, blocked_until = NULL, lease_owner = NULL, lease_expires_at = NULL,
         response_actor_id = ?, source_action_id = ?, updated_at = ?
       WHERE interaction_id = ? AND state = 'failed' AND retries_exhausted = 1`,
    )
    .run(input.actorUserId, input.sourceActionId, input.now, prior.interaction_id);
  if (requeued.changes !== 1) throw new Error("exhausted cancellation changed during requeue");
  const disposition = cancelDisposition(prior.prompt_json);
  writeAudit(database, {
    actorType: "slack-user",
    actorId: input.actorUserId,
    authority: "task-cancel",
    source: input.sourceActionId,
    target: prior.operation_id,
    action: "task.cancellation.requested",
    result: "requeued",
    correlationId: prior.operation_id,
    metadata: { disposition, interactionId: prior.interaction_id },
    createdAt: input.now,
  });
  return {
    kind: "accepted",
    interactionId: prior.interaction_id,
    commandId: prior.response_command_id,
    disposition,
  };
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
    // A redelivered Slack action must not cancel the next operation in the queue. A requeue moves
    // source_action_id to the fresh action, so earlier accepted actions are checked as well.
    const replay = priorRowSchema.nullable().parse(
      database
        .query(
          `SELECT interaction_id, response_command_id, prompt_json FROM interactions
           WHERE task_id = ? AND kind = 'cancel' AND (source_action_id = ? OR interaction_id IN (
             SELECT interaction_id FROM interaction_source_actions WHERE source_action_id = ?))
           LIMIT 1`,
        )
        .get(taskId, sourceActionId, sourceActionId),
    );
    if (replay !== null) {
      return {
        kind: "duplicate",
        interactionId: replay.interaction_id,
        commandId: replay.response_command_id,
        disposition: cancelDisposition(replay.prompt_json),
      };
    }

    const exhaustedSchema = priorRowSchema.extend({
      operation_id: nonEmpty,
      source_action_id: nonEmpty.nullable(),
    });
    // Delivery failures can exhaust a cancellation's retries while its operation fails locally (for
    // example on the settlement timeout) with the T3 turn possibly still running. A fresh action
    // recovers that interrupt before any later operation is targeted. Operations whose T3 turn is
    // confirmed ended, or was never sent, have nothing left to interrupt.
    const endedCodes = [...T3_TURN_ENDED_FAILURE_CODES];
    const stranded = exhaustedSchema.nullable().parse(
      database
        .query(
          `SELECT i.interaction_id, i.response_command_id, i.prompt_json, i.source_action_id, o.operation_id
           FROM interactions i JOIN operations o ON o.operation_id = i.operation_id
           WHERE i.task_id = ? AND i.kind = 'cancel' AND i.state = 'failed' AND i.retries_exhausted = 1
             AND o.status = 'failed'
             AND (o.t3_turn_started_at IS NOT NULL OR o.t3_turn_dispatched_at IS NOT NULL)
             AND (o.last_error_code IS NULL OR o.last_error_code NOT IN (${endedCodes.map(() => "?").join(", ")}))
           ORDER BY o.source_order_key DESC, o.operation_id DESC
           LIMIT 1`,
        )
        .get(taskId, ...endedCodes),
    );
    if (stranded !== null) {
      return requeueExhaustedCancellation(database, stranded, { actorUserId, sourceActionId, now });
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
    const prior = priorRowSchema.extend({
      state: nonEmpty,
      retries_exhausted: z.number().int(),
      source_action_id: nonEmpty.nullable(),
    }).nullable().parse(
      database
        .query(
          `SELECT interaction_id, response_command_id, prompt_json, state, retries_exhausted, source_action_id
           FROM interactions
           WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'`,
        )
        .get(task.thread_id, requestId),
    );
    if (prior !== null && prior.state === "failed" && prior.retries_exhausted === 1) {
      return requeueExhaustedCancellation(
        database,
        { ...prior, operation_id: target.operation_id },
        { actorUserId, sourceActionId, now },
      );
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
      // Like every terminal transition (see the invariant at claimNextInteractionResponse). A turn
      // never sent cannot have asked anything, so this is normally a no-op.
      closeOperationInteractions(database, { operationId: target.operation_id, errorCode: OPERATION_SETTLED, now });
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
/** Open and not held by a live worker lease; binds one `now` parameter. Ignores retry backoff. */
const UNHELD_RESPONSE = `(i.state = 'response-pending' OR (i.state = 'inflight' AND i.lease_expires_at <= ?))`;
/** Unheld and past any retry backoff (`blocked_until`); binds two `now` parameters. */
const CLAIMABLE_RESPONSE = `((i.state = 'response-pending' AND (i.blocked_until IS NULL OR i.blocked_until <= ?))
  OR (i.state = 'inflight' AND i.lease_expires_at <= ?))`;

export function claimNextInteractionResponse(
  database: Database,
  input: ClaimNextInteractionResponseInput,
): ClaimedInteractionResponse | null {
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedInteractionResponse | null => {
    // Settle unheld responses whose operation has already settled, instead of dispatching them. A
    // response in retry backoff is included: it can never become dispatchable again.
    const undispatchable = z
      .array(z.object({ interaction_id: nonEmpty, operation_id: nonEmpty, state: z.enum(["response-pending", "inflight"]) }))
      .parse(
        database
          .query(
            `SELECT i.interaction_id, i.operation_id, i.state FROM interactions i
             WHERE ${UNHELD_RESPONSE} AND NOT ${DISPATCHABLE_RESPONSE}`,
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
        .get(now, now),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE interactions AS i SET state = 'inflight', attempts = attempts + 1, blocked_until = NULL,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE i.interaction_id = ? AND ${CLAIMABLE_RESPONSE} AND ${DISPATCHABLE_RESPONSE}`,
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
    const userInputs = z.array(z.object({ request_id: z.string(), answered: z.number().int() })).parse(
      database
        .query(
          `SELECT request_id, response_json IS NOT NULL AS answered FROM interactions
           WHERE operation_id = ? AND kind = 'user-input'
           ORDER BY created_at, interaction_id`,
        )
        .all(row.operation_id),
    );
    const userInputRequestIds = userInputs.map((entry) => entry.request_id);
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
      turnDispatchedAt: row.t3_turn_dispatched_at ?? row.t3_turn_started_at,
      turnStarted: row.t3_turn_started_at !== null,
      turnId: row.t3_turn_id,
      userInputRequestIds,
      userInputAnswered: userInputs.some((entry) => entry.answered === 1),
    };
  });
  return claim.immediate();
}

/** Makes the interaction's operation claimable again by clearing its deferral backoff. */
function unblockInteractionOperation(
  database: Database,
  interactionId: string,
  now: string,
  filter: { readonly kind?: "cancel" } = {},
): void {
  database
    .query(
      `UPDATE operations SET blocked_until = NULL, updated_at = ?
       WHERE operation_id = (
         SELECT operation_id FROM interactions WHERE interaction_id = ? AND (? IS NULL OR kind = ?)
       )`,
    )
    .run(now, interactionId, filter.kind ?? null, filter.kind ?? null);
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
    unblockInteractionOperation(database, input.interactionId, now);
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
    enqueueInteractionCardRefresh(database, input.interactionId, now);
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
  /**
   * For a terminal failure of an interaction without a card (cancel, or a card that was never
   * posted): one Slack notice posted to the task thread, at most once per interaction. Approvals and
   * questions show the failure on their card instead.
   */
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
    // Every cancel settlement unblocks its operation, as successful delivery does: a cancel that found
    // the turn already ended (or gave up) must not leave the operation deferred, or the coordinator
    // could not observe and finalize it and later requests in the task would wait out the deferral.
    // A scheduled retry is not a settlement, so the operation stays blocked until the cancel settles.
    if (!input.retryable) unblockInteractionOperation(database, interactionId, now, { kind: "cancel" });
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
    if (input.retryable) return;
    // An approval or question shows the outcome on its card ("Not applied"); the thread notice is
    // only for interactions without one (cancels, or a card whose post failed).
    if (enqueueInteractionCardRefresh(database, interactionId, now)) return;
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
      `UPDATE interactions SET state = 'failed', last_error_code = ?, blocked_until = NULL, lease_owner = NULL,
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
  enqueueInteractionCardRefresh(database, input.interactionId, input.now);
  return true;
}
