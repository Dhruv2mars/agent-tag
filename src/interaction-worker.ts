import { z } from "zod";

import type { AgentTagConfig } from "./config.ts";
import { T3_TURN_ENDED_FAILURE_CODES } from "./coordinator.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "./policy/execution.ts";
import type { AgentTagStore, ClaimedInteractionResponse } from "./store/store.ts";
import { classifyT3DispatchError } from "./t3/dispatch-errors.ts";
import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  T3ThreadNotFoundError,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
  type T3ThreadSnapshot,
} from "./t3/gateway.ts";

const approvalResponseSchema = z.object({
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
});
const userInputResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    answers: z.record(z.string(), z.unknown()),
    contributors: z.array(z.string().min(1)).optional(),
  }),
  z.object({ kind: z.literal("dismiss") }),
]);

export interface T3InteractionGateway {
  readonly dispatch: (command: T3Command) => Promise<T3DispatchResult>;
  /** Reads the thread so a cancel can find a turn whose start receipt was lost. */
  readonly fetchThread: (threadId: string) => Promise<T3ThreadSnapshot>;
}

export type InteractionWorkerOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "resolved"; readonly interactionId: string }
  | { readonly kind: "failed"; readonly interactionId: string; readonly errorCode: string }
  | {
      readonly kind: "retry-scheduled";
      readonly interactionId: string;
      readonly errorCode: string;
      readonly blockedUntil: string;
    };

/** Capped exponential backoff for retryable T3 dispatch failures. */
export interface InteractionRetryPolicy {
  /** Delay after the first failed attempt; doubles per attempt. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Claims (including the first) before the response is marked failed. */
  readonly maxAttempts: number;
}

export const DEFAULT_INTERACTION_RETRY_POLICY: InteractionRetryPolicy = {
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  maxAttempts: 8,
};

/**
 * How long after the latest `thread.turn.start` a missing T3 thread or message may still appear,
 * because a detached worktree bootstrap (git fetch, thread create) is still running. Until then a
 * cancel for a failed operation stays pending instead of being settled as never received.
 */
export const T3_BOOTSTRAP_WINDOW_MS = 15 * 60_000;

export const NO_LONGER_PENDING_NOTICE = "This request is no longer pending.";
export const RETRIES_EXHAUSTED_NOTICE =
  "Agent Tag could not deliver this response to T3 after several attempts. Ask the operator to check service diagnostics.";

/**
 * The user message T3 0.0.45 creates for a message-mode answer to `requestId`; it starts the
 * operation's continuation turn (decider.ts `thread.user-input.respond`).
 */
function asyncAnswerMessageId(requestId: string): string {
  return `async-answer:${requestId}`;
}

export function interactionRetryDelayMs(policy: InteractionRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

function validateRetryPolicy(policy: InteractionRetryPolicy): InteractionRetryPolicy {
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs <= 0) {
    throw new Error("retry baseDelayMs must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("retry maxDelayMs must be an integer of at least baseDelayMs");
  }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new Error("retry maxAttempts must be a positive integer");
  }
  return policy;
}

/** A failure decided before or instead of a T3 dispatch, with its own terminal/retry semantics. */
class InteractionSettled extends Error {
  constructor(
    readonly code: string,
    readonly terminal: boolean,
  ) {
    super(code);
    this.name = code;
  }
}

export class InteractionWorker {
  readonly #store: AgentTagStore;
  readonly #config: AgentTagConfig;
  readonly #t3: T3InteractionGateway;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #retry: InteractionRetryPolicy;
  readonly #now: () => Date;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly config: AgentTagConfig;
    readonly t3Config?: T3ConnectionConfig;
    readonly t3?: T3InteractionGateway;
    readonly workerId?: string;
    readonly leaseMs?: number;
    readonly retry?: InteractionRetryPolicy;
    readonly now?: () => Date;
  }) {
    this.#store = input.store;
    this.#config = input.config;
    if (input.t3 !== undefined) {
      this.#t3 = input.t3;
    } else {
      if (input.t3Config === undefined) throw new Error("InteractionWorker requires t3 or t3Config");
      const t3Config = input.t3Config;
      this.#t3 = {
        dispatch: (command) => dispatchT3Command({ config: t3Config, command }),
        fetchThread: (threadId) => fetchT3ThreadSnapshot({ config: t3Config, threadId }),
      };
    }
    this.#workerId = input.workerId ?? `interaction-worker-${crypto.randomUUID()}`;
    this.#leaseMs = input.leaseMs ?? 30_000;
    this.#retry = validateRetryPolicy(input.retry ?? DEFAULT_INTERACTION_RETRY_POLICY);
    this.#now = input.now ?? (() => new Date());
  }

  async processNext(): Promise<InteractionWorkerOutcome> {
    const response = this.#store.claimNextInteractionResponse({
      workerId: this.#workerId,
      now: this.#now().toISOString(),
      leaseMs: this.#leaseMs,
    });
    if (response === null) return { kind: "idle" };
    try {
      requireExecutionAuthority({
        config: this.#config,
        task: this.#store.getTaskExecution(response.taskId),
        actorUserId: response.actorUserId,
      });
      let command: T3Command;
      if (response.kind === "approval") {
        const parsed = approvalResponseSchema.parse(response.response);
        command = {
          type: "thread.approval.respond",
          commandId: response.commandId,
          threadId: response.threadId,
          requestId: response.requestId,
          decision: parsed.decision,
          createdAt: this.#now().toISOString(),
        };
      } else if (response.kind === "user-input") {
        const parsed = userInputResponseSchema.parse(response.response);
        // Every person who answered part of a multi-question request must still be authorized.
        if (parsed.kind === "answer") {
          const task = this.#store.getTaskExecution(response.taskId);
          for (const contributor of parsed.contributors ?? []) {
            requireExecutionAuthority({ config: this.#config, task, actorUserId: contributor });
          }
        }
        command =
          parsed.kind === "dismiss"
            ? {
                type: "thread.user-input.dismiss",
                commandId: response.commandId,
                threadId: response.threadId,
                requestId: response.requestId,
                createdAt: this.#now().toISOString(),
              }
            : {
                type: "thread.user-input.respond",
                commandId: response.commandId,
                threadId: response.threadId,
                requestId: response.requestId,
                answers: parsed.answers,
                createdAt: this.#now().toISOString(),
              };
      } else {
        command = await this.#interruptCommand(response);
      }
      await this.#t3.dispatch(command);
      this.#store.completeInteractionResponse({
        interactionId: response.interactionId,
        workerId: this.#workerId,
        now: this.#now().toISOString(),
      });
      return { kind: "resolved", interactionId: response.interactionId };
    } catch (error) {
      return this.#fail(response, error);
    }
  }

  // Cancellation invariants. Every path through #interruptCommand, #ownRunningTurn, and #fail must keep
  // these; the store side (requestTaskCancellation; complete/failInteractionResponse for 7) keeps 5-7.
  //  1. Never interrupt a turn the operation does not own. T3 0.0.45 ignores the interrupt's turn id
  //     and stops whatever the provider session is running, so every interrupt is preceded by a
  //     thread snapshot whose current turn (latestTurn, and session.activeTurnId when set) is this
  //     operation's and still running. A stored turn id alone is not enough: a newer turn may have
  //     replaced it. The check-then-dispatch gap is unavoidable with T3's API and kept to one RPC.
  //     The operation owns its recorded turn, the turn started from its own message, and every
  //     continuation turn T3 starts from a message-mode answer to one of its questions (user
  //     message `async-answer:<requestId>`, decider.ts `thread.user-input.respond`). Approval and
  //     callback-mode answers resume the same provider turn, so they need no extra tracking. A
  //     continuation counts only if its message precedes every other user message after the
  //     operation's own, so a newer operation's turn (or one it steered) is never the operation's.
  //  2. Never settle locally while T3 could still start the operation's turn. Terminal settlement
  //     needs proof: the turn was never sent, T3 reported or shows it ended, a later turn replaced
  //     it, or T3 shows neither the thread nor the message after the bootstrap window measured from
  //     the latest `thread.turn.start` (a detached worktree bootstrap may still create both).
  //  3. A live operation's cancel waits (retryably) for the coordinator to confirm the turn start.
  //  4. Retries are bounded by maxAttempts; exhaustion is recoverable: a fresh click requeues the same
  //     cancellation and command id, so T3's command-id dedup also covers a lost interrupt receipt.
  //  5. Redeliveries of an accepted click stay duplicates and never target a later operation.
  //  6. An operation that never sent `thread.turn.start` is cancelled in the store, never in T3.
  //  7. Every cancel settlement unblocks its operation. Delivery, a no-op settle (OperationNotRunning,
  //     including absence past the bootstrap window), a T3 rejection, invalid input, revoked authority,
  //     and exhausted retries all clear the operation's blocked_until in the settling transaction, so
  //     the coordinator can observe and finalize an ended turn instead of waiting out a deferral. A
  //     scheduled retry is not a settlement and leaves the operation blocked.

  /**
   * Builds the interrupt for a cancel, or settles it. An operation whose T3 turn is confirmed ended,
   * or was never sent, has nothing left to cancel. A live operation whose turn has not been confirmed
   * yet is retried until the coordinator starts (and records) it. Everything else, including a locally
   * failed operation whose turn may still be running, is checked against the T3 thread first.
   */
  async #interruptCommand(response: ClaimedInteractionResponse): Promise<T3Command> {
    const live = response.operationStatus === "pending" || response.operationStatus === "inflight";
    if (!live) {
      const remoteEnded = response.operationStatus === "succeeded" ||
        (response.operationErrorCode !== null && T3_TURN_ENDED_FAILURE_CODES.has(response.operationErrorCode));
      // A failed operation is never replayed, so an unsent turn will not be recorded later.
      if (remoteEnded || !response.turnDispatched) throw new InteractionSettled("OperationNotRunning", true);
    } else if (!response.turnStarted) {
      throw new InteractionSettled("T3TurnNotStarted", false);
    }
    const turnId = await this.#ownRunningTurn(response);
    return {
      type: "thread.turn.interrupt",
      commandId: response.commandId,
      threadId: response.threadId,
      turnId,
      createdAt: this.#now().toISOString(),
    };
  }

  /**
   * Returns the id of this operation's turn when it is the T3 thread's current, running turn, which
   * is the only turn T3's session-wide interrupt may stop. The operation's turns are its recorded
   * turn, the turn of its own message, and continuation turns from message-mode answers to its
   * questions (invariant 1). Settles the cancel when none of them is current and running, and
   * retries while T3 holds one of its messages without having started the turn or (within the
   * bootstrap window) does not show the thread or message yet.
   */
  async #ownRunningTurn(response: ClaimedInteractionResponse): Promise<string> {
    let snapshot: T3ThreadSnapshot;
    try {
      snapshot = await this.#t3.fetchThread(response.threadId);
    } catch (error) {
      if (error instanceof T3ThreadNotFoundError) this.#settleAbsent(response);
      throw error;
    }
    const latest = snapshot.thread.latestTurn;
    const activeTurnId = snapshot.thread.session?.activeTurnId ?? null;
    const isCurrentRunning = (turnId: string): boolean =>
      latest !== null && latest.turnId === turnId && latest.state === "running" &&
      (activeTurnId === null || activeTurnId === turnId);
    if (response.turnId !== null && isCurrentRunning(response.turnId)) return response.turnId;
    const userMessages = snapshot.thread.messages.filter((message) => message.role === "user");
    const message = userMessages.find((candidate) => candidate.id === response.operationMessageId);
    if (message === undefined) {
      // A recorded turn proves T3 created the thread and message; neither is current any more.
      if (response.turnId !== null) throw new InteractionSettled("OperationNotRunning", true);
      this.#settleAbsent(response);
    }
    const timeOf = (candidate: { readonly createdAt: string }): number => new Date(candidate.createdAt).getTime();
    const sentAt = timeOf(message);
    const continuationIds = new Set(response.userInputRequestIds.map(asyncAnswerMessageId));
    const laterMessages = userMessages.filter((candidate) => timeOf(candidate) > sentAt);
    // The first user message after ours that no answer of ours produced: a newer operation's.
    const foreignAt = laterMessages
      .filter((candidate) => !continuationIds.has(candidate.id))
      .map(timeOf)
      .reduce((earliest, createdAt) => Math.min(earliest, createdAt), Number.POSITIVE_INFINITY);
    const ownedMessages = [
      message,
      ...laterMessages.filter((candidate) => continuationIds.has(candidate.id) && timeOf(candidate) < foreignAt),
    ];
    const requestedAt = latest === null ? null : new Date(latest.requestedAt).getTime();
    // A message's turn is the one T3 tied it to, or else one requested after it and before any
    // newer operation's message.
    const latestIsOurs = latest !== null && requestedAt !== null && (latest.turnId === response.turnId ||
      ownedMessages.some((owned) => owned.turnId !== null
        ? owned.turnId === latest.turnId
        : requestedAt >= timeOf(owned) && requestedAt < foreignAt));
    if (latestIsOurs && isCurrentRunning(latest.turnId)) return latest.turnId;
    // T3 accepted a message of ours after the latest turn was requested and has not started its
    // turn yet; with no newer operation's message since, that turn will be ours.
    const awaitingStart = foreignAt === Number.POSITIVE_INFINITY && ownedMessages.some((owned) =>
      owned.turnId === null && (requestedAt === null || timeOf(owned) > requestedAt));
    if (awaitingStart) throw new InteractionSettled("T3TurnNotStarted", false);
    // Our turns ended, or a newer operation's turn is current: interrupting would stop that one.
    throw new InteractionSettled("OperationNotRunning", true);
  }

  /**
   * T3 shows neither this operation's message nor (for a 404) its thread. T3 0.0.45 runs a new
   * thread's worktree bootstrap in a detached fiber that outlives a dropped connection and creates
   * the thread and message only after fetching the base branch, so absence proves nothing until the
   * bootstrap window after the latest `thread.turn.start` has passed.
   */
  #settleAbsent(response: ClaimedInteractionResponse): never {
    const dispatchedAt = response.turnDispatchedAt === null ? Number.NaN : Date.parse(response.turnDispatchedAt);
    if (!(this.#now().getTime() - dispatchedAt >= T3_BOOTSTRAP_WINDOW_MS)) {
      throw new InteractionSettled("T3TurnNotStarted", false);
    }
    throw new InteractionSettled("OperationNotRunning", true);
  }

  #fail(response: ClaimedInteractionResponse, error: unknown): InteractionWorkerOutcome {
    const now = this.#now();
    let code: string;
    let terminal: boolean;
    let notice: string | undefined;
    let retriesExhausted = false;
    if (error instanceof z.ZodError || error instanceof ExecutionAuthorityDenied) {
      // Invalid stored input or revoked authority: never deliverable, and nothing to tell the thread.
      code = error.name;
      terminal = true;
    } else if (error instanceof InteractionSettled) {
      code = error.code;
      terminal = error.terminal;
      notice = NO_LONGER_PENDING_NOTICE;
    } else {
      const classified = classifyT3DispatchError(error);
      code = classified.code;
      terminal = classified.kind === "rejected";
      notice = NO_LONGER_PENDING_NOTICE;
    }
    if (!terminal && response.attempt >= this.#retry.maxAttempts) {
      terminal = true;
      notice = RETRIES_EXHAUSTED_NOTICE;
      retriesExhausted = true;
    }
    if (terminal) {
      this.#store.failInteractionResponse({
        interactionId: response.interactionId,
        workerId: this.#workerId,
        errorCode: code,
        retryable: false,
        ...(notice === undefined ? {} : { notice }),
        ...(retriesExhausted ? { retriesExhausted } : {}),
        now: now.toISOString(),
      });
      return { kind: "failed", interactionId: response.interactionId, errorCode: code };
    }
    const blockedUntil = new Date(
      now.getTime() + interactionRetryDelayMs(this.#retry, response.attempt),
    ).toISOString();
    this.#store.failInteractionResponse({
      interactionId: response.interactionId,
      workerId: this.#workerId,
      errorCode: code,
      retryable: true,
      blockedUntil,
      now: now.toISOString(),
    });
    return { kind: "retry-scheduled", interactionId: response.interactionId, errorCode: code, blockedUntil };
  }
}
