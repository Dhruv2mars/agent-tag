// Slack outbox queue: enqueue, claim, delivery outcome, and quarantine of unknown outcomes.
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

export function claimNextOutbox(
  context: StoreContext,
  input: ClaimNextOutboxInput,
): ClaimedOutboxMessage | null {
  const { database, faultInjector } = context;
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedOutboxMessage | null => {
    const candidate = outboxIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT outbox_id FROM slack_outbox
           WHERE status = 'pending'
           ORDER BY created_at, correlation_id,
             CASE WHEN client_message_id LIKE '%:started' THEN 0 ELSE 1 END,
             outbox_id
           LIMIT 1`,
        )
        .get(),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE slack_outbox SET status = 'inflight', attempts = attempts + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE outbox_id = ? AND (status = 'pending' OR (status = 'inflight' AND lease_expires_at <= ?))`,
      )
      .run(workerId, expiresAt, now, candidate.outbox_id, now);
    if (updated.changes !== 1) return null;
    faultInjector("outbox-claim.after-update");
    const row = outboxRowSchema.parse(
      database
        .query(
          `SELECT outbox_id, task_id, correlation_id, conversation_id, thread_ts,
                  client_message_id, payload_json, attempts, lease_expires_at
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
      metadata: { attempt: row.attempts },
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

export interface FailOutboxInput {
  readonly outboxId: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly now: string;
}

export function failOutbox(database: Database, input: FailOutboxInput): void {
  const now = isoDateTime.parse(input.now);
  const status = input.retryable ? "pending" : "failed";
  const fail = database.transaction(() => {
    const result = database
      .query(
        `UPDATE slack_outbox SET status = ?, last_error_code = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE outbox_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        status,
        requiredId(input.errorCode, "errorCode"),
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
      target: input.outboxId,
      action: "slack.outbox.failed",
      result: status,
      correlationId: input.outboxId,
      metadata: { errorCode: input.errorCode, retryable: input.retryable },
      createdAt: now,
    });
  });
  fail.immediate();
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
