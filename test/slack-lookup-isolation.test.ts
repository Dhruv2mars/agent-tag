import { describe, expect, test } from "bun:test";
import { webApi } from "@slack/bolt";

import { createSlackUserDirectory, SLACK_CLIENT_OPTIONS, SLACK_LOOKUP_CLIENT_OPTIONS } from "../src/slack/bridge.ts";
import { SlackUserDirectory } from "../src/slack/users.ts";

/**
 * A local slack.com/api where `users.info` hangs until released and `chat.postMessage` answers at
 * once. Tracks how many `users.info` requests the server has seen and how many were open at once.
 */
async function withHungLookups(
  run: (input: { readonly slackApiUrl: string; readonly stats: { started: number; open: number; peakOpen: number } }) => Promise<void>,
): Promise<void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stats = { started: 0, open: 0, peakOpen: 0 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const method = new URL(request.url).pathname.replace("/api/", "");
      if (method === "users.info") {
        stats.started += 1;
        stats.open += 1;
        stats.peakOpen = Math.max(stats.peakOpen, stats.open);
        await gate;
        stats.open -= 1;
        return Response.json({ ok: true, user: { id: "U", name: "late" } });
      }
      return Response.json({ ok: true, channel: "C1", ts: "1.000001" });
    },
  });
  try {
    await run({ slackApiUrl: `http://127.0.0.1:${server.port}/api/`, stats });
  } finally {
    release();
    // Let queued lookups drain against the live server so none fail noisily after it stops.
    while (stats.open > 0) await Bun.sleep(5);
    await Bun.sleep(100);
    await server.stop(true);
  }
}

function outboxClient(slackApiUrl: string, extra: { readonly maxRequestConcurrency?: number } = {}) {
  return new webApi.WebClient("xoxb-test-token", {
    ...SLACK_CLIENT_OPTIONS,
    retryConfig: { ...SLACK_CLIENT_OPTIONS.retryConfig },
    slackApiUrl,
    logLevel: webApi.LogLevel.ERROR,
    ...extra,
  });
}

/** 32 concurrent turns, each resolving four uncached mentions under a short turn deadline. */
async function floodLookups(directory: SlackUserDirectory): Promise<void> {
  await Promise.all(
    Array.from({ length: 32 }, (_, turn) =>
      directory.labels(
        Array.from({ length: 4 }, (_, index) => `U${turn}x${index}`),
        undefined,
        AbortSignal.timeout(50),
      ),
    ),
  );
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);
}

describe("speaker lookup isolation", () => {
  test("hung lookups cannot delay outbox delivery and stay bounded on their own client", async () => {
    await withHungLookups(async ({ slackApiUrl, stats }) => {
      const directory = await createSlackUserDirectory({ botToken: "xoxb-test-token", slackApiUrl, logger: () => {} });
      await floodLookups(directory);
      const outbox = outboxClient(slackApiUrl);
      expect(await settlesWithin(outbox.chat.postMessage({ channel: "C1", text: "hi" }), 1_000)).toBe(true);
      expect(stats.peakOpen).toBeLessThanOrEqual(SLACK_LOOKUP_CLIENT_OPTIONS.maxRequestConcurrency);
      expect(stats.started).toBeLessThanOrEqual(SLACK_LOOKUP_CLIENT_OPTIONS.maxRequestConcurrency);
    });
  });

  test("control: on a shared client the same flood starves chat.postMessage", async () => {
    await withHungLookups(async ({ slackApiUrl }) => {
      // A small shared queue stands in for the default 100 slots; the starvation is the same.
      const shared = outboxClient(slackApiUrl, { maxRequestConcurrency: 4 });
      const directory = new SlackUserDirectory({
        lookup: (userId) => shared.users.info({ user: userId }),
        maxOutstandingLookups: Number.POSITIVE_INFINITY,
        logger: () => {},
      });
      await floodLookups(directory);
      expect(await settlesWithin(shared.chat.postMessage({ channel: "C1", text: "hi" }), 500)).toBe(false);
    });
  });
});
