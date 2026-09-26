import { z } from "zod";

import type { AgentTagStore } from "./store/store.ts";
import {
  dispatchT3Command,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
} from "./t3/gateway.ts";

const approvalResponseSchema = z.object({
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
});
const userInputResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), answers: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("dismiss") }),
]);

export interface T3InteractionGateway {
  readonly dispatch: (command: T3Command) => Promise<T3DispatchResult>;
}

export type InteractionWorkerOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "resolved"; readonly interactionId: string }
  | { readonly kind: "failed"; readonly interactionId: string; readonly errorCode: string }
  | { readonly kind: "retry-scheduled"; readonly interactionId: string; readonly errorCode: string };

export class InteractionWorker {
  readonly #store: AgentTagStore;
  readonly #t3: T3InteractionGateway;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #now: () => Date;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly t3Config?: T3ConnectionConfig;
    readonly t3?: T3InteractionGateway;
    readonly workerId?: string;
    readonly leaseMs?: number;
    readonly now?: () => Date;
  }) {
    this.#store = input.store;
    if (input.t3 !== undefined) {
      this.#t3 = input.t3;
    } else {
      if (input.t3Config === undefined) throw new Error("InteractionWorker requires t3 or t3Config");
      const t3Config = input.t3Config;
      this.#t3 = { dispatch: (command) => dispatchT3Command({ config: t3Config, command }) };
    }
    this.#workerId = input.workerId ?? `interaction-worker-${crypto.randomUUID()}`;
    this.#leaseMs = input.leaseMs ?? 30_000;
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
        command = {
          type: "thread.turn.interrupt",
          commandId: response.commandId,
          threadId: response.threadId,
          createdAt: this.#now().toISOString(),
        };
      }
      await this.#t3.dispatch(command);
      this.#store.completeInteractionResponse({
        interactionId: response.interactionId,
        workerId: this.#workerId,
        now: this.#now().toISOString(),
      });
      return { kind: "resolved", interactionId: response.interactionId };
    } catch (error) {
      const code = error instanceof Error && error.name ? error.name : "InteractionDispatchError";
      const retryable = !(error instanceof z.ZodError);
      this.#store.failInteractionResponse({
        interactionId: response.interactionId,
        workerId: this.#workerId,
        errorCode: code,
        retryable,
        now: this.#now().toISOString(),
      });
      return {
        kind: retryable ? "retry-scheduled" : "failed",
        interactionId: response.interactionId,
        errorCode: code,
      };
    }
  }
}
