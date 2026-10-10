import { expect, test } from "bun:test";

import { catalogRefreshFailed, type ServiceLogRecord } from "../src/service.ts";
import { T3HttpError, T3UnauthenticatedSessionError } from "../src/t3/auth.ts";
import { ProviderCatalog } from "../src/t3/provider-catalog.ts";

const now = () => new Date("2026-10-10T12:00:00.000Z");

test("a catalog refresh rejected for its credential triggers an immediate credential check", async () => {
  const logs: ServiceLogRecord[] = [];
  let rejected = 0;
  const catalog = new ProviderCatalog({
    inspect: async () => {
      throw new T3UnauthenticatedSessionError();
    },
    now,
    onRefreshFailed: catalogRefreshFailed({ logger: (record) => logs.push(record), now, onCredentialRejected: () => (rejected += 1) }),
  });
  await catalog.refresh(new AbortController().signal).catch(() => undefined);
  expect(rejected).toBe(1);
  expect(logs).toMatchObject([{ level: "warn", event: "t3.catalog.refresh.failed", errorCode: "T3UnauthenticatedSessionError" }]);
});

test("a catalog refresh that fails for another reason only logs", () => {
  const logs: ServiceLogRecord[] = [];
  let rejected = 0;
  const failed = catalogRefreshFailed({ logger: (record) => logs.push(record), now, onCredentialRejected: () => (rejected += 1) });
  failed(new T3HttpError("session", 503));
  failed(new TypeError("fetch failed"));
  expect(rejected).toBe(0);
  expect(logs.map((record) => record.errorCode)).toEqual(["T3HttpError", "TypeError"]);
  failed(new T3HttpError("session", 403));
  expect(rejected).toBe(1);
});
