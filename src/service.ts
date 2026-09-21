import { join } from "node:path";

import type { AgentTagConfig } from "./config.ts";
import { AgentTagCoordinator } from "./coordinator.ts";
import { InteractionWorker } from "./interaction-worker.ts";
import { validateConfiguredProviders } from "./policy/provider.ts";
import { ScheduleWorker } from "./scheduler.ts";
import { SlackSocketBridge } from "./slack/bridge.ts";
import { AgentTagStore } from "./store/store.ts";
import { inspectT3 } from "./t3/gateway.ts";

interface ServiceWorkerOutcome {
  readonly kind: string;
}

export interface ServiceWorker {
  readonly processNext: () => Promise<ServiceWorkerOutcome>;
}

export interface ServiceSlackBridge {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly deliverNextOutbox: () => Promise<boolean>;
}

export interface ServiceLogRecord {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly at: string;
  readonly worker?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly count?: number;
}

export type ServiceLogger = (record: ServiceLogRecord) => void;

export interface AgentTagServiceOptions {
  readonly store: AgentTagStore;
  readonly bridge: ServiceSlackBridge;
  readonly coordinators: ReadonlyArray<ServiceWorker>;
  readonly interactionWorkers: ReadonlyArray<ServiceWorker>;
  readonly scheduleWorkers?: ReadonlyArray<ServiceWorker>;
  readonly maintenanceWorkers?: ReadonlyArray<ServiceWorker>;
  readonly idleMs?: number;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "WorkerError";
}

function waitUntilWorkOrStop(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function defaultLogger(record: ServiceLogRecord): void {
  const target = record.level === "warn" ? console.error : console.log;
  target(JSON.stringify(record));
}

export class AgentTagService {
  readonly #store: AgentTagStore;
  readonly #bridge: ServiceSlackBridge;
  readonly #coordinators: ReadonlyArray<ServiceWorker>;
  readonly #interactionWorkers: ReadonlyArray<ServiceWorker>;
  readonly #scheduleWorkers: ReadonlyArray<ServiceWorker>;
  readonly #maintenanceWorkers: ReadonlyArray<ServiceWorker>;
  readonly #idleMs: number;
  readonly #logger: ServiceLogger;
  readonly #now: () => Date;
  #controller: AbortController | null = null;
  #loops: ReadonlyArray<Promise<void>> = [];
  #state: "created" | "running" | "stopping" | "stopped" = "created";

  constructor(options: AgentTagServiceOptions) {
    if (options.coordinators.length === 0) throw new Error("at least one coordinator is required");
    if (options.interactionWorkers.length === 0) throw new Error("at least one interaction worker is required");
    const idleMs = options.idleMs ?? 250;
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new Error("idleMs must be positive");
    this.#store = options.store;
    this.#bridge = options.bridge;
    this.#coordinators = options.coordinators;
    this.#interactionWorkers = options.interactionWorkers;
    this.#scheduleWorkers = options.scheduleWorkers ?? [];
    this.#maintenanceWorkers = options.maintenanceWorkers ?? [];
    this.#idleMs = idleMs;
    this.#logger = options.logger ?? defaultLogger;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.#state !== "created") throw new Error(`cannot start service in ${this.#state} state`);
    try {
      await this.#bridge.start();
    } catch (error) {
      this.#state = "stopped";
      this.#store.close();
      throw error;
    }
    this.#state = "running";
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    this.#loops = [
      ...this.#coordinators.map((worker, index) =>
        this.#runWorkerLoop(`coordinator-${index + 1}`, worker, signal),
      ),
      ...this.#interactionWorkers.map((worker, index) =>
        this.#runWorkerLoop(`interaction-${index + 1}`, worker, signal),
      ),
      ...this.#scheduleWorkers.map((worker, index) =>
        this.#runWorkerLoop(`schedule-${index + 1}`, worker, signal),
      ),
      ...this.#maintenanceWorkers.map((worker, index) =>
        this.#runWorkerLoop(`maintenance-${index + 1}`, worker, signal),
      ),
      this.#runOutboxLoop(signal),
    ];
    this.#log({ level: "info", event: "service.started", count: this.#loops.length });
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "created") {
      this.#state = "stopped";
      this.#store.close();
      return;
    }
    if (this.#state === "stopping") {
      await Promise.allSettled(this.#loops);
      return;
    }
    this.#state = "stopping";
    this.#controller?.abort();
    const results = await Promise.allSettled([this.#bridge.stop(), ...this.#loops]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.#log({ level: "warn", event: "service.stop.failed", errorCode: errorCode(result.reason) });
      }
    }
    this.#store.close();
    this.#state = "stopped";
    this.#log({ level: "info", event: "service.stopped" });
  }

  async #runWorkerLoop(name: string, worker: ServiceWorker, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const outcome = await worker.processNext();
        if (outcome.kind !== "idle") {
          this.#log({ level: "info", event: "worker.outcome", worker: name, outcome: outcome.kind });
        }
        if (outcome.kind === "idle") await waitUntilWorkOrStop(this.#idleMs, signal);
      } catch (error) {
        this.#log({ level: "warn", event: "worker.failed", worker: name, errorCode: errorCode(error) });
        await waitUntilWorkOrStop(this.#idleMs, signal);
      }
    }
  }

  async #runOutboxLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const delivered = await this.#bridge.deliverNextOutbox();
        if (delivered) {
          this.#log({ level: "info", event: "worker.outcome", worker: "outbox", outcome: "delivered" });
        } else {
          await waitUntilWorkOrStop(this.#idleMs, signal);
        }
      } catch (error) {
        this.#log({ level: "warn", event: "worker.failed", worker: "outbox", errorCode: errorCode(error) });
        await waitUntilWorkOrStop(this.#idleMs, signal);
      }
    }
  }

  #log(input: Omit<ServiceLogRecord, "at">): void {
    this.#logger({ ...input, at: this.#now().toISOString() });
  }
}

export async function createAgentTagService(input: {
  readonly config: AgentTagConfig;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}): Promise<AgentTagService> {
  const now = input.now ?? (() => new Date());
  const logger = input.logger ?? defaultLogger;
  const store = await AgentTagStore.open(join(input.config.dataDir, "agent-tag.sqlite"));
  const quarantined = store.quarantineExpiredOutbox(now().toISOString());
  try {
    validateConfiguredProviders(input.config, await inspectT3(input.config.t3));
    const bridge = await SlackSocketBridge.create({ config: input.config, store });
    let nextMemoryExpiryAt = 0;
    const coordinators = Array.from(
      { length: input.config.limits.maxConcurrentTasks },
      () => new AgentTagCoordinator({ config: input.config, store }),
    );
    const service = new AgentTagService({
      store,
      bridge,
      coordinators,
      interactionWorkers: [new InteractionWorker({ store, t3Config: input.config.t3 })],
      scheduleWorkers: [new ScheduleWorker({ store })],
      maintenanceWorkers: [
        {
          processNext: async () => {
            const current = now();
            if (current.getTime() < nextMemoryExpiryAt) return { kind: "idle" };
            nextMemoryExpiryAt = current.getTime() + 60_000;
            const count = store.expireMemory(current.toISOString());
            return { kind: count === 0 ? "idle" : "memory-expired" };
          },
        },
      ],
      logger,
      now,
    });
    if (quarantined > 0) {
      logger({
        level: "warn",
        event: "outbox.quarantined",
        count: quarantined,
        at: now().toISOString(),
      });
    }
    return service;
  } catch (error) {
    store.close();
    throw error;
  }
}

export async function diagnoseAgentTag(config: AgentTagConfig): Promise<{
  readonly store: ReturnType<AgentTagStore["diagnostics"]>;
  readonly t3: {
    readonly reachable: true;
    readonly providers: ReadonlyArray<{
      readonly instanceId: string;
      readonly status: string;
      readonly authenticated: boolean;
    }>;
  };
  readonly slack: { readonly authenticated: true };
}> {
  const store = await AgentTagStore.open(join(config.dataDir, "agent-tag.sqlite"));
  try {
    const [t3] = await Promise.all([
      inspectT3(config.t3),
      SlackSocketBridge.create({ config, store }),
    ]);
    validateConfiguredProviders(config, t3);
    return {
      store: store.diagnostics(),
      t3: {
        reachable: true,
        providers: t3.providers.map((provider) => ({
          instanceId: provider.instanceId,
          status: provider.status,
          authenticated: provider.auth.status === "authenticated",
        })),
      },
      slack: { authenticated: true },
    };
  } finally {
    store.close();
  }
}
