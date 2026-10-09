import { describe, expect, test } from "bun:test";
import type { T3ServerInfo } from "../src/t3/gateway.ts";
import {
  createProviderCatalogWorker,
  PROVIDER_CATALOG_MAX_AGE_MS,
  PROVIDER_CATALOG_REFRESH_MS,
  ProviderCatalog,
} from "../src/t3/provider-catalog.ts";

function info(label: string): T3ServerInfo {
  return {
    environment: { environmentId: `env-${label}`, label, serverVersion: "0.0.45" },
    providers: [],
  } as unknown as T3ServerInfo;
}

function clock(start = 0): { readonly now: () => Date; advance(ms: number): void } {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => { at += ms; } };
}

describe("ProviderCatalog", () => {
  test("has no snapshot until seeded, and drops it once older than the maximum age", () => {
    const time = clock();
    const catalog = new ProviderCatalog({ inspect: async () => info("unused"), now: time.now });
    expect(catalog.current()).toBeNull();
    const seeded = info("seed");
    catalog.seed(seeded);
    expect(catalog.current()).toBe(seeded);
    time.advance(PROVIDER_CATALOG_MAX_AGE_MS);
    expect(catalog.current()).toBe(seeded);
    time.advance(1);
    expect(catalog.current()).toBeNull();
  });

  test("refresh replaces the snapshot; a failed refresh keeps the last good one and reports the error", async () => {
    const time = clock();
    const errors: unknown[] = [];
    const responses: Array<T3ServerInfo | Error> = [info("first"), new Error("T3 down"), info("third")];
    const catalog = new ProviderCatalog({
      now: time.now,
      inspect: async () => {
        const next = responses.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      onRefreshFailed: (error) => errors.push(error),
    });
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.current()?.environment.label).toBe("first");
    time.advance(1_000);
    expect(await catalog.refresh()).toBe(false);
    expect(errors.map((error) => (error as Error).message)).toEqual(["T3 down"]);
    expect(catalog.current()?.environment.label).toBe("first");
    // The kept snapshot still ages from when it was read, not from the failed refresh.
    time.advance(PROVIDER_CATALOG_MAX_AGE_MS);
    expect(catalog.current()).toBeNull();
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.current()?.environment.label).toBe("third");
  });

  test("concurrent refreshes share one T3 read", async () => {
    let calls = 0;
    let release!: (value: T3ServerInfo) => void;
    const catalog = new ProviderCatalog({
      inspect: () => {
        calls += 1;
        return new Promise<T3ServerInfo>((resolve) => { release = resolve; });
      },
    });
    const first = catalog.refresh();
    const second = catalog.refresh();
    expect(calls).toBe(1);
    release(info("shared"));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    const later = catalog.refresh();
    expect(calls).toBe(2);
    release(info("later"));
    expect(await later).toBe(true);
    expect(catalog.current()?.environment.label).toBe("later");
  });
});

describe("provider catalog worker", () => {
  test("refreshes at most once per interval, starting one interval after creation, and always reports idle", async () => {
    const time = clock(10_000);
    let reads = 0;
    const catalog = new ProviderCatalog({
      now: time.now,
      inspect: async () => {
        reads += 1;
        return info(`read-${reads}`);
      },
    });
    const worker = createProviderCatalogWorker({ catalog, now: time.now });
    const signal = new AbortController().signal;
    expect(await worker.processNext(signal)).toEqual({ kind: "idle" });
    expect(reads).toBe(0);
    time.advance(PROVIDER_CATALOG_REFRESH_MS);
    expect(await worker.processNext(signal)).toEqual({ kind: "idle" });
    expect(reads).toBe(1);
    time.advance(PROVIDER_CATALOG_REFRESH_MS - 1);
    await worker.processNext(signal);
    expect(reads).toBe(1);
    time.advance(1);
    await worker.processNext(signal);
    expect(reads).toBe(2);
    expect(catalog.current()?.environment.label).toBe("read-2");
  });

  test("stays idle when a refresh fails", async () => {
    const time = clock();
    const failures: unknown[] = [];
    const catalog = new ProviderCatalog({
      now: time.now,
      inspect: async () => { throw new Error("unreachable"); },
      onRefreshFailed: (error) => failures.push(error),
    });
    const worker = createProviderCatalogWorker({ catalog, now: time.now, intervalMs: 5 });
    time.advance(5);
    expect(await worker.processNext(new AbortController().signal)).toEqual({ kind: "idle" });
    expect(failures).toHaveLength(1);
  });
});
