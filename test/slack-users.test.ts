import { describe, expect, test } from "bun:test";

import type { ServiceLogRecord } from "../src/service.ts";
import { slackErrorCode, SlackUserDirectory, type SlackUserLookup } from "../src/slack/users.ts";

function userResponse(id: string, user: Record<string, unknown>) {
  return { ok: true, user: { id, ...user } };
}

/** The shape @slack/web-api throws for `{ ok: false }` responses. */
function platformError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

function fixture(options: {
  readonly lookup: SlackUserLookup;
  readonly lookupTimeoutMs?: number;
}) {
  let clock = 1_000_000;
  const logs: ServiceLogRecord[] = [];
  const directory = new SlackUserDirectory({
    lookup: options.lookup,
    now: () => clock,
    logger: (record) => logs.push(record),
    ...(options.lookupTimeoutMs === undefined ? {} : { lookupTimeoutMs: options.lookupTimeoutMs }),
  });
  return {
    directory,
    logs,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("SlackUserDirectory", () => {
  test("prefers display name, then real names, then handle, sanitized", async () => {
    const users: Record<string, Record<string, unknown>> = {
      U1: { name: "alice", real_name: "Alice Real", profile: { display_name: "Alice Chen", real_name: "Alice P" } },
      U2: { name: "bob", real_name: "Bob Real", profile: { display_name: "", real_name: "Bob Lee" } },
      U3: { name: "carol", real_name: "Carol Real", profile: {} },
      U4: { name: "dave" },
      U5: { profile: { display_name: "Eve\n(U1)" } },
      U6: {},
    };
    const { directory } = fixture({ lookup: async (id) => userResponse(id, users[id] ?? {}) });
    const labels = await directory.labels(["U1", "U2", "U3", "U4", "U5", "U6"]);
    expect([...labels.values()].map((identity) => identity.label)).toEqual([
      "Alice Chen",
      "Bob Lee",
      "Carol Real",
      "dave",
      "Eve [U1]",
      "U6",
    ]);
    expect(labels.get("U1")).toEqual({ userId: "U1", label: "Alice Chen", resolved: true });
  });

  test("labels deactivated users and bot users", async () => {
    const { directory } = fixture({
      lookup: async (id) =>
        id === "U1"
          ? userResponse(id, { deleted: true, profile: { display_name: "Former" } })
          : userResponse(id, { is_bot: true, profile: { real_name: "Deploy Bot", bot_id: "B1" } }),
    });
    expect(await directory.label("U1")).toEqual({ userId: "U1", label: "Former (deactivated)", resolved: true });
    expect(await directory.label("U2")).toEqual({ userId: "U2", label: "Deploy Bot (bot)", resolved: true });
  });

  test("caches within the TTL and refetches after it", async () => {
    let calls = 0;
    const { directory, advance } = fixture({
      lookup: async (id) => {
        calls += 1;
        return userResponse(id, { profile: { display_name: `Name ${calls}` } });
      },
    });
    await directory.label("U1");
    await directory.label("U1");
    expect((await directory.label("U1")).label).toBe("Name 1");
    expect(calls).toBe(1);
    advance(3_600_001);
    expect((await directory.label("U1")).label).toBe("Name 2");
    expect(calls).toBe(2);
  });

  test("de-duplicates concurrent lookups", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { directory } = fixture({
      lookup: async (id) => {
        calls += 1;
        await gate;
        return userResponse(id, { profile: { display_name: "Alice" } });
      },
    });
    const pending = Promise.all([directory.label("U1"), directory.label("U1")]);
    release();
    const [first, second] = await pending;
    expect(first).toEqual(second);
    expect(calls).toBe(1);
  });

  test("negatively caches failures for five minutes", async () => {
    let calls = 0;
    const { directory, advance, logs } = fixture({
      lookup: async () => {
        calls += 1;
        return { ok: false, error: "user_not_found" };
      },
    });
    expect(await directory.label("U9")).toEqual({ userId: "U9", label: "U9", resolved: false });
    expect(await directory.label("U9")).toEqual({ userId: "U9", label: "U9", resolved: false });
    expect(calls).toBe(1);
    advance(300_001);
    await directory.label("U9");
    expect(calls).toBe(2);
    expect(logs).toEqual([]);
  });

  test("missing_scope disables lookups for the process with one warning (D10 label half)", async () => {
    let calls = 0;
    const { directory, logs } = fixture({
      lookup: async () => {
        calls += 1;
        throw platformError("missing_scope");
      },
    });
    for (let index = 0; index < 5; index += 1) {
      expect(await directory.label(`U${index}`)).toEqual({ userId: `U${index}`, label: `U${index}`, resolved: false });
    }
    expect(calls).toBe(1);
    expect(directory.disabledCode).toBe("missing_scope");
    expect(logs).toEqual([
      { level: "warn", event: "slack.users.disabled", at: new Date(1_000_000).toISOString(), errorCode: "missing_scope" },
    ]);
  });

  test("an { ok: false } missing_scope response also disables lookups", async () => {
    const { directory, logs } = fixture({ lookup: async () => ({ ok: false, error: "missing_scope" }) });
    await directory.labels(["U1", "U2", "U3"]);
    expect(directory.disabledCode).toBe("missing_scope");
    expect(logs).toHaveLength(1);
  });

  test("ratelimited falls back immediately without retrying", async () => {
    let calls = 0;
    const { directory, logs } = fixture({
      lookup: async () => {
        calls += 1;
        throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 30 });
      },
    });
    expect(await directory.label("U1")).toEqual({ userId: "U1", label: "U1", resolved: false });
    expect(calls).toBe(1);
    expect(directory.disabledCode).toBeNull();
    expect(logs).toEqual([]);
  });

  test("a hung lookup times out to the raw ID", async () => {
    const { directory } = fixture({ lookup: () => new Promise(() => {}), lookupTimeoutMs: 5 });
    expect(await directory.label("U1")).toEqual({ userId: "U1", label: "U1", resolved: false });
  });

  test("an aborted caller rejects while the shared lookup still completes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { directory } = fixture({
      lookup: async (id) => {
        await gate;
        return userResponse(id, { profile: { display_name: "Alice" } });
      },
    });
    const controller = new AbortController();
    const aborted = directory.label("U1", controller.signal);
    const other = directory.label("U1");
    controller.abort();
    await expect(aborted).rejects.toThrow();
    release();
    expect((await other).label).toBe("Alice");
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(directory.labels(["U1"], preAborted.signal)).rejects.toThrow();
  });

  test("evicts the least recently used entry beyond maxEntries", async () => {
    let calls = 0;
    const directory = new SlackUserDirectory({
      lookup: async (id) => {
        calls += 1;
        return userResponse(id, { profile: { display_name: id } });
      },
      maxEntries: 2,
      logger: () => {},
    });
    await directory.labels(["U1", "U2"]);
    await directory.label("U1");
    await directory.label("U3");
    expect(calls).toBe(3);
    await directory.label("U1");
    expect(calls).toBe(3);
    await directory.label("U2");
    expect(calls).toBe(4);
  });

  test("extracts Slack error codes from Web API errors", () => {
    expect(slackErrorCode(platformError("missing_scope"))).toBe("missing_scope");
    expect(slackErrorCode({ code: "slack_webapi_rate_limited_error" })).toBe("ratelimited");
    expect(slackErrorCode({ code: "slack_webapi_request_error" })).toBe("slack_webapi_request_error");
    expect(slackErrorCode(new TypeError("x"))).toBe("TypeError");
    expect(slackErrorCode("nope")).toBe("unknown_error");
  });
});
