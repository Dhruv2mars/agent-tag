import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { ExecutionAuthorityDenied, requireTaskAuthority } from "../policy/execution.ts";
import type { AgentTagStore, ClaimedOutboxMessage, RefreshKind, SlackOutboxPayload } from "../store/store.ts";
import {
  classifySlackDeliveryError,
  DEFAULT_OUTBOX_RETRY_POLICY,
  isRateLimitFailure,
  outboxRetryDelayMs,
  plainTextFallback,
  type OutboxRetryPolicy,
  type SlackDeliveryFailure,
} from "./outbox-policy.ts";

export type SlackOutboxOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "delivered"; readonly outboxId: string }
  | { readonly kind: "retry-scheduled"; readonly outboxId: string; readonly errorCode: string; readonly blockedUntil: string }
  | { readonly kind: "fallback-scheduled"; readonly outboxId: string; readonly errorCode: string }
  | { readonly kind: "retry-exhausted"; readonly outboxId: string; readonly errorCode: string }
  | { readonly kind: "quarantined"; readonly outboxId: string; readonly errorCode: string }
  | { readonly kind: "failed"; readonly outboxId: string; readonly errorCode: string };

/** A chat.update call. `blocks` is always sent: Slack keeps a message's old blocks when it is omitted. */
export interface SlackMessageUpdate {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly blocks: NonNullable<SlackOutboxPayload["blocks"]>;
}

/** Renders a refresh row's message from current state at delivery time; null when its source is gone. */
export type RefreshRenderer = (refreshKey: string) => SlackOutboxPayload | null;

/**
 * Delivery-time renderers by refresh kind. Additive: each kind's PR registers one renderer (PR-I I2
 * "interaction-card", PR-F "status-message"). A refresh row whose kind has none fails.
 */
export type RefreshRenderers = Partial<Readonly<Record<RefreshKind, RefreshRenderer>>>;

const OUTBOX_LEASE_MS = 30_000;
const slackPostResponseSchema = z.object({ ts: z.string().min(1) });

interface DeliverInput {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly workerId: string;
  readonly postMessage: (message: SlackOutboxPayload & { channel: string; thread_ts: string }) => Promise<unknown>;
  readonly updateMessage: (message: SlackMessageUpdate) => Promise<unknown>;
  readonly refreshRenderers?: RefreshRenderers;
  readonly now?: () => string;
  readonly retryPolicy?: OutboxRetryPolicy;
  readonly random?: () => number;
}

/**
 * Claims one outbox row, rechecks authority, and posts it (or, for an edit row, updates the message
 * its target post row posted). Every outcome moves the row out of the claimable set (delivered,
 * failed, quarantined, or pending behind `blocked_until`), so calling this in a loop until "idle"
 * never spins on the same row.
 */
export async function deliverNextSlackOutbox(input: DeliverInput): Promise<SlackOutboxOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = input.store.claimNextOutbox({ workerId: input.workerId, now: now(), leaseMs: OUTBOX_LEASE_MS });
  if (claimed === null) return { kind: "idle" };
  const settle = { outboxId: claimed.outboxId, workerId: input.workerId };
  try {
    const task = input.store.getTaskExecution(claimed.taskId);
    requireTaskAuthority({ config: input.config, task });
    if (claimed.conversationId !== task.conversationId) throw new ExecutionAuthorityDenied();
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "SlackDeliveryError";
    input.store.failOutbox({ ...settle, errorCode, now: now() });
    if (error instanceof ExecutionAuthorityDenied) return { kind: "failed", outboxId: claimed.outboxId, errorCode };
    throw error;
  }
  if (claimed.method === "update") return deliverEdit(input, claimed, now);

  const payload = claimed.renderMode === "plain" ? plainTextFallback(claimed.payload) : claimed.payload;
  let response: unknown;
  try {
    response = await input.postMessage({ channel: claimed.conversationId, thread_ts: claimed.threadTs, ...payload });
  } catch (error) {
    return settleFailure(input, claimed, classifySlackDeliveryError(error), now());
  }
  const parsed = slackPostResponseSchema.safeParse(response);
  if (!parsed.success) {
    // Slack answered without a message ts: it may have posted, so never resend.
    return settleFailure(input, claimed, { kind: "ambiguous", errorCode: "invalid_response" }, now());
  }
  input.store.markOutboxDelivered({ ...settle, slackMessageTs: parsed.data.ts, now: now() });
  return { kind: "delivered", outboxId: claimed.outboxId };
}

/**
 * chat.update of the target post's message. The claim only hands out an edit once its target post is
 * settled (see claimNextOutbox), so the target is delivered or failed here. Refresh rows render the
 * current state now, so a retry never regresses the message.
 */
async function deliverEdit(input: DeliverInput, claimed: ClaimedOutboxMessage, now: () => string): Promise<SlackOutboxOutcome> {
  const settle = { outboxId: claimed.outboxId, workerId: input.workerId };
  const fail = (errorCode: string): SlackOutboxOutcome => {
    input.store.failOutbox({ ...settle, errorCode, now: now() });
    return { kind: "failed", outboxId: claimed.outboxId, errorCode };
  };
  const target = claimed.target;
  // A failed or quarantined post has no message to edit.
  if (target?.status !== "delivered" || target.slackMessageTs === null) return fail("TargetNotDelivered");

  let payload = claimed.payload;
  if (claimed.refreshKind !== null) {
    const render = input.refreshRenderers?.[claimed.refreshKind];
    if (render === undefined) return fail("RefreshKindUnsupported");
    let rendered: SlackOutboxPayload | null;
    try {
      rendered = render(claimed.correlationId);
    } catch (error) {
      fail("RefreshRenderFailed");
      throw error;
    }
    if (rendered === null) return fail("RefreshSourceMissing");
    payload = rendered;
  }
  try {
    await input.updateMessage({
      channel: claimed.conversationId,
      ts: target.slackMessageTs,
      text: payload.text,
      blocks: payload.blocks ?? [],
    });
  } catch (error) {
    return settleFailure(input, claimed, classifySlackDeliveryError(error), now());
  }
  input.store.markOutboxDelivered({ ...settle, slackMessageTs: target.slackMessageTs, now: now() });
  return { kind: "delivered", outboxId: claimed.outboxId };
}

function settleFailure(
  input: {
    readonly store: AgentTagStore;
    readonly workerId: string;
    readonly retryPolicy?: OutboxRetryPolicy;
    readonly random?: () => number;
  },
  claimed: ClaimedOutboxMessage,
  failure: SlackDeliveryFailure,
  now: string,
): SlackOutboxOutcome {
  const settle = { outboxId: claimed.outboxId, workerId: input.workerId, errorCode: failure.errorCode, now };
  const outcome = { outboxId: claimed.outboxId, errorCode: failure.errorCode };
  switch (failure.kind) {
    case "retryable": {
      const policy = input.retryPolicy ?? DEFAULT_OUTBOX_RETRY_POLICY;
      const delayMs = outboxRetryDelayMs({
        attempt: claimed.attempt,
        policy,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        ...(input.random === undefined ? {} : { random: input.random }),
      });
      const after = (ms: number): string => new Date(new Date(now).getTime() + ms).toISOString();
      // A rate limit pauses every row (other threads, other channels) for Slack's Retry-After, or for
      // this row's backoff when Slack gave none, so queued rows don't burn their attempts meanwhile.
      const cooldown = isRateLimitFailure(failure) ? { rateLimitedUntil: after(failure.retryAfterMs ?? delayMs) } : {};
      if (claimed.attempt >= policy.maxAttempts) {
        input.store.exhaustOutboxRetries({ ...settle, attempts: claimed.attempt, ...cooldown });
        return { kind: "retry-exhausted", ...outcome };
      }
      const blockedUntil = after(delayMs);
      input.store.retryOutbox({ ...settle, blockedUntil, ...cooldown });
      return { kind: "retry-scheduled", ...outcome, blockedUntil };
    }
    case "terminal":
      // Edits get no plain-text fallback: the message stays as last rendered.
      if (failure.plainTextFallback && claimed.renderMode === "rich" && claimed.method === "post") {
        input.store.scheduleOutboxFallback(settle);
        return { kind: "fallback-scheduled", ...outcome };
      }
      input.store.failOutbox(settle);
      return { kind: "failed", ...outcome };
    case "ambiguous":
      input.store.quarantineOutbox(settle);
      return { kind: "quarantined", ...outcome };
  }
}
