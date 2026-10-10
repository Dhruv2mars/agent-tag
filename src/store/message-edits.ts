// Durable Slack message edits: outbox rows with method='update' that chat.update the message their
// target post row posted. Both functions run inside the caller's transaction, so a state change and
// the edit it needs commit atomically.
//
// Coalescing (latest wins): a new edit request rewrites the target's newest pending (unclaimed) edit
// row in place. A new row is added only when no edit is pending, for example while the previous one
// is in flight. Edits of one target are claimed strictly in rowid order, and only once the target
// post is settled (see the invariants on claimNextOutbox). Rowid order is the monotonic revision: the
// last requested edit is always the last one applied, and none is lost.
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { isoDateTime, nonEmpty, outboxIdentitySchema, outboxPayloadSchema, refreshKindSchema } from "./schema.ts";
import type { RefreshKind, SlackOutboxPayload } from "./types.ts";

export { REFRESH_KINDS } from "./schema.ts";
export type { RefreshKind } from "./types.ts";

/** Stored as the payload of refresh rows; never sent, because they render at delivery time. */
const REFRESH_PLACEHOLDER: SlackOutboxPayload = { text: "" };

const editTargetSchema = z.object({
  outbox_id: nonEmpty,
  task_id: nonEmpty,
  correlation_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  method: z.enum(["post", "update"]),
  status: z.enum(["pending", "inflight", "delivered", "failed"]),
});

export type MessageEditResult = { readonly outboxId: string; readonly reused: boolean } | null;

export interface EnqueueMessageRefreshInput {
  /** The post row whose message is edited, for example `${interactionId}:prompt`. */
  readonly targetClientMessageId: string;
  readonly refreshKind: RefreshKind;
  /** The rendered entity, for example an interaction id; stored in correlation_id. */
  readonly refreshKey: string;
  readonly now: string;
  /**
   * Throttle: the edit is not sent before this instant. Coalescing into a pending, never-attempted
   * edit only ever moves its send time earlier (a retry backoff is kept), so a later request cannot
   * delay an earlier one. Absent means due now.
   */
  readonly notBefore?: string;
}

export interface EnqueueMessageEditInput {
  readonly targetClientMessageId: string;
  readonly payload: SlackOutboxPayload;
  readonly now: string;
}

/**
 * Ensures one pending refresh of the message posted by `targetClientMessageId`. The row renders the
 * latest state of (refreshKind, refreshKey) when it is sent, so reusing a pending row loses nothing.
 * Returns null when the target was never enqueued, is not a post, or failed (nothing to edit).
 */
export function enqueueMessageRefresh(database: Database, input: EnqueueMessageRefreshInput): MessageEditResult {
  const refreshKey = requiredId(input.refreshKey, "refreshKey");
  return enqueueEdit(database, {
    targetClientMessageId: input.targetClientMessageId,
    refreshKind: refreshKindSchema.parse(input.refreshKind),
    payload: REFRESH_PLACEHOLDER,
    correlationId: () => refreshKey,
    clientMessageId: () => `${refreshKey}:refresh:${crypto.randomUUID()}`,
    now: input.now,
    notBefore: input.notBefore === undefined ? null : isoDateTime.parse(input.notBefore),
  });
}

/** Static edit: replaces the target message with `payload` as-is. Same coalescing and null cases. */
export function enqueueMessageEdit(database: Database, input: EnqueueMessageEditInput): MessageEditResult {
  return enqueueEdit(database, {
    targetClientMessageId: input.targetClientMessageId,
    refreshKind: null,
    payload: outboxPayloadSchema.parse(input.payload),
    correlationId: (target) => target.correlation_id,
    clientMessageId: (target) => `${target.correlation_id}:edit:${crypto.randomUUID()}`,
    now: input.now,
    notBefore: null,
  });
}

function enqueueEdit(database: Database, input: {
  readonly targetClientMessageId: string;
  readonly refreshKind: RefreshKind | null;
  readonly payload: SlackOutboxPayload;
  readonly correlationId: (target: z.infer<typeof editTargetSchema>) => string;
  readonly clientMessageId: (target: z.infer<typeof editTargetSchema>) => string;
  readonly now: string;
  readonly notBefore: string | null;
}): MessageEditResult {
  const now = isoDateTime.parse(input.now);
  const target = editTargetSchema.nullable().parse(
    database
      .query(
        `SELECT outbox_id, task_id, correlation_id, conversation_id, thread_ts, method, status
         FROM slack_outbox WHERE client_message_id = ?`,
      )
      .get(requiredId(input.targetClientMessageId, "targetClientMessageId")),
  );
  if (target === null || target.method !== "post" || target.status === "failed") return null;
  const correlationId = input.correlationId(target);
  const audit = (outboxId: string, result: string): void =>
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "slack-write",
      source: correlationId,
      target: outboxId,
      action: "slack.outbox.enqueued",
      result,
      correlationId,
      metadata: { method: "update", refreshKind: input.refreshKind, targetOutboxId: target.outbox_id },
      createdAt: now,
    });

  const pending = outboxIdentitySchema.nullable().parse(
    database
      .query(
        `SELECT outbox_id FROM slack_outbox
         WHERE method = 'update' AND target_outbox_id = ? AND status = 'pending'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(target.outbox_id),
  );
  if (pending !== null) {
    database
      .query(
        `UPDATE slack_outbox SET payload_json = ?1, refresh_kind = ?2, correlation_id = ?3, updated_at = ?4,
           blocked_until = CASE
             WHEN attempts = 0 AND blocked_until IS NOT NULL
               AND (?5 IS NULL OR julianday(?5) < julianday(blocked_until)) THEN ?5
             ELSE blocked_until END
         WHERE outbox_id = ?6 AND status = 'pending'`,
      )
      .run(JSON.stringify(input.payload), input.refreshKind, correlationId, now, input.notBefore, pending.outbox_id);
    audit(pending.outbox_id, "coalesced");
    return { outboxId: pending.outbox_id, reused: true };
  }

  const outboxId = crypto.randomUUID();
  insertOutboxMessage(database, {
    outboxId,
    taskId: target.task_id,
    correlationId,
    conversationId: target.conversation_id,
    threadTs: target.thread_ts,
    clientMessageId: input.clientMessageId(target),
    payload: input.payload,
    createdAt: now,
    edit: { targetOutboxId: target.outbox_id, refreshKind: input.refreshKind },
    blockedUntil: input.notBefore,
  });
  audit(outboxId, "pending");
  return { outboxId, reused: false };
}
