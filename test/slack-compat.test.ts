import { describe, expect, test } from "bun:test";

import { copyUndiciWebSocketExports } from "../src/slack/undici-compat.ts";

describe("Slack Socket Mode Bun compatibility", () => {
  test("copies the package WebSocket heartbeat API when bare undici lacks ping", () => {
    const target = { WebSocket: "bun" };
    const source = {
      WebSocket: "package",
      ErrorEvent: "error",
      MessageEvent: "message",
      CloseEvent: "close",
      ping: () => undefined,
    };

    expect(copyUndiciWebSocketExports(target, source)).toBe(true);
    expect(target).toEqual(source);
  });

  test("does not replace a native heartbeat implementation", () => {
    const ping = () => undefined;
    const target = { ping };
    const source = { ping: () => undefined };

    expect(copyUndiciWebSocketExports(target, source)).toBe(false);
    expect(target.ping).toBe(ping);
  });
});
