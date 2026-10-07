import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { ExecutionAuthorityDenied, requireTaskAuthority } from "../policy/execution.ts";
import type { AgentTagStore, ClaimedOutboxMessage, SlackOutboxPayload } from "../store/store.ts";
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

const OUTBOX_LEASE_MS = 30_000;
const slackPostResponseSchema = z.object({ ts: z.string().min(1) });

/**
 * Claims one outbox row, rechecks authority, and posts it. Every outcome moves the row out of the
 * claimable set (delivered, failed, quarantined, or pending behind `blocked_until`), so calling this
 * in a loop until "idle" never spins on the same row.
 */
export async function deliverNextSlackOutbox(input: {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly workerId: string;
  readonly postMessage: (message: SlackOutboxPayload & { channel: string; thread_ts: string }) => Promise<unknown>;
  readonly now?: () => string;
  readonly retryPolicy?: OutboxRetryPolicy;
  readonly random?: () => number;
}): Promise<SlackOutboxOutcome> {
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
      if (failure.plainTextFallback && claimed.renderMode === "rich") {
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
