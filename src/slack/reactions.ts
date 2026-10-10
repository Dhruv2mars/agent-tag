// Instant ack delivery: claims one queued reaction, rechecks authority, and calls reactions.add.
import type { AgentTagConfig } from "../config.ts";
import { ExecutionAuthorityDenied, requireTaskAuthority } from "../policy/execution.ts";
import type { AgentTagStore } from "../store/store.ts";
import {
  classifySlackDeliveryError,
  isRateLimitFailure,
  outboxRetryDelayMs,
  slackPlatformErrorName,
  type OutboxRetryPolicy,
} from "./outbox-policy.ts";

export type SlackReactionOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "reaction-added"; readonly reactionKey: string; readonly errorCode?: string }
  | {
      readonly kind: "reaction-retry-scheduled";
      readonly reactionKey: string;
      readonly errorCode: string;
      readonly blockedUntil: string;
    }
  | { readonly kind: "reaction-failed"; readonly reactionKey: string; readonly errorCode: string };

export interface SlackReactionAdd {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
}

/** An ack is only useful soon after the mention: a few quick retries, then it is dropped. */
export const REACTION_RETRY_POLICY: OutboxRetryPolicy = { baseDelayMs: 2_000, maxDelayMs: 60_000, maxAttempts: 5 };

const REACTION_LEASE_MS = 30_000;

/**
 * reactions.add rejections that resending can never fix, beyond the shared terminal set (which already
 * has missing_scope, message_not_found, channel_not_found, is_archived, invalid_auth, ...).
 */
const REACTION_TERMINAL_ERRORS = new Set([
  "bad_timestamp",
  "invalid_name",
  "no_item_specified",
  "not_reactable",
  "thread_locked",
  "too_many_emoji",
  "too_many_reactions",
]);

interface DeliverReactionInput {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly workerId: string;
  readonly addReaction: (reaction: SlackReactionAdd) => Promise<unknown>;
  readonly now?: () => string;
  readonly retryPolicy?: OutboxRetryPolicy;
  readonly random?: () => number;
}

/**
 * Claims one reaction and adds it. Every outcome moves the row out of the claimable set (delivered,
 * failed, or pending behind `blocked_until`), so calling this in a loop until "idle" never spins.
 * reactions.add is idempotent (`already_reacted`), so an unknown outcome is retried, not quarantined.
 */
export async function deliverNextSlackReaction(input: DeliverReactionInput): Promise<SlackReactionOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = input.store.claimNextReaction({ workerId: input.workerId, now: now(), leaseMs: REACTION_LEASE_MS });
  if (claimed === null) return { kind: "idle" };
  const settle = { reactionKey: claimed.reactionKey, workerId: input.workerId };
  const fail = (errorCode: string): SlackReactionOutcome => {
    input.store.failReaction({ ...settle, errorCode, now: now() });
    return { kind: "reaction-failed", reactionKey: claimed.reactionKey, errorCode };
  };
  try {
    const task = input.store.getTaskExecution(claimed.taskId);
    requireTaskAuthority({ config: input.config, task });
    if (claimed.conversationId !== task.conversationId) throw new ExecutionAuthorityDenied();
  } catch (error) {
    const outcome = fail(error instanceof Error ? error.name : "SlackDeliveryError");
    if (error instanceof ExecutionAuthorityDenied) return outcome;
    throw error;
  }
  try {
    await input.addReaction({ channel: claimed.conversationId, timestamp: claimed.messageTs, name: claimed.name });
  } catch (error) {
    const platformError = slackPlatformErrorName(error);
    if (platformError === "already_reacted") {
      input.store.markReactionDelivered({ ...settle, errorCode: platformError, now: now() });
      return { kind: "reaction-added", reactionKey: claimed.reactionKey, errorCode: platformError };
    }
    if (platformError !== undefined && REACTION_TERMINAL_ERRORS.has(platformError)) return fail(platformError);
    const failure = classifySlackDeliveryError(error);
    if (failure.kind === "terminal") return fail(failure.errorCode);
    const policy = input.retryPolicy ?? REACTION_RETRY_POLICY;
    if (claimed.attempt >= policy.maxAttempts) return fail(failure.errorCode);
    const retryAfterMs = failure.kind === "retryable" ? failure.retryAfterMs : undefined;
    const delayMs = outboxRetryDelayMs({
      attempt: claimed.attempt,
      policy,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(input.random === undefined ? {} : { random: input.random }),
    });
    const at = now();
    const after = (ms: number): string => new Date(new Date(at).getTime() + ms).toISOString();
    const blockedUntil = after(delayMs);
    input.store.retryReaction({
      ...settle,
      errorCode: failure.errorCode,
      now: at,
      blockedUntil,
      ...(isRateLimitFailure(failure) ? { rateLimitedUntil: after(retryAfterMs ?? delayMs) } : {}),
    });
    return { kind: "reaction-retry-scheduled", reactionKey: claimed.reactionKey, errorCode: failure.errorCode, blockedUntil };
  }
  input.store.markReactionDelivered({ ...settle, now: now() });
  return { kind: "reaction-added", reactionKey: claimed.reactionKey };
}
