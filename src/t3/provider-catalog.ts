import type { T3ServerInfo } from "./gateway.ts";

/** A snapshot older than this is too stale to plan a model switch against. */
export const PROVIDER_CATALOG_MAX_AGE_MS = 300_000;
/** How often the maintenance loop refreshes the catalog. */
export const PROVIDER_CATALOG_REFRESH_MS = 60_000;

export interface ProviderCatalogOptions {
  /** Reads the catalog from T3 (`inspectT3` in production). */
  readonly inspect: (signal: AbortSignal | undefined) => Promise<T3ServerInfo>;
  readonly now?: () => Date;
  readonly maxAgeMs?: number;
  /** Called when a refresh fails; the last good snapshot is kept. */
  readonly onRefreshFailed?: (error: unknown) => void;
}

/**
 * The T3 provider catalog (`server.getConfig` providers) as last seen, for planning model switches.
 * A failed refresh keeps the last good snapshot; `current()` stops returning it once it is stale.
 */
export class ProviderCatalog {
  readonly #inspect: ProviderCatalogOptions["inspect"];
  readonly #now: () => Date;
  readonly #maxAgeMs: number;
  readonly #onRefreshFailed: (error: unknown) => void;
  #snapshot: { readonly info: T3ServerInfo; readonly at: number } | null = null;
  #inFlight: Promise<boolean> | null = null;

  constructor(options: ProviderCatalogOptions) {
    this.#inspect = options.inspect;
    this.#now = options.now ?? (() => new Date());
    this.#maxAgeMs = options.maxAgeMs ?? PROVIDER_CATALOG_MAX_AGE_MS;
    this.#onRefreshFailed = options.onRefreshFailed ?? (() => undefined);
  }

  /** Records a catalog read elsewhere (for example the startup probe) without another T3 call. */
  seed(info: T3ServerInfo): void {
    this.#snapshot = { info, at: this.#now().getTime() };
  }

  /** The snapshot, or `null` when there is none or it is older than the maximum age. */
  current(): T3ServerInfo | null {
    if (this.#snapshot === null) return null;
    return this.#now().getTime() - this.#snapshot.at > this.#maxAgeMs ? null : this.#snapshot.info;
  }

  /** Reads the catalog from T3. Concurrent callers share one read. Resolves `false` when it failed. */
  refresh(signal?: AbortSignal): Promise<boolean> {
    this.#inFlight ??= this.#inspect(signal).then(
      (info) => {
        this.seed(info);
        return true;
      },
      (error: unknown) => {
        this.#onRefreshFailed(error);
        return false;
      },
    ).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }
}

/**
 * A maintenance worker that refreshes `catalog` at most every `intervalMs`. It always reports idle:
 * failures surface through the catalog's `onRefreshFailed`, and success is not worth a log line.
 */
export function createProviderCatalogWorker(input: {
  readonly catalog: ProviderCatalog;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}): { readonly processNext: (signal: AbortSignal) => Promise<{ readonly kind: "idle" }> } {
  const now = input.now ?? (() => new Date());
  const intervalMs = input.intervalMs ?? PROVIDER_CATALOG_REFRESH_MS;
  let nextRefreshAt = now().getTime() + intervalMs;
  return {
    processNext: async (signal) => {
      const current = now().getTime();
      if (current < nextRefreshAt) return { kind: "idle" };
      nextRefreshAt = current + intervalMs;
      await input.catalog.refresh(signal);
      return { kind: "idle" };
    },
  };
}
