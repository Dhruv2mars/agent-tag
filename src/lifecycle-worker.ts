// Task lifecycle sweep (PR-N1): closes tasks idle past `lifecycle.closeIdleAfterHours`, and tasks an
// operator asked to close once their in-flight work settles. Idle close is silent, like Claude Tag's
// sandbox release. The retired T3 thread is recorded for the PR-N2 cleanup worker; nothing in T3 or
// git is touched here. A store-only maintenance worker, so it runs while T3 is down.
import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore } from "./store/store.ts";

export type LifecycleWorkerOutcome = { readonly kind: "idle" } | { readonly kind: "tasks-closed"; readonly count: number };

export class LifecycleWorker {
  readonly #store: AgentTagStore;
  readonly #policy: AgentTagConfig["lifecycle"];
  readonly #now: () => Date;
  #nextSweepAt = 0;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly policy: AgentTagConfig["lifecycle"];
    readonly now?: () => Date;
  }) {
    this.#store = input.store;
    this.#policy = input.policy;
    this.#now = input.now ?? (() => new Date());
  }

  async processNext(): Promise<LifecycleWorkerOutcome> {
    const current = this.#now();
    if (current.getTime() < this.#nextSweepAt) return { kind: "idle" };
    this.#nextSweepAt = current.getTime() + this.#policy.sweepIntervalSeconds * 1_000;
    const now = current.toISOString();
    const idleBefore = new Date(current.getTime() - this.#policy.closeIdleAfterHours * 3_600_000).toISOString();
    let count = 0;
    for (const taskId of this.#store.listCloseCandidates({ idleBefore, limit: this.#policy.maxClosesPerSweep })) {
      // Rechecked in the close transaction: a reply since listing leaves the task open ("busy").
      const result = this.#store.closeTask({ taskId, reason: "idle", actorId: "lifecycle-worker", now, idleBefore });
      if (result.kind === "closed") count += 1;
    }
    return count === 0 ? { kind: "idle" } : { kind: "tasks-closed", count };
  }
}
