// Slack outbox queue: enqueue, claim (respecting retry backoff and rate-limit cooldowns), delivery
// outcome, retry, fallback, and quarantine of unknown outcomes.
import type { Database } from "bun:sqlite";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId, parseStoredJson } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import {
  isoDateTime,
  outboxIdentitySchema,
  outboxPayloadSchema,
  outboxRowSchema,
} from "./schema.ts";
import type { ClaimedOutboxMessage, SlackOutboxInput, SlackOutboxPayload } from "./types.ts";

export interface OutboxMessageRow {
  readonly outboxId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: SlackOutboxPayload;
  /** Also written as updated_at. */
  readonly createdAt: string;
}

/**
 * The single writer of new slack_outbox rows: inserts one pending message. Callers validate ids and
 * parse the payload first, and decide whether to look up an existing client_message_id beforehand.
 */
export function insertOutboxMessage(database: Database, row: OutboxMessageRow): void {
  database
    .query(
      `INSERT INTO slack_outbox (
        outbox_id, task_id, correlation_id, conversation_id, thread_ts,
        client_message_id, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      row.outboxId,
      row.taskId,
      row.correlationId,
      row.conversationId,
      row.threadTs,
      row.clientMessageId,
      JSON.stringify(row.payload),
      row.createdAt,
      row.createdAt,
    );
}

export type EnqueueOutboxResult = { readonly kind: "accepted" | "duplicate"; readonly outboxId: string };

export function enqueueOutbox(context: StoreContext, input: SlackOutboxInput): EnqueueOutboxResult {
  const { database, faultInjector } = context;
  const payload = outboxPayloadSchema.parse(input.payload);
  const createdAt = isoDateTime.parse(input.createdAt);
  const enqueue = database.transaction(() => {
    const prior = outboxIdentitySchema.nullable().parse(
      database
        .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
        .get(requiredId(input.clientMessageId, "clientMessageId")),
    );
    if (prior !== null) return { kind: "duplicate" as const, outboxId: prior.outbox_id };
    const outboxId = crypto.randomUUID();
    insertOutboxMessage(database, {
      outboxId,
      taskId: requiredId(input.taskId, "taskId"),
      correlationId: requiredId(input.correlationId, "correlationId"),
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      clientMessageId: input.clientMessageId,
      payload,
      createdAt,
    });
    faultInjector("outbox-enqueue.after-insert");
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
      createdAt,
    });
    return { kind: "accepted" as const, outboxId };
  });
  return enqueue.immediate();
}

export interface ClaimNextOutboxInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

/**
 * Every outbox row is a chat.postMessage call with the one bot token, so a rate limit on any row
 * (per channel, or for the method across the workspace; Slack does not say which) pauses them all.
 */
export const OUTBOX_RATE_LIMIT_SCOPE = "chat.postMessage";

/** The instant until which the outbox's rate-limit cooldown holds, or null when none is active. */
export function activeOutboxRateLimit(database: Database, now: string): string | null {
  const row = database
    .query<{ blocked_until: string }, [string, string]>(
      "SELECT blocked_until FROM slack_rate_limits WHERE scope = ? AND blocked_until > ?",
    )
    .get(OUTBOX_RATE_LIMIT_SCOPE, now);
  return row?.blocked_until ?? null;
}

/** Claim order for a row; also used to keep later rows of a thread behind an earlier blocked row. */
const CLAIM_ORDER_COLUMNS = (alias: string): string =>
  `${alias}.created_at, ${alias}.correlation_id,
    CASE WHEN ${alias}.client_message_id LIKE '%:started' THEN 0 ELSE 1 END, ${alias}.outbox_id`;

/**
 * Claims the next deliverable pending row. Rows waiting out a retry backoff (`blocked_until` in the
 * future) are skipped, and so are later rows of the same Slack thread, so a retried message is never
 * overtaken by the replies that were queued after it. Nothing is claimed while a rate-limit cooldown
 * is active.
 */
export function claimNextOutbox(
  context: StoreContext,
  input: ClaimNextOutboxInput,
): ClaimedOutboxMessage | null {
  const { database, faultInjector } = context;
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedOutboxMessage | null => {
    if (activeOutboxRateLimit(database, now) !== null) return null;
    const candidate = outboxIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT candidate.outbox_id FROM slack_outbox AS candidate
           WHERE candidate.status = 'pending'
             AND (candidate.blocked_until IS NULL OR candidate.blocked_until <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM slack_outbox AS earlier
               WHERE earlier.conversation_id = candidate.conversation_id
                 AND earlier.thread_ts = candidate.thread_ts
                 AND earlier.status = 'pending'
                 AND earlier.blocked_until > ?
                 AND (${CLAIM_ORDER_COLUMNS("earlier")}) < (${CLAIM_ORDER_COLUMNS("candidate")})
             )
           ORDER BY ${CLAIM_ORDER_COLUMNS("candidate")}
           LIMIT 1`,
        )
        .get(now, now),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE slack_outbox SET status = 'inflight', attempts = attempts + 1, blocked_until = NULL,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE outbox_id = ? AND (
           (status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?))
           OR (status = 'inflight' AND lease_expires_at <= ?)
         )`,
      )
      .run(workerId, expiresAt, now, candidate.outbox_id, now, now);
    if (updated.changes !== 1) return null;
    faultInjector("outbox-claim.after-update");
    const row = outboxRowSchema.parse(
      database
        .query(
          `SELECT outbox_id, task_id, correlation_id, conversation_id, thread_ts,
                  client_message_id, payload_json, attempts, lease_expires_at, render_mode
           FROM slack_outbox WHERE outbox_id = ?`,
        )
        .get(candidate.outbox_id),
    );
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "slack-write",
      source: row.outbox_id,
      target: row.conversation_id,
      action: "slack.outbox.claimed",
      result: "inflight",
      correlationId: row.correlation_id,
      metadata: { attempt: row.attempts, renderMode: row.render_mode },
      createdAt: now,
    });
    return {
      outboxId: row.outbox_id,
      taskId: row.task_id,
      correlationId: row.correlation_id,
      conversationId: row.conversation_id,
      threadTs: row.thread_ts,
      clientMessageId: row.client_message_id,
      payload: outboxPayloadSchema.parse(parseStoredJson(row.payload_json)),
      renderMode: row.render_mode,
      attempt: row.attempts,
      leaseExpiresAt: row.lease_expires_at,
    };
  });
  return claim.immediate();
}

export interface MarkOutboxDeliveredInput {
  readonly outboxId: string;
  readonly workerId: string;
  readonly slackMessageTs: string;
  readonly now: string;
}

export function markOutboxDelivered(database: Database, input: MarkOutboxDeliveredInput): void {
  const now = isoDateTime.parse(input.now);
  const deliver = database.transaction(() => {
    const result = database
      .query(
        `UPDATE slack_outbox SET status = 'delivered', slack_message_ts = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE outbox_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        requiredId(input.slackMessageTs, "slackMessageTs"),
        now,
        requiredId(input.outboxId, "outboxId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "outbox");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "slack-write",
      source: input.outboxId,
      target: input.slackMessageTs,
      action: "slack.outbox.delivered",
      result: "delivered",
      correlationId: input.outboxId,
      metadata: {},
      createdAt: now,
    });
  });
  deliver.immediate();
}

/** Common fields for settling a failed delivery attempt; the caller must still hold the lease. */
export interface OutboxFailureInput {
  readonly outboxId: string;
  readonly workerId: string;
  /** A short, secret-free code such as a Slack platform error name. */
  readonly errorCode: string;
  readonly now: string;
}

interface OutboxSettlement {
  readonly status: "pending" | "failed";
  readonly lastErrorCode: string;
  readonly blockedUntil: string | null;
  readonly plainFallback: boolean;
  readonly action:
    | "slack.outbox.failed"
    | "slack.outbox.quarantined"
    | "slack.outbox.retry-scheduled"
    | "slack.outbox.retry-exhausted"
    | "slack.outbox.fallback-scheduled";
  readonly result: string;
  readonly metadata: Record<string, string | number | boolean | null>;
  /** Set when Slack rate limited the send: no row is claimable before this instant. */
  readonly rateLimitedUntil?: string;
}

/** Moves a leased inflight row to its next state and writes the matching audit row atomically. */
function settleLeasedOutbox(database: Database, input: OutboxFailureInput, settlement: OutboxSettlement): void {
  const now = isoDateTime.parse(input.now);
  const errorCode = requiredId(input.errorCode, "errorCode");
  const settle = database.transaction(() => {
    const result = database
      .query(
        `UPDATE slack_outbox SET status = ?, last_error_code = ?, blocked_until = ?,
           render_mode = CASE WHEN ? THEN 'plain' ELSE render_mode END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE outbox_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        settlement.status,
        requiredId(settlement.lastErrorCode, "lastErrorCode"),
        settlement.blockedUntil,
        settlement.plainFallback ? 1 : 0,
        now,
        requiredId(input.outboxId, "outboxId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    requireLeaseHeld(result, "outbox");
    if (settlement.rateLimitedUntil !== undefined) {
      // Never shorten a cooldown another rate-limited send already set.
      database
        .query(
          `INSERT INTO slack_rate_limits (scope, blocked_until, error_code, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope) DO UPDATE SET
             blocked_until = MAX(blocked_until, excluded.blocked_until),
             error_code = excluded.error_code, updated_at = excluded.updated_at`,
        )
        .run(OUTBOX_RATE_LIMIT_SCOPE, settlement.rateLimitedUntil, errorCode, now);
    }
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "slack-write",
      source: input.outboxId,
      target: input.outboxId,
      action: settlement.action,
      result: settlement.result,
      correlationId: input.outboxId,
      metadata: { errorCode, ...settlement.metadata },
      createdAt: now,
    });
  });
  settle.immediate();
}

/** Terminal failure: Slack deterministically rejected the message, or authority was revoked. */
export function failOutbox(database: Database, input: OutboxFailureInput): void {
  settleLeasedOutbox(database, input, {
    status: "failed",
    lastErrorCode: input.errorCode,
    blockedUntil: null,
    plainFallback: false,
    action: "slack.outbox.failed",
    result: "failed",
    metadata: { retryable: false },
  });
}

export interface RateLimitCooldownInput {
  /** Slack rate limited the send: no outbox row is claimable before this instant. */
  readonly rateLimitedUntil?: string;
}

function cooldown(input: RateLimitCooldownInput): { rateLimitedUntil?: string } {
  return input.rateLimitedUntil === undefined ? {} : { rateLimitedUntil: isoDateTime.parse(input.rateLimitedUntil) };
}

export interface RetryOutboxInput extends OutboxFailureInput, RateLimitCooldownInput {
  /** The row is not claimable before this instant. */
  readonly blockedUntil: string;
}

/**
 * Known-not-delivered failure: back to pending, but not claimable until `blockedUntil`. A rate limit
 * also pauses every other row until `rateLimitedUntil`.
 */
export function retryOutbox(database: Database, input: RetryOutboxInput): void {
  const blockedUntil = isoDateTime.parse(input.blockedUntil);
  const rateLimit = cooldown(input);
  settleLeasedOutbox(database, input, {
    status: "pending",
    lastErrorCode: input.errorCode,
    blockedUntil,
    plainFallback: false,
    action: "slack.outbox.retry-scheduled",
    result: "pending",
    metadata: { retryable: true, blockedUntil, ...rateLimit },
    ...rateLimit,
  });
}

export interface ExhaustOutboxRetriesInput extends OutboxFailureInput, RateLimitCooldownInput {
  readonly attempts: number;
}

/** A retryable failure on the final allowed attempt: the row fails and the audit says why. */
export function exhaustOutboxRetries(database: Database, input: ExhaustOutboxRetriesInput): void {
  settleLeasedOutbox(database, input, {
    status: "failed",
    lastErrorCode: "retry-attempts-exhausted",
    blockedUntil: null,
    plainFallback: false,
    action: "slack.outbox.retry-exhausted",
    result: "failed",
    metadata: { retryable: false, attempts: input.attempts },
    ...cooldown(input),
  });
}

/** Ambiguous failure: Slack may have posted the message, so it is never resent automatically. */
export function quarantineOutbox(database: Database, input: OutboxFailureInput): void {
  settleLeasedOutbox(database, input, {
    status: "failed",
    lastErrorCode: "delivery-outcome-unknown",
    blockedUntil: null,
    plainFallback: false,
    action: "slack.outbox.quarantined",
    result: "delivery-outcome-unknown",
    metadata: { retryable: false },
  });
}

/**
 * Slack rejected the rich payload (for example `invalid_blocks` or `msg_too_long`): requeue the row
 * once, immediately, to be sent as plain escaped text.
 */
export function scheduleOutboxFallback(database: Database, input: OutboxFailureInput): void {
  settleLeasedOutbox(database, input, {
    status: "pending",
    lastErrorCode: input.errorCode,
    blockedUntil: null,
    plainFallback: true,
    action: "slack.outbox.fallback-scheduled",
    result: "pending",
    metadata: { renderMode: "plain" },
  });
}

export function quarantineExpiredOutbox(database: Database, nowInput: string): number {
  const now = isoDateTime.parse(nowInput);
  const quarantine = database.transaction(() => {
    const expired = database
      .query<{ outbox_id: string; correlation_id: string }, [string]>(
        `SELECT outbox_id, correlation_id FROM slack_outbox
         WHERE status = 'inflight' AND lease_expires_at <= ?`,
      )
      .all(now);
    for (const row of expired) {
      const outboxId = requiredId(row.outbox_id, "outboxId");
      const correlationId = requiredId(row.correlation_id, "correlationId");
      database
        .query(
          `UPDATE slack_outbox SET status = 'failed', last_error_code = 'delivery-outcome-unknown',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE outbox_id = ? AND status = 'inflight'`,
        )
        .run(now, outboxId);
      writeAudit(database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "slack-write",
        source: outboxId,
        target: outboxId,
        action: "slack.outbox.quarantined",
        result: "delivery-outcome-unknown",
        correlationId,
        metadata: {},
        createdAt: now,
      });
    }
    return expired.length;
  });
  return quarantine.immediate();
}
