import { join } from "node:path";

import type { AgentTagConfig } from "./config.ts";
import { AgentTagCoordinator } from "./coordinator.ts";
import { PrWorker, pullRequestsEnabled } from "./git/pr-worker.ts";
import { createGitRunner } from "./git/runner.ts";
import { InteractionWorker } from "./interaction-worker.ts";
import { type AllowedModelReport, reportAllowedModels, validateConfiguredProviders } from "./policy/provider.ts";
import { createScheduleWorkers } from "./scheduler.ts";
import { SlackSocketBridge } from "./slack/bridge.ts";
import { createRetentionWorker } from "./store/retention.ts";
import { AgentTagStore } from "./store/store.ts";
import { T3Connection } from "./t3/connection.ts";
import { createT3GateWorker, T3RuntimeGate } from "./t3/gate.ts";
import { inspectT3, type T3ServerInfo } from "./t3/gateway.ts";
import { PINNED_T3 } from "./t3/lock.ts";
import { prepareManagedT3Binary, T3ManagedRuntime } from "./t3/supervisor.ts";
import { protocolV1Source, ThreadWatcher } from "./t3/watcher.ts";

interface ServiceWorkerOutcome {
  readonly kind: string;
}

export interface ServiceWorker {
  /** The signal aborts when the service stops; long-running work should release durable leases promptly. */
  readonly processNext: (signal: AbortSignal) => Promise<ServiceWorkerOutcome>;
  /**
   * Whether the worker talks to T3 and must sit out while the T3 gate is closed. Defaults to true
   * for coordinators, interaction and schedule workers and to false for maintenance workers.
   */
  readonly requiresT3?: boolean;
}

/** Read-only view of the T3 gate (`src/t3/gate.ts`). */
export interface ServiceT3Gate {
  readonly open: boolean;
}

/** The managed T3 runtime, stopped after the workers and before the store. */
export interface ServiceT3Runtime {
  readonly stop: () => Promise<void>;
  readonly onFatal: (listener: (error: Error) => void) => void;
}

export interface ServiceOutboxOutcome {
  /** "idle" when nothing is claimable (empty, or every pending row is waiting out a retry backoff). */
  readonly kind: string;
  readonly errorCode?: string;
}

export interface ServiceSlackBridge {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly deliverNextOutbox: () => Promise<ServiceOutboxOutcome>;
}

export interface ServiceLogRecord {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly at: string;
  readonly worker?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly count?: number;
  readonly stats?: Readonly<Record<string, number>>;
  /** Redacted, human-readable context (T3 runtime and gate events). */
  readonly detail?: string;
  readonly profileId?: string;
  readonly instanceId?: string;
  readonly model?: string;
}

export type ServiceLogger = (record: ServiceLogRecord) => void;

export interface AgentTagServiceOptions {
  readonly store: AgentTagStore;
  readonly bridge: ServiceSlackBridge;
  readonly coordinators: ReadonlyArray<ServiceWorker>;
  readonly interactionWorkers: ReadonlyArray<ServiceWorker>;
  readonly scheduleWorkers?: ReadonlyArray<ServiceWorker>;
  readonly maintenanceWorkers?: ReadonlyArray<ServiceWorker>;
  /** Closed after every loop has stopped, before the store (e.g. the shared T3 connection). */
  readonly resources?: ReadonlyArray<{ readonly close: () => Promise<void> }>;
  readonly idleMs?: number;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
  /** When present, workers with `requiresT3` skip their turn while it is closed. */
  readonly gate?: ServiceT3Gate;
  /** Managed T3: stopped after the workers; its crash loop is reported through `onFatal`. */
  readonly runtime?: ServiceT3Runtime;
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
  readonly #resources: ReadonlyArray<{ readonly close: () => Promise<void> }>;
  readonly #idleMs: number;
  readonly #logger: ServiceLogger;
  readonly #now: () => Date;
  readonly #gate: ServiceT3Gate | undefined;
  readonly #runtime: ServiceT3Runtime | undefined;
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
    this.#resources = options.resources ?? [];
    this.#idleMs = idleMs;
    this.#logger = options.logger ?? defaultLogger;
    this.#now = options.now ?? (() => new Date());
    this.#gate = options.gate;
    this.#runtime = options.runtime;
  }

  /** Called when the managed T3 runtime gives up (crash loop); the caller should stop and exit 75. */
  onFatal(listener: (error: Error) => void): void {
    this.#runtime?.onFatal(listener);
  }

  async start(): Promise<void> {
    if (this.#state !== "created") throw new Error(`cannot start service in ${this.#state} state`);
    try {
      await this.#bridge.start();
    } catch (error) {
      this.#state = "stopped";
      await this.#closeResources();
      await this.#stopRuntime();
      this.#store.close();
      throw error;
    }
    this.#state = "running";
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    this.#loops = [
      ...this.#coordinators.map((worker, index) =>
        this.#runWorkerLoop(`coordinator-${index + 1}`, worker, signal, worker.requiresT3 ?? true),
      ),
      ...this.#interactionWorkers.map((worker, index) =>
        this.#runWorkerLoop(`interaction-${index + 1}`, worker, signal, worker.requiresT3 ?? true),
      ),
      ...this.#scheduleWorkers.map((worker, index) =>
        this.#runWorkerLoop(`schedule-${index + 1}`, worker, signal, worker.requiresT3 ?? true),
      ),
      ...this.#maintenanceWorkers.map((worker, index) =>
        this.#runWorkerLoop(`maintenance-${index + 1}`, worker, signal, worker.requiresT3 ?? false),
      ),
      this.#runOutboxLoop(signal),
    ];
    this.#log({ level: "info", event: "service.started", count: this.#loops.length });
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "created") {
      this.#state = "stopped";
      await this.#closeResources();
      await this.#stopRuntime();
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
    await this.#closeResources();
    // Workers are stopped, so no T3 call is in flight when the managed runtime goes down.
    await this.#stopRuntime();
    this.#store.close();
    this.#state = "stopped";
    this.#log({ level: "info", event: "service.stopped" });
  }

  async #stopRuntime(): Promise<void> {
    try {
      await this.#runtime?.stop();
    } catch (error) {
      this.#log({ level: "warn", event: "service.stop.failed", errorCode: errorCode(error) });
    }
  }

  async #runWorkerLoop(name: string, worker: ServiceWorker, signal: AbortSignal, requiresT3: boolean): Promise<void> {
    while (!signal.aborted) {
      // Fail closed: a T3 worker does not claim work while the gate is closed; queued work waits in SQLite.
      if (requiresT3 && this.#gate !== undefined && !this.#gate.open) {
        await waitUntilWorkOrStop(this.#idleMs, signal);
        continue;
      }
      try {
        const outcome = await worker.processNext(signal);
        if (outcome.kind !== "idle") {
          this.#log({ level: "info", event: "worker.outcome", worker: name, outcome: outcome.kind });
        }
        // A retry outcome means the worker just backed off a failing item; yield instead of spinning.
        if (outcome.kind === "idle" || outcome.kind === "retry-scheduled") {
          await waitUntilWorkOrStop(this.#idleMs, signal);
        }
      } catch (error) {
        this.#log({ level: "warn", event: "worker.failed", worker: name, errorCode: errorCode(error) });
        await waitUntilWorkOrStop(this.#idleMs, signal);
      }
    }
  }

  async #runOutboxLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const outcome = await this.#bridge.deliverNextOutbox();
        if (outcome.kind === "idle") {
          await waitUntilWorkOrStop(this.#idleMs, signal);
        } else {
          this.#log({
            level: outcome.kind === "delivered" ? "info" : "warn",
            event: "worker.outcome",
            worker: "outbox",
            outcome: outcome.kind,
            ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          });
        }
      } catch (error) {
        this.#log({ level: "warn", event: "worker.failed", worker: "outbox", errorCode: errorCode(error) });
        await waitUntilWorkOrStop(this.#idleMs, signal);
      }
    }
  }

  async #closeResources(): Promise<void> {
    for (const result of await Promise.allSettled(this.#resources.map((resource) => resource.close()))) {
      if (result.status === "rejected") {
        this.#log({ level: "warn", event: "service.stop.failed", errorCode: errorCode(result.reason) });
      }
    }
  }

  #log(input: Omit<ServiceLogRecord, "at">): void {
    this.#logger({ ...input, at: this.#now().toISOString() });
  }
}

/**
 * One warning per allowed model T3 cannot run now. These never block startup: only profile and route
 * defaults are validated strictly.
 */
export function allowedModelLogRecords(
  config: AgentTagConfig,
  server: T3ServerInfo,
  at: string,
): ReadonlyArray<ServiceLogRecord> {
  return reportAllowedModels(config, server)
    .filter((entry) => entry.status !== "available")
    .map((entry) => ({
      level: "warn",
      event: "provider.allowed-model",
      errorCode: entry.status,
      profileId: entry.profileId,
      instanceId: entry.instanceId,
      model: entry.model,
      at,
    }));
}

export async function createAgentTagService(input: {
  readonly config: AgentTagConfig;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}): Promise<AgentTagService> {
  const now = input.now ?? (() => new Date());
  const logger = input.logger ?? defaultLogger;
  const databasePath = join(input.config.dataDir, "agent-tag.sqlite");
  const store = await AgentTagStore.open(databasePath);
  const quarantined = store.quarantineExpiredOutbox(now().toISOString());
  // One T3 session and WebSocket for the whole service, and one subscription per watched thread.
  // The connection is lazy, so building it before a managed runtime starts makes no request.
  const t3 = new T3Connection({ config: input.config.t3, logger, now });
  const watch = input.config.t3.watch;
  const watcher = watch.enabled
    ? new ThreadWatcher({ source: protocolV1Source(t3), logger, now, lingerMs: watch.lingerMs })
    : undefined;
  const closeT3 = async () => {
    await watcher?.close();
    await t3.close();
  };
  let runtime: T3ManagedRuntime | undefined;
  try {
    const t3Config = input.config.t3;
    if (t3Config.mode === "managed") {
      const installed = await prepareManagedT3Binary({ settings: t3Config.managed, pin: PINNED_T3, logger, now });
      runtime = new T3ManagedRuntime({ settings: t3Config.managed, installed, logger, now });
      await runtime.start();
    }
    const server = await inspectT3(t3Config);
    validateConfiguredProviders(input.config, server);
    for (const record of allowedModelLogRecords(input.config, server, now().toISOString())) logger(record);
    const gate = new T3RuntimeGate({
      baseUrl: t3Config.baseUrl,
      ...(runtime === undefined ? {} : { pinnedVersion: PINNED_T3.version }),
      logger,
      now,
    });
    if (!(await gate.check())) throw new Error(`refusing to run against T3 at ${t3Config.baseUrl}: ${gate.reason}`);
    // Every supervisor ready (start or restart) re-checks the gate; a restart closes it as unreachable first.
    runtime?.onStateChange((state) => {
      if (state === "ready" || state === "restarting") void gate.check();
    });
    const bridge = await SlackSocketBridge.create({ config: input.config, store, logger });
    let nextMemoryExpiryAt = 0;
    let nextT3StatsAt = now().getTime() + 60_000;
    // Draft PR workflow (PR-M §3.7): off unless github is configured and a profile has mode "auto".
    const pullRequests = pullRequestsEnabled(input.config) ? { runner: createGitRunner() } : undefined;
    const coordinators = Array.from(
      { length: input.config.limits.maxConcurrentTasks },
      () =>
        new AgentTagCoordinator({
          config: input.config,
          store,
          slackContext: bridge.contextSource,
          t3,
          ...(watcher === undefined ? {} : { watcher }),
          ...(pullRequests === undefined ? {} : { pullRequests }),
        }),
    );
    const service = new AgentTagService({
      store,
      bridge,
      coordinators,
      interactionWorkers: [new InteractionWorker({ store, config: input.config, t3 })],
      scheduleWorkers: createScheduleWorkers({ config: input.config, store }),
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
        createRetentionWorker({ databasePath, policy: input.config.retention, now }),
        {
          processNext: async () => {
            const current = now();
            if (current.getTime() < nextT3StatsAt) return { kind: "idle" };
            nextT3StatsAt = current.getTime() + 60_000;
            logger({
              level: "info",
              event: "t3.connection.stats",
              at: current.toISOString(),
              stats: { ...t3.stats, watchedThreads: watcher?.subscriptionCount ?? 0 },
            });
            return { kind: "idle" };
          },
        },
        createT3GateWorker({ gate, now }),
        ...(pullRequests === undefined
          ? []
          : [
              new PrWorker({
                config: input.config,
                store,
                runner: pullRequests.runner,
                threadLink: (conversationId, threadTs) => bridge.threadPermalink(conversationId, threadTs),
                now,
              }),
            ]),
      ],
      resources: [{ close: closeT3 }],
      logger,
      now,
      gate,
      ...(runtime === undefined ? {} : { runtime }),
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
    await closeT3();
    await runtime?.stop().catch(() => undefined);
    store.close();
    throw error;
  }
}

export async function diagnoseAgentTag(config: AgentTagConfig): Promise<{
  readonly store: ReturnType<AgentTagStore["diagnostics"]>;
  readonly t3: {
    readonly reachable: true;
    readonly orchestrationProtocol: number;
    readonly providers: ReadonlyArray<{
      readonly instanceId: string;
      readonly status: string;
      readonly authenticated: boolean;
    }>;
    readonly models: ReadonlyArray<AllowedModelReport>;
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
        orchestrationProtocol: t3.orchestrationProtocol,
        providers: t3.providers.map((provider) => ({
          instanceId: provider.instanceId,
          status: provider.status,
          authenticated: provider.auth.status === "authenticated",
        })),
        models: reportAllowedModels(config, t3),
      },
      slack: { authenticated: true },
    };
  } finally {
    store.close();
  }
}
