import { z } from "zod";

import type { AgentTagConfig } from "./config.ts";
import { T3_TURN_ENDED_FAILURE_CODES } from "./coordinator.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "./policy/execution.ts";
import type { AgentTagStore, ClaimedInteractionResponse } from "./store/store.ts";
import { classifyT3DispatchError } from "./t3/dispatch-errors.ts";
import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
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

export const NO_LONGER_PENDING_NOTICE = "This request is no longer pending.";
export const RETRIES_EXHAUSTED_NOTICE =
  "Agent Tag could not deliver this response to T3 after several attempts. Ask the operator to check service diagnostics.";

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

  /**
   * Interrupts only a turn this operation actually started, naming it when the turn id is known.
   * An operation whose T3 turn is confirmed ended has nothing left to cancel. A locally failed one
   * (for example after the settlement timeout) may still be running in T3, so its started turn is
   * interrupted anyway. A failed operation whose `thread.turn.start` was sent but never confirmed
   * (every receipt lost) is reconciled against the T3 thread. A live operation whose turn has not
   * been confirmed yet is retried with backoff until the coordinator starts (and records) it.
   */
  async #interruptCommand(response: ClaimedInteractionResponse): Promise<T3Command> {
    const live = response.operationStatus === "pending" || response.operationStatus === "inflight";
    let turnId = response.turnId;
    if (!live) {
      const remoteEnded = response.operationStatus === "succeeded" ||
        (response.operationErrorCode !== null && T3_TURN_ENDED_FAILURE_CODES.has(response.operationErrorCode));
      // A failed operation is never replayed, so an unsent turn will not be recorded later.
      if (remoteEnded || !response.turnDispatched) throw new InteractionSettled("OperationNotRunning", true);
      if (!response.turnStarted) turnId = await this.#reconcileUnconfirmedTurn(response);
    } else if (!response.turnStarted) {
      throw new InteractionSettled("T3TurnNotStarted", false);
    }
    return {
      type: "thread.turn.interrupt",
      commandId: response.commandId,
      threadId: response.threadId,
      ...(turnId === null ? {} : { turnId }),
      createdAt: this.#now().toISOString(),
    };
  }

  /**
   * Finds, in T3, the turn of a failed operation whose start was sent but never confirmed. Returns
   * its id when it is still running. Settles the cancel when T3 never received the message or the
   * turn already ended, and retries while T3 holds the message without having started its turn.
   */
  async #reconcileUnconfirmedTurn(response: ClaimedInteractionResponse): Promise<string> {
    const snapshot = await this.#t3.fetchThread(response.threadId);
    const userMessages = snapshot.thread.messages.filter((message) => message.role === "user");
    const message = userMessages.find((candidate) => candidate.id === response.operationMessageId);
    if (message === undefined) throw new InteractionSettled("OperationNotRunning", true);
    const latest = snapshot.thread.latestTurn;
    const sentAt = new Date(message.createdAt).getTime();
    const nextMessageAt = userMessages
      .map((candidate) => new Date(candidate.createdAt).getTime())
      .filter((createdAt) => createdAt > sentAt)
      .reduce((earliest, createdAt) => Math.min(earliest, createdAt), Number.POSITIVE_INFINITY);
    const requestedAt = latest === null ? null : new Date(latest.requestedAt).getTime();
    // The latest turn is this operation's when T3 tied the message to it, or when it was requested
    // after this message and before any later one.
    const latestIsOurs = latest !== null && (message.turnId !== null
      ? message.turnId === latest.turnId
      : requestedAt !== null && requestedAt >= sentAt && requestedAt < nextMessageAt);
    if (latestIsOurs) {
      if (latest.state === "running") return latest.turnId;
      throw new InteractionSettled("OperationNotRunning", true);
    }
    // T3 tied the message to an older turn, or a later message's turn is current: ours has ended.
    if (message.turnId !== null || nextMessageAt !== Number.POSITIVE_INFINITY) {
      throw new InteractionSettled("OperationNotRunning", true);
    }
    throw new InteractionSettled("T3TurnNotStarted", false);
  }

  #fail(response: ClaimedInteractionResponse, error: unknown): InteractionWorkerOutcome {
    const now = this.#now();
    let code: string;
    let terminal: boolean;
    let notice: string | undefined;
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
    }
    if (terminal) {
      this.#store.failInteractionResponse({
        interactionId: response.interactionId,
        workerId: this.#workerId,
        errorCode: code,
        retryable: false,
        ...(notice === undefined ? {} : { notice }),
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
