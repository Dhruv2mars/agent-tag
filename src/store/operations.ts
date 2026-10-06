// Operation queue: claim, lease renewal, and every terminal or retry transition.
import type { Database } from "bun:sqlite";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId, parseStoredJson } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { insertOutboxMessage } from "./outbox.ts";
import {
  isoDateTime,
  operationIdentitySchema,
  operationPayloadSchema,
  operationRowSchema,
  outboxIdentitySchema,
  outboxPayloadSchema,
  resolvedOperationTextSchema,
} from "./schema.ts";
import type { ClaimedOperation } from "./types.ts";

export interface ClaimNextOperationInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
  readonly maxConcurrentTasks: number;
}

export function claimNextOperation(
  context: StoreContext,
  input: ClaimNextOperationInput,
): ClaimedOperation | null {
  const { database, faultInjector } = context;
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  if (!Number.isSafeInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks <= 0) {
    throw new Error("maxConcurrentTasks must be positive");
  }
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedOperation | null => {
    const active = database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(DISTINCT task_id) AS count FROM operations WHERE status = 'inflight' AND lease_expires_at > ?",
      )
      .get(now)?.count;
    if (active === undefined) throw new Error("failed to count active operation leases");
    if (active >= input.maxConcurrentTasks) return null;

    const identity = operationIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT o.operation_id, o.task_id, o.command_id, o.message_id
           FROM operations o
           WHERE ((o.status = 'pending' AND (o.blocked_until IS NULL OR o.blocked_until <= ?))
              OR (o.status = 'inflight' AND o.lease_expires_at <= ?))
             AND NOT EXISTS (
               SELECT 1 FROM operations earlier
               WHERE earlier.task_id = o.task_id
                 AND earlier.status IN ('pending', 'inflight')
                 AND (earlier.source_order_key < o.source_order_key OR
                   (earlier.source_order_key = o.source_order_key AND earlier.operation_id < o.operation_id))
             )
             AND NOT EXISTS (
               SELECT 1 FROM operations active
               WHERE active.task_id = o.task_id
                 AND active.operation_id <> o.operation_id
                 AND active.status = 'inflight'
                 AND active.lease_expires_at > ?
             )
             -- An interrupt queued for an earlier, already settled turn (an expired approval or a
             -- turn past its ceiling) must reach T3 before the next turn starts, or it could stop it.
             AND NOT EXISTS (
               SELECT 1 FROM interactions interrupt
               WHERE interrupt.task_id = o.task_id
                 AND interrupt.operation_id <> o.operation_id
                 AND interrupt.kind = 'cancel'
                 AND interrupt.state IN ('response-pending', 'inflight')
                 AND interrupt.request_id LIKE 'interrupt:%'
             )
           ORDER BY o.source_order_key, o.operation_id
           LIMIT 1`,
        )
        .get(now, now, now),
    );
    if (identity === null) return null;
    const updated = database
      .query(
        `UPDATE operations
         SET status = 'inflight', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE operation_id = ? AND ((status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?))
           OR (status = 'inflight' AND lease_expires_at <= ?))`,
      )
      .run(workerId, expiresAt, now, identity.operation_id, now, now);
    if (updated.changes !== 1) return null;
    faultInjector("operation-claim.after-update");
    const row = operationRowSchema.parse(
      database
        .query(
          `SELECT operation_id, task_id, command_id, message_id, payload_json,
                  attempts, lease_expires_at, turn_active_ms
           FROM operations WHERE operation_id = ?`,
        )
        .get(identity.operation_id),
    );
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "operation-dispatch",
      source: row.operation_id,
      target: row.task_id,
      action: "operation.claimed",
      result: "inflight",
      correlationId: row.operation_id,
      metadata: { attempt: row.attempts },
      createdAt: now,
    });
    return {
      operationId: row.operation_id,
      taskId: row.task_id,
      commandId: row.command_id,
      messageId: row.message_id,
      payload: operationPayloadSchema.parse(parseStoredJson(row.payload_json)),
      attempt: row.attempts,
      leaseExpiresAt: row.lease_expires_at,
      turnActiveMs: row.turn_active_ms,
    };
  });
  return claim.immediate();
}

export interface RenewOperationLeaseInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
  /** Total active polling time of the turn so far; persisted so the turn ceiling survives restarts. */
  readonly turnActiveMs?: number;
}

export function requireTurnActiveMs(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("turnActiveMs must be a non-negative integer");
  return value;
}

export function renewOperationLease(database: Database, input: RenewOperationLeaseInput): string {
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const turnActiveMs = requireTurnActiveMs(input.turnActiveMs);
  const result = database
    .query(
      `UPDATE operations SET lease_expires_at = ?, updated_at = ?,
         turn_active_ms = MAX(turn_active_ms, COALESCE(?, 0))
       WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
    )
    .run(
      expiresAt,
      now,
      turnActiveMs,
      requiredId(input.operationId, "operationId"),
      requiredId(input.workerId, "workerId"),
      now,
    );
  requireLeaseHeld(result, "operation");
  return expiresAt;
}

export interface ResolveOperationTurnTextInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly proposedText: string;
  readonly now: string;
}

export function resolveOperationTurnText(database: Database, input: ResolveOperationTurnTextInput): string {
  const now = isoDateTime.parse(input.now);
  const resolve = database.transaction(() => {
    const operationId = requiredId(input.operationId, "operationId");
    const prior = resolvedOperationTextSchema.parse(
      database
        .query(
          `SELECT resolved_text FROM operations
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .get(operationId, requiredId(input.workerId, "workerId"), now),
    );
    if (prior.resolved_text !== null) return prior.resolved_text;
    const result = database
      .query(
        `UPDATE operations SET resolved_text = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ?
           AND lease_expires_at > ? AND resolved_text IS NULL`,
      )
      .run(input.proposedText, now, operationId, input.workerId, now);
    if (result.changes !== 1) throw new Error("operation turn text could not be resolved");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: operationId,
      target: operationId,
      action: "operation.turn-text.resolved",
      result: "immutable",
      correlationId: operationId,
      metadata: {},
      createdAt: now,
    });
    return input.proposedText;
  });
  return resolve.immediate();
}

export interface CompleteOperationInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly resultSequence: number;
  readonly now: string;
}

export function completeOperation(database: Database, input: CompleteOperationInput): void {
  const now = isoDateTime.parse(input.now);
  if (!Number.isSafeInteger(input.resultSequence) || input.resultSequence < 0) {
    throw new Error("resultSequence must be a non-negative integer");
  }
  const complete = database.transaction(() => {
    const result = database
      .query(
        `UPDATE operations SET status = 'succeeded', result_sequence = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        input.resultSequence,
        now,
        requiredId(input.operationId, "operationId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "operation");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: input.operationId,
      target: input.operationId,
      action: "operation.completed",
      result: "succeeded",
      correlationId: input.operationId,
      metadata: { resultSequence: input.resultSequence },
      createdAt: now,
    });
  });
  complete.immediate();
}

export interface CompleteOperationWithOutboxInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly resultSequence: number;
  readonly conversationId: string;
  readonly threadTs: string;
  /** One reply, or ordered Slack-sized chunks of one reply (see splitForSlack). */
  readonly text: string | readonly string[];
  readonly now: string;
}

export function completeOperationWithOutbox(
  database: Database,
  input: CompleteOperationWithOutboxInput,
): string {
  const now = isoDateTime.parse(input.now);
  if (!Number.isSafeInteger(input.resultSequence) || input.resultSequence < 0) {
    throw new Error("resultSequence must be a non-negative integer");
  }
  const complete = database.transaction(() => {
    const operationId = requiredId(input.operationId, "operationId");
    const taskId = requiredId(input.taskId, "taskId");
    const result = database
      .query(
        `UPDATE operations SET status = 'succeeded', result_sequence = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND task_id = ? AND status = 'inflight'
           AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        input.resultSequence,
        now,
        operationId,
        taskId,
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "operation");

    // A single reply keeps the historical `:final` id; chunked replies get stable
    // `:final-1..n` ids. Chunks are spaced 1ms apart so the outbox claim order
    // (created_at first) delivers them in sequence.
    const texts = typeof input.text === "string" ? [input.text] : [...input.text];
    if (texts.length === 0) throw new Error("final reply must have at least one chunk");
    const outboxIds = texts.map((text, index) => {
      const clientMessageId = texts.length === 1 ? `${operationId}:final` : `${operationId}:final-${index + 1}`;
      const createdAt = new Date(new Date(now).getTime() + index).toISOString();
      const prior = outboxIdentitySchema.nullable().parse(
        database
          .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
          .get(clientMessageId),
      );
      const outboxId = prior?.outbox_id ?? crypto.randomUUID();
      if (prior === null) {
        insertOutboxMessage(database, {
          outboxId,
          taskId,
          correlationId: operationId,
          conversationId: requiredId(input.conversationId, "conversationId"),
          threadTs: requiredId(input.threadTs, "threadTs"),
          clientMessageId,
          payload: outboxPayloadSchema.parse({ text }),
          createdAt,
        });
      }
      return { outboxId, clientMessageId };
    });
    const first = outboxIds[0];
    if (first === undefined) throw new Error("final reply must have at least one chunk");
    const outboxId = first.outboxId;
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: operationId,
      target: taskId,
      action: "operation.completed",
      result: "succeeded",
      correlationId: operationId,
      metadata: { resultSequence: input.resultSequence },
      createdAt: now,
    });
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "slack-write",
      source: operationId,
      target: outboxId,
      action: "slack.outbox.enqueued",
      result: "pending",
      correlationId: operationId,
      metadata: { clientMessageId: first.clientMessageId, chunks: outboxIds.length },
      createdAt: now,
    });
    return outboxId;
  });
  return complete.immediate();
}

export interface DeferOperationInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly blockedUntil: string;
  readonly now: string;
}

export function deferOperation(database: Database, input: DeferOperationInput): void {
  const now = isoDateTime.parse(input.now);
  const blockedUntil = isoDateTime.parse(input.blockedUntil);
  const defer = database.transaction(() => {
    const result = database
      .query(
        `UPDATE operations SET status = 'pending', blocked_until = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        blockedUntil,
        now,
        requiredId(input.operationId, "operationId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "operation");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: input.operationId,
      target: input.operationId,
      action: "operation.deferred",
      result: "pending-interaction",
      correlationId: input.operationId,
      metadata: { blockedUntil },
      createdAt: now,
    });
  });
  defer.immediate();
}

export interface ReleaseOperationInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly now: string;
}

/**
 * Returns an in-progress operation to the queue without counting the attempt, e.g. on service
 * shutdown. The stable command and message ids let the next owner resume the same T3 turn.
 */
export function releaseOperation(database: Database, input: ReleaseOperationInput): boolean {
  const now = isoDateTime.parse(input.now);
  const release = database.transaction(() => {
    const result = database
      .query(
        `UPDATE operations SET status = 'pending', attempts = MAX(attempts - 1, 0), blocked_until = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(now, requiredId(input.operationId, "operationId"), requiredId(input.workerId, "workerId"), now);
    if (result.changes !== 1) return false;
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: input.operationId,
      target: input.operationId,
      action: "operation.released",
      result: "pending",
      correlationId: input.operationId,
      metadata: { reason: "shutdown" },
      createdAt: now,
    });
    return true;
  });
  return release.immediate();
}

export interface FailOperationInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly blockedUntil?: string;
  readonly now: string;
}

export function failOperation(database: Database, input: FailOperationInput): void {
  const now = isoDateTime.parse(input.now);
  const status = input.retryable ? "pending" : "failed";
  const blockedUntil = input.retryable && input.blockedUntil !== undefined
    ? isoDateTime.parse(input.blockedUntil)
    : null;
  const fail = database.transaction(() => {
    const result = database
      .query(
        `UPDATE operations SET status = ?, last_error_code = ?, blocked_until = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        status,
        requiredId(input.errorCode, "errorCode"),
        blockedUntil,
        now,
        requiredId(input.operationId, "operationId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "operation");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: input.operationId,
      target: input.operationId,
      action: "operation.failed",
      result: status,
      correlationId: input.operationId,
      metadata: { errorCode: input.errorCode, retryable: input.retryable, blockedUntil },
      createdAt: now,
    });
  });
  fail.immediate();
}

export interface FailOperationWithOutboxInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly text: string;
  readonly now: string;
}

export function failOperationWithOutbox(database: Database, input: FailOperationWithOutboxInput): string {
  const fail = database.transaction(() => settleFailedOperation(database, input));
  return fail.immediate();
}

/**
 * Terminally fails a leased operation and queues its one Slack failure notice. Runs inside the
 * caller's transaction so it can be combined with other writes (see waits.ts).
 */
export function settleFailedOperation(
  database: Database,
  input: FailOperationWithOutboxInput & { readonly turnActiveMs?: number },
): string {
  const now = isoDateTime.parse(input.now);
  const turnActiveMs = requireTurnActiveMs(input.turnActiveMs);
  const operationId = requiredId(input.operationId, "operationId");
  const taskId = requiredId(input.taskId, "taskId");
  const result = database
    .query(
      `UPDATE operations SET status = 'failed', last_error_code = ?, lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?, turn_active_ms = MAX(turn_active_ms, COALESCE(?, 0))
       WHERE operation_id = ? AND task_id = ? AND status = 'inflight'
         AND lease_owner = ? AND lease_expires_at > ?`,
    )
    .run(
      requiredId(input.errorCode, "errorCode"),
      now,
      turnActiveMs,
      operationId,
      taskId,
      requiredId(input.workerId, "workerId"),
      now,
    );
  requireLeaseHeld(result, "operation");

  const clientMessageId = `${operationId}:failed`;
  const prior = outboxIdentitySchema.nullable().parse(
    database.query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?").get(clientMessageId),
  );
  const outboxId = prior?.outbox_id ?? crypto.randomUUID();
  if (prior === null) {
    insertOutboxMessage(database, {
      outboxId,
      taskId,
      correlationId: operationId,
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      clientMessageId,
      payload: outboxPayloadSchema.parse({ text: input.text }),
      createdAt: now,
    });
  }
  writeAudit(database, {
    actorType: "worker",
    actorId: input.workerId,
    authority: "operation-dispatch",
    source: operationId,
    target: taskId,
    action: "operation.failed",
    result: "failed",
    correlationId: operationId,
    metadata: { errorCode: input.errorCode, retryable: false },
    createdAt: now,
  });
  if (prior === null) {
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "slack-write",
      source: operationId,
      target: outboxId,
      action: "slack.outbox.enqueued",
      result: "pending",
      correlationId: operationId,
      metadata: { clientMessageId },
      createdAt: now,
    });
  }
  return outboxId;
}

export interface CancelOperationWithOutboxInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly now: string;
}

export function cancelOperationWithOutbox(database: Database, input: CancelOperationWithOutboxInput): string {
  const now = isoDateTime.parse(input.now);
  const cancel = database.transaction(() => {
    const operationId = requiredId(input.operationId, "operationId");
    const taskId = requiredId(input.taskId, "taskId");
    const result = database
      .query(
        `UPDATE operations SET status = 'failed', last_error_code = 'user-cancelled',
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE operation_id = ? AND task_id = ? AND status = 'inflight'
           AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        now,
        operationId,
        taskId,
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "operation");
    const clientMessageId = `${operationId}:cancelled`;
    const outboxId = crypto.randomUUID();
    insertOutboxMessage(database, {
      outboxId,
      taskId,
      correlationId: operationId,
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      clientMessageId,
      payload: outboxPayloadSchema.parse({ text: "Cancelled." }),
      createdAt: now,
    });
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "operation-dispatch",
      source: operationId,
      target: taskId,
      action: "operation.cancelled",
      result: "failed",
      correlationId: operationId,
      metadata: { errorCode: "user-cancelled" },
      createdAt: now,
    });
    return outboxId;
  });
  return cancel.immediate();
}
