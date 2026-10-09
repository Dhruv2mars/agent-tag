import type { ServiceLogger, ServiceWorker } from "../service.ts";
import {
  type EnvironmentFetch,
  fetchT3EnvironmentDescriptor,
  T3EnvironmentRequestError,
  T3EnvironmentUnavailableError,
  t3DescriptorProblem,
} from "./protocol.ts";

export interface T3RuntimeGateOptions {
  readonly baseUrl: string;
  /** Managed mode: the runtime must report exactly this version and keep one environment id. */
  readonly pinnedVersion?: string;
  readonly logger: ServiceLogger;
  readonly fetch?: EnvironmentFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/**
 * Fail-closed view of whether T3 may be used right now, from `/.well-known/t3/environment`. Closed
 * when T3 is unreachable, speaks another orchestration protocol, or (managed) reports another
 * version or environment id. T3 workers skip their turn while it is closed; Slack delivery does not.
 */
export class T3RuntimeGate {
  readonly #options: T3RuntimeGateOptions;
  readonly #now: () => Date;
  #open: boolean | undefined;
  #reason: string | undefined = "not checked yet";
  #environmentId: string | undefined;
  #inFlight: Promise<boolean> | undefined;

  constructor(options: T3RuntimeGateOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get open(): boolean {
    return this.#open === true;
  }

  /** Why the gate is closed; undefined while open. */
  get reason(): string | undefined {
    return this.#reason;
  }

  /** Probes T3 once (concurrent callers share the probe) and returns whether the gate is open. */
  check(): Promise<boolean> {
    this.#inFlight ??= this.#probe().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #probe(): Promise<boolean> {
    let reason: string | undefined;
    try {
      const descriptor = await fetchT3EnvironmentDescriptor({
        baseUrl: this.#options.baseUrl,
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      });
      const pinnedVersion = this.#options.pinnedVersion;
      reason = t3DescriptorProblem(descriptor, pinnedVersion === undefined ? {} : { pinnedVersion })?.message;
      // Managed mode pins the runtime's identity: a missing or malformed id fails closed, like a changed one.
      if (reason === undefined && pinnedVersion !== undefined && descriptor.environmentId === undefined) {
        reason = "managed T3 reported no environment id; it must identify its base dir";
      } else if (reason === undefined && pinnedVersion !== undefined && descriptor.environmentId !== undefined) {
        this.#environmentId ??= descriptor.environmentId;
        if (descriptor.environmentId !== this.#environmentId) {
          reason = `managed T3 environment id changed from ${this.#environmentId} to ${descriptor.environmentId}: its base dir was replaced; restart Agent Tag after checking t3.homeDir`;
        }
      }
    } catch (error) {
      reason = error instanceof T3EnvironmentRequestError || error instanceof T3EnvironmentUnavailableError
        ? `unreachable: ${error.message}`
        : `unrecognized environment response: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.#transition(reason);
    return this.open;
  }

  #transition(reason: string | undefined): void {
    const open = reason === undefined;
    const changed = this.#open !== open || (!open && this.#reason !== reason);
    this.#open = open;
    this.#reason = reason;
    // One line per transition; a closed gate whose reason changes logs the new reason once.
    if (!changed) return;
    this.#options.logger({
      level: open ? "info" : "warn",
      event: open ? "t3.gate.opened" : "t3.gate.closed",
      at: this.#now().toISOString(),
      ...(reason === undefined ? {} : { detail: reason }),
    });
  }
}

/**
 * Maintenance worker that re-checks the gate every `openIntervalMs` while open and every
 * `closedIntervalMs` while closed, so a recovered T3 is picked up quickly.
 */
export function createT3GateWorker(input: {
  readonly gate: T3RuntimeGate;
  readonly now?: () => Date;
  readonly openIntervalMs?: number;
  readonly closedIntervalMs?: number;
}): ServiceWorker {
  const now = input.now ?? (() => new Date());
  const openIntervalMs = input.openIntervalMs ?? 60_000;
  const closedIntervalMs = input.closedIntervalMs ?? 10_000;
  let nextCheckAt = 0;
  return {
    requiresT3: false,
    processNext: async () => {
      const current = now().getTime();
      if (current < nextCheckAt) return { kind: "idle" };
      const wasOpen = input.gate.open;
      const open = await input.gate.check();
      nextCheckAt = now().getTime() + (open ? openIntervalMs : closedIntervalMs);
      return { kind: open === wasOpen ? "idle" : open ? "t3-gate-opened" : "t3-gate-closed" };
    },
  };
}
