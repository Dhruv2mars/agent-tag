// Turn waits: deferring an operation for a human, expiring that wait, and abandoning a turn.
// Each decision reads interaction state and writes the operation in one IMMEDIATE transaction, so
// a response committed by the Slack handler or interaction worker is never lost (see B5).
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { enqueueInteractionCardRefresh } from "./interaction-cards.ts";
import { closeOperationInteractions, queueTurnInterrupt } from "./interactions.ts";
import { requireLeaseHeld } from "./lease.ts";
import { requireTurnActiveMs, settleFailedOperation } from "./operations.ts";
import { isoDateTime, nonEmpty } from "./schema.ts";

export interface PendingInteractionRequest {
  readonly requestId: string;
  readonly kind: "approval" | "user-input";
}

export interface AwaitOperationInteractionsInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly threadId: string;
  readonly actorUserId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  /** The approval and question requests T3 still reports as pending for this turn. */
  readonly requests: ReadonlyArray<PendingInteractionRequest>;
  readonly expirySeconds: number;
  /** Slack notice posted when the wait expires. */
  readonly expiredText: string;
  readonly turnActiveMs: number;
  readonly now: string;
}

export type AwaitOperationInteractionsResult =
  /**
   * Every pending request already has this operation's response (queued, in flight, or delivered)
   * that T3 has not reflected yet: keep polling, and do not settle the operation from the snapshot
   * that reported them.
   */
  | { readonly kind: "answered" }
  /**
   * Every pending request is one an earlier operation already gave up on (T3 can keep reporting it):
   * nothing to wait for, so the turn's own state decides.
   */
  | { readonly kind: "stale" }
  /** Deferred until the earliest unanswered request expires; a response clears the block. */
  | { readonly kind: "deferred"; readonly blockedUntil: string; readonly unanswered: number }
  /** The wait expired: interactions closed, interrupt queued, operation failed with a notice. */
  | { readonly kind: "expired"; readonly outboxId: string; readonly expired: number };

const interactionStateSchema = z.object({
  interaction_id: nonEmpty,
  operation_id: nonEmpty,
  state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
  created_at: isoDateTime,
});

/** An earlier operation's request that expired or failed: it can no longer be answered in Slack. */
function isClosedForEarlierOperation(
  row: z.infer<typeof interactionStateSchema>,
  nowMs: number,
  expirySeconds: number,
): boolean {
  if (row.state === "failed") return true;
  return row.state === "pending" && nowMs >= new Date(row.created_at).getTime() + expirySeconds * 1_000;
}

export function awaitOperationInteractions(
  database: Database,
  input: AwaitOperationInteractionsInput,
): AwaitOperationInteractionsResult {
  const now = isoDateTime.parse(input.now);
  const nowMs = new Date(now).getTime();
  if (!Number.isSafeInteger(input.expirySeconds) || input.expirySeconds <= 0) {
    throw new Error("expirySeconds must be a positive integer");
  }
  if (input.requests.length === 0) throw new Error("awaitOperationInteractions needs a pending request");
  const turnActiveMs = requireTurnActiveMs(input.turnActiveMs);
  const operationId = requiredId(input.operationId, "operationId");
  const workerId = requiredId(input.workerId, "workerId");
  const threadId = requiredId(input.threadId, "threadId");

  const decide = database.transaction((): AwaitOperationInteractionsResult => {
    const unanswered: Array<{ readonly interactionId: string | null; readonly state: string; readonly createdMs: number }> = [];
    let answered = 0;
    for (const request of input.requests) {
      const row = interactionStateSchema.nullable().parse(
        database
          .query(
            "SELECT interaction_id, operation_id, state, created_at FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = ?",
          )
          .get(threadId, requiredId(request.requestId, "requestId"), request.kind),
      );
      if (row !== null && row.operation_id !== operationId) {
        // T3 can keep a request (a message-mode question) pending across an interrupt and report it
        // on later turns. A request an earlier operation already gave up on is not this turn's wait.
        if (isClosedForEarlierOperation(row, nowMs, input.expirySeconds)) continue;
        if (row.state === "pending") {
          // A still-answerable request is adopted by this turn: responses are only accepted for an
          // active operation, and this turn is the one that will see the answer through.
          database
            .query("UPDATE interactions SET operation_id = ?, updated_at = ? WHERE interaction_id = ? AND state = 'pending'")
            .run(operationId, now, row.interaction_id);
          writeAudit(database, {
            actorType: "worker",
            actorId: workerId,
            authority: "operation-dispatch",
            source: row.operation_id,
            target: row.interaction_id,
            action: "interaction.adopted",
            result: "pending",
            correlationId: operationId,
            metadata: {},
            createdAt: now,
          });
        }
      }
      if (row === null) {
        unanswered.push({ interactionId: null, state: "pending", createdMs: nowMs });
      } else if (row.state === "pending" || row.state === "failed") {
        // A failed response can never be re-answered in Slack, so it waits for expiry like a pending one.
        unanswered.push({ interactionId: row.interaction_id, state: row.state, createdMs: new Date(row.created_at).getTime() });
      } else if (row.operation_id === operationId) {
        // This operation's accepted response, which T3 has not reflected yet. An earlier operation's
        // response is not this turn's to wait for: that operation settled only once T3 reflected its
        // responses, or closed them, so T3 still reporting the request is stale.
        answered += 1;
      }
    }
    if (unanswered.length === 0) return answered > 0 ? { kind: "answered" } : { kind: "stale" };

    const expiresMs = Math.min(...unanswered.map((entry) => entry.createdMs)) + input.expirySeconds * 1_000;
    if (nowMs < expiresMs) {
      const blockedUntil = new Date(expiresMs).toISOString();
      // Waiting for a human is not a failed attempt, so the claim's attempt is returned.
      const result = database
        .query(
          `UPDATE operations SET status = 'pending', blocked_until = ?, attempts = MAX(attempts - 1, 0),
             turn_active_ms = MAX(turn_active_ms, ?), lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(blockedUntil, turnActiveMs, now, operationId, workerId, now);
      requireLeaseHeld(result, "operation");
      writeAudit(database, {
        actorType: "worker",
        actorId: workerId,
        authority: "operation-dispatch",
        source: operationId,
        target: operationId,
        action: "operation.deferred",
        result: "pending-interaction",
        correlationId: operationId,
        metadata: { blockedUntil, unanswered: unanswered.length },
        createdAt: now,
      });
      return { kind: "deferred", blockedUntil, unanswered: unanswered.length };
    }

    let expired = 0;
    for (const entry of unanswered) {
      if (entry.interactionId === null || entry.state !== "pending") continue;
      const closed = database
        .query(
          `UPDATE interactions SET state = 'failed', last_error_code = 'expired', updated_at = ?
           WHERE interaction_id = ? AND state = 'pending'`,
        )
        .run(now, entry.interactionId);
      if (closed.changes !== 1) continue;
      expired += 1;
      writeAudit(database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "turn-policy",
        source: entry.interactionId,
        target: entry.interactionId,
        action: "interaction.expired",
        result: "failed",
        correlationId: operationId,
        metadata: { expirySeconds: input.expirySeconds },
        createdAt: now,
      });
      enqueueInteractionCardRefresh(database, entry.interactionId, now);
    }
    queueTurnInterrupt(database, {
      taskId: input.taskId,
      operationId,
      threadId,
      actorUserId: input.actorUserId,
      reason: "interaction-expired",
      now,
    });
    const outboxId = settleFailedOperation(database, {
      operationId,
      taskId: input.taskId,
      workerId,
      errorCode: "InteractionExpired",
      conversationId: input.conversationId,
      threadTs: input.threadTs,
      text: input.expiredText,
      turnActiveMs: input.turnActiveMs,
      now,
    });
    return { kind: "expired", outboxId, expired };
  });
  return decide.immediate();
}

export interface AbandonOperationInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly threadId: string;
  readonly actorUserId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly errorCode: string;
  readonly text: string;
  readonly reason: "turn-ceiling";
  readonly turnActiveMs: number;
  readonly now: string;
}

/**
 * Fails a leased operation with a Slack notice, closes its open interactions, and queues a durable
 * interrupt of its T3 turn, all in one transaction.
 */
export function abandonOperation(database: Database, input: AbandonOperationInput): string {
  const now = isoDateTime.parse(input.now);
  const abandon = database.transaction(() => {
    queueTurnInterrupt(database, {
      taskId: input.taskId,
      operationId: input.operationId,
      threadId: input.threadId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      now,
    });
    // Close the turn's open approvals and questions with it, so a late Slack response cannot reach T3.
    closeOperationInteractions(database, { operationId: input.operationId, errorCode: "abandoned", now });
    return settleFailedOperation(database, { ...input, now });
  });
  return abandon.immediate();
}
