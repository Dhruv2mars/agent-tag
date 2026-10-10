// Slack reaction queue (instant ack): enqueue in the ingest transaction, claim, and settle.
// Separate from the outbox: reactions.add is idempotent (already_reacted), so a reaction is retried
// where an outbox post would be quarantined, it never orders against a thread's posts, and a
// reactions rate limit pauses only reactions.
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { isoDateTime, nonEmpty } from "./schema.ts";

/** Rate-limit scope in slack_rate_limits for reactions.add; posts use the outbox's own scope. */
export const REACTION_RATE_LIMIT_SCOPE = "reactions.add";

export interface AckReactionRow {
  readonly operationId: string;
  readonly taskId: string;
  readonly conversationId: string;
  /** The triggering message the reaction goes on. */
  readonly messageTs: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Inserts the ack reaction for an accepted operation. Call inside the ingest transaction. */
export function insertAckReaction(database: Database, row: AckReactionRow): void {
  database
    .query(
      `INSERT INTO slack_reactions (
        reaction_key, task_id, operation_id, conversation_id, message_ts, name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      `${row.operationId}:ack`,
      row.taskId,
      row.operationId,
      row.conversationId,
      row.messageTs,
      row.name,
      row.createdAt,
      row.createdAt,
    );
}

export interface ClaimedReaction {
  readonly reactionKey: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly conversationId: string;
  readonly messageTs: string;
  readonly name: string;
  readonly attempt: number;
}

const claimedRowSchema = z.object({
  reaction_key: nonEmpty,
  task_id: nonEmpty,
  operation_id: nonEmpty,
  conversation_id: nonEmpty,
  message_ts: nonEmpty,
  name: nonEmpty,
  attempts: z.number().int().positive(),
});

export interface ClaimNextReactionInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

/**
 * Claims the oldest deliverable reaction: pending and past its backoff, or inflight with an expired
 * lease (a crashed worker). Nothing is claimed while a reactions rate-limit cooldown is active.
 */
export function claimNextReaction(context: StoreContext, input: ClaimNextReactionInput): ClaimedReaction | null {
  const { database } = context;
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedReaction | null => {
    const cooldown = database
      .query<{ blocked_until: string }, [string, string]>(
        "SELECT blocked_until FROM slack_rate_limits WHERE scope = ? AND blocked_until > ?",
      )
      .get(REACTION_RATE_LIMIT_SCOPE, now);
    if (cooldown !== null) return null;
    const row = claimedRowSchema.nullable().parse(
      database
        .query(
          `UPDATE slack_reactions SET status = 'inflight', attempts = attempts + 1, blocked_until = NULL,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE reaction_key = (
             SELECT reaction_key FROM slack_reactions
             WHERE (status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?))
                OR (status = 'inflight' AND lease_expires_at <= ?)
             ORDER BY created_at, reaction_key LIMIT 1
           )
           RETURNING reaction_key, task_id, operation_id, conversation_id, message_ts, name, attempts`,
        )
        .get(workerId, expiresAt, now, now, now),
    );
    if (row === null) return null;
    return {
      reactionKey: row.reaction_key,
      taskId: row.task_id,
      operationId: row.operation_id,
      conversationId: row.conversation_id,
      messageTs: row.message_ts,
      name: row.name,
      attempt: row.attempts,
    };
  });
  return claim.immediate();
}

export interface SettleReactionInput {
  readonly reactionKey: string;
  readonly workerId: string;
  readonly now: string;
}

export interface ReactionFailureInput extends SettleReactionInput {
  /** A short, secret-free code such as a Slack platform error name. */
  readonly errorCode: string;
}

export interface RetryReactionInput extends ReactionFailureInput {
  /** The reaction is not claimable before this instant. */
  readonly blockedUntil: string;
  /** Slack rate limited reactions.add: no reaction is claimable before this instant. */
  readonly rateLimitedUntil?: string;
}

interface ReactionSettlement {
  readonly status: "pending" | "delivered" | "failed";
  readonly errorCode: string | null;
  readonly blockedUntil: string | null;
  readonly rateLimitedUntil?: string;
  readonly audit?: { readonly action: "slack.reaction.added" | "slack.reaction.failed"; readonly result: string };
}

function settleLeasedReaction(database: Database, input: SettleReactionInput, settlement: ReactionSettlement): void {
  const now = isoDateTime.parse(input.now);
  const reactionKey = requiredId(input.reactionKey, "reactionKey");
  const workerId = requiredId(input.workerId, "workerId");
  const settle = database.transaction(() => {
    const result = database
      .query(
        `UPDATE slack_reactions SET status = ?, last_error_code = COALESCE(?, last_error_code), blocked_until = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE reaction_key = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(settlement.status, settlement.errorCode, settlement.blockedUntil, now, reactionKey, workerId, now);
    requireLeaseHeld(result, "reaction");
    if (settlement.rateLimitedUntil !== undefined) {
      // Never shorten a cooldown another rate-limited reaction already set.
      database
        .query(
          `INSERT INTO slack_rate_limits (scope, blocked_until, error_code, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope) DO UPDATE SET
             blocked_until = MAX(blocked_until, excluded.blocked_until),
             error_code = excluded.error_code, updated_at = excluded.updated_at`,
        )
        .run(REACTION_RATE_LIMIT_SCOPE, isoDateTime.parse(settlement.rateLimitedUntil), settlement.errorCode, now);
    }
    if (settlement.audit !== undefined) {
      writeAudit(database, {
        actorType: "worker",
        actorId: workerId,
        authority: "slack-write",
        source: reactionKey,
        target: reactionKey,
        action: settlement.audit.action,
        result: settlement.audit.result,
        correlationId: reactionKey.replace(/:ack$/, ""),
        metadata: { errorCode: settlement.errorCode },
        createdAt: now,
      });
    }
  });
  settle.immediate();
}

/** Slack added the reaction, or it was already there (`already_reacted`, passed as errorCode). */
export function markReactionDelivered(database: Database, input: SettleReactionInput & { readonly errorCode?: string }): void {
  settleLeasedReaction(database, input, {
    status: "delivered",
    errorCode: input.errorCode ?? null,
    blockedUntil: null,
    audit: { action: "slack.reaction.added", result: "delivered" },
  });
}

/** Terminal: Slack rejected it for good (missing scope, message gone), or authority was revoked. */
export function failReaction(database: Database, input: ReactionFailureInput): void {
  settleLeasedReaction(database, input, {
    status: "failed",
    errorCode: requiredId(input.errorCode, "errorCode"),
    blockedUntil: null,
    audit: { action: "slack.reaction.failed", result: "failed" },
  });
}

/** Back to pending, not claimable until `blockedUntil`; a rate limit also pauses every reaction. */
export function retryReaction(database: Database, input: RetryReactionInput): void {
  settleLeasedReaction(database, input, {
    status: "pending",
    errorCode: requiredId(input.errorCode, "errorCode"),
    blockedUntil: isoDateTime.parse(input.blockedUntil),
    ...(input.rateLimitedUntil === undefined ? {} : { rateLimitedUntil: input.rateLimitedUntil }),
  });
}
