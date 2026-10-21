// `!restart` completion (PR-H2). A restart requested while a turn held the session gates the task's
// queue; this worker rotates the task to a fresh T3 thread once that turn has ended (or, after
// `commands.restartTimeoutSeconds`, anyway) and posts the confirmation. It also stops the provider
// session of every retired T3 thread (`thread.session.stop`, stable command ids so a replay is
// idempotent); PR-N2 deletes the threads and worktrees later.
import { restartReadyReply } from "./commands/replies.ts";
import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore } from "./store/store.ts";
import { classifyT3DispatchError } from "./t3/dispatch-errors.ts";
import type { T3Command } from "./t3/gateway.ts";

export type RestartWorkerOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "progressed"; readonly rotated: number; readonly sessionsStopped: number };

const SWEEP_INTERVAL_MS = 1_000;
const SESSION_STOP_BACKOFF_MS = 30_000;
const BATCH = 20;

export class TaskRestartWorker {
  readonly #store: AgentTagStore;
  readonly #config: () => AgentTagConfig;
  readonly #dispatch: (command: T3Command) => Promise<unknown>;
  readonly #now: () => Date;
  #nextSweepAt = 0;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly config: () => AgentTagConfig;
    readonly dispatch: (command: T3Command) => Promise<unknown>;
    readonly now?: () => Date;
  }) {
    this.#store = input.store;
    this.#config = input.config;
    this.#dispatch = input.dispatch;
    this.#now = input.now ?? (() => new Date());
  }

  async processNext(): Promise<RestartWorkerOutcome> {
    const current = this.#now();
    if (current.getTime() < this.#nextSweepAt) return { kind: "idle" };
    this.#nextSweepAt = current.getTime() + SWEEP_INTERVAL_MS;
    const config = this.#config();
    const now = current.toISOString();
    let rotated = 0;
    for (const pending of this.#store.listPendingRestarts({ now, limit: BATCH })) {
      const forced = !pending.ready &&
        current.getTime() - Date.parse(pending.requestedAt) >= config.commands.restartTimeoutSeconds * 1_000;
      if (!pending.ready && !forced) continue;
      const profile = config.profiles.find((candidate) => candidate.id === pending.profileId);
      const done = this.#store.completeTaskRestart({
        taskId: pending.taskId,
        commandKey: pending.commandKey,
        forced,
        ready: restartReadyReply({
          actorUserId: pending.requestedBy,
          rereads: profile?.threadContext.enabled ?? false,
          forced,
        }),
        now,
      });
      if (done) rotated += 1;
    }
    let sessionsStopped = 0;
    // Session stops need T3; on a transport failure the rest wait for the next sweep.
    for (const stop of this.#store.listPendingSessionStops({ now, limit: BATCH })) {
      try {
        await this.#dispatch({ type: "thread.session.stop", commandId: stop.commandId, threadId: stop.threadId, createdAt: now });
        this.#store.recordSessionStop({ taskId: stop.taskId, generation: stop.generation, outcome: "stopped", now });
        sessionsStopped += 1;
      } catch (error) {
        const failure = classifyT3DispatchError(error);
        if (failure.kind === "rejected") {
          // An unknown or deleted thread has no session to stop: nothing will change on retry.
          this.#store.recordSessionStop({ taskId: stop.taskId, generation: stop.generation, outcome: "rejected", errorCode: failure.code, now });
          continue;
        }
        this.#store.recordSessionStop({
          taskId: stop.taskId,
          generation: stop.generation,
          outcome: "retry",
          errorCode: failure.code,
          retryAt: new Date(current.getTime() + SESSION_STOP_BACKOFF_MS).toISOString(),
          now,
        });
        break;
      }
    }
    return rotated + sessionsStopped === 0 ? { kind: "idle" } : { kind: "progressed", rotated, sessionsStopped };
  }
}
