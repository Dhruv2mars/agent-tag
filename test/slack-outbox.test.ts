import { describe, expect, test } from "bun:test";
import { webApi } from "@slack/bolt";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagService, type ServiceLogRecord } from "../src/service.ts";
import { SLACK_CLIENT_OPTIONS } from "../src/slack/bridge.ts";
import { deliverNextSlackOutbox, type SlackOutboxOutcome } from "../src/slack/outbox.ts";
import { classifySlackDeliveryError, outboxRetryDelayMs, plainTextFallback } from "../src/slack/outbox-policy.ts";
import { AgentTagStore, type SlackOutboxPayload } from "../src/store/store.ts";

const start = "2026-10-06T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  ...await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json(),
  slack: { workspaceId: "T1", appTokenFile: "/secrets/app", botTokenFile: "/secrets/bot" },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  routes: [{ conversationId: "C1", profileId: "engineering" }],
});
const root = z.string().parse(config.profiles[0]?.repositoryRoots[0]);

function at(offsetMs: number): string {
  return new Date(new Date(start).getTime() + offsetMs).toISOString();
}

async function withStore(run: (store: AgentTagStore, taskId: string, correlationId: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-outbox-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    const receipt = store.ingestSlackEvent({
      deliveryId: "delivery-1", eventKey: "C1:1000.000001", workspaceId: "T1", conversationId: "C1",
      threadTs: "1000.000001", actorUserId: "U1", conversationType: "channel", profileId: "engineering",
      repositoryRoot: root, text: "request", receivedAt: start,
    });
    await run(store, receipt.taskId, receipt.operationId);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
}

function enqueue(
  store: AgentTagStore,
  taskId: string,
  correlationId: string,
  options: { readonly id: string; readonly payload?: SlackOutboxPayload; readonly threadTs?: string; readonly createdAt?: string },
): string {
  return store.enqueueOutbox({
    taskId, correlationId, conversationId: "C1", threadTs: options.threadTs ?? "1000.000001",
    clientMessageId: options.id, payload: options.payload ?? { text: `message ${options.id}` },
    createdAt: options.createdAt ?? start,
  }).outboxId;
}

type FakeReply = { readonly status: number; readonly headers?: Record<string, string>; readonly body?: unknown };

/** A local stand-in for slack.com/api driven through the real Slack WebClient with production options. */
async function withFakeSlack(
  replies: ReadonlyArray<FakeReply>,
  run: (input: {
    readonly client: InstanceType<typeof webApi.WebClient>;
    readonly requests: Array<Record<string, string>>;
  }) => Promise<void>,
  fetchOverride?: (real: typeof fetch) => typeof fetch,
): Promise<void> {
  const requests: Array<Record<string, string>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(Object.fromEntries(new URLSearchParams(await request.text())));
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      if (reply === undefined) throw new Error("no fake reply");
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    },
  });
  try {
    const client = new webApi.WebClient("xoxb-test-token", {
      ...SLACK_CLIENT_OPTIONS,
      retryConfig: { ...SLACK_CLIENT_OPTIONS.retryConfig },
      slackApiUrl: `http://127.0.0.1:${server.port}/api/`,
      logLevel: webApi.LogLevel.ERROR,
      ...(fetchOverride === undefined ? {} : { fetch: fetchOverride(fetch) }),
    });
    await run({ client, requests });
  } finally {
    await server.stop(true);
  }
}

const ok = (ts: string): FakeReply => ({ status: 200, body: { ok: true, channel: "C1", ts } });
const platformError = (error: string): FakeReply => ({ status: 200, body: { ok: false, error } });

function deliver(
  store: AgentTagStore,
  client: InstanceType<typeof webApi.WebClient>,
  now: string,
  extra: { readonly maxAttempts?: number } = {},
): Promise<SlackOutboxOutcome> {
  return deliverNextSlackOutbox({
    config, store, workerId: "outbox-a", now: () => now, random: () => 1,
    ...(extra.maxAttempts === undefined ? {} : { retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: extra.maxAttempts } }),
    postMessage: (message) => client.chat.postMessage(message),
  });
}

function actionCounts(store: AgentTagStore, outboxId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of store.listAuditRecords({ limit: 200 })) {
    if (row.source === outboxId) counts[row.action] = (counts[row.action] ?? 0) + 1;
  }
  return counts;
}

describe("Slack outbox delivery retries", () => {
  test("a 429 followed by success delivers exactly once and honors Retry-After", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([{ status: 429, headers: { "retry-after": "30" } }, ok("1000.000099")], async ({ client, requests }) => {
        expect(await deliver(store, client, start)).toEqual({
          kind: "retry-scheduled", outboxId, errorCode: "rate_limited", blockedUntil: at(30_000),
        });
        expect(store.operationalStatus(at(1)).outbox).toMatchObject({ pending: 1, retryBlocked: 1, activeLease: 0 });
        // Still blocked one millisecond before Retry-After elapses: no request is made.
        expect(await deliver(store, client, at(29_999))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
        expect(await deliver(store, client, at(30_000))).toEqual({ kind: "delivered", outboxId });
        expect(await deliver(store, client, at(60_000))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.text)).toEqual(["message reply-1", "message reply-1"]);
      });
      expect(actionCounts(store, outboxId)).toEqual({
        "slack.outbox.claimed": 2, "slack.outbox.retry-scheduled": 1, "slack.outbox.delivered": 1,
      });
      const retry = store.listAuditRecords({ limit: 200 }).find((row) => row.action === "slack.outbox.retry-scheduled");
      expect(retry?.metadata).toMatchObject({ errorCode: "rate_limited", blockedUntil: at(30_000), retryable: true });
    });
  });

  test("a 429 pauses every thread until Retry-After, without spending their attempts", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const limited = enqueue(store, taskId, correlationId, { id: "a-1" });
      const otherThread = enqueue(store, taskId, correlationId, { id: "b-1", threadTs: "2000.000001", createdAt: at(1) });
      await withFakeSlack(
        [{ status: 429, headers: { "retry-after": "30" } }, ok("1000.000097"), ok("1000.000098"), ok("1000.000099")],
        async ({ client, requests }) => {
          expect(await deliver(store, client, at(10))).toMatchObject({ kind: "retry-scheduled", outboxId: limited });
          expect(store.operationalStatus(at(11)).outbox).toMatchObject({ pending: 2, retryBlocked: 1, rateLimitedUntil: at(30_010) });
          // A row queued during the cooldown, in yet another thread, waits too.
          const queuedLater = enqueue(store, taskId, correlationId, { id: "c-1", threadTs: "3000.000001", createdAt: at(20) });
          expect(await deliver(store, client, at(20))).toEqual({ kind: "idle" });
          expect(await deliver(store, client, at(30_009))).toEqual({ kind: "idle" });
          expect(requests).toHaveLength(1);
          expect(actionCounts(store, otherThread)).toEqual({});
          expect(await deliver(store, client, at(30_010))).toEqual({ kind: "delivered", outboxId: limited });
          expect(await deliver(store, client, at(30_010))).toEqual({ kind: "delivered", outboxId: otherThread });
          expect(await deliver(store, client, at(30_010))).toEqual({ kind: "delivered", outboxId: queuedLater });
          expect(requests).toHaveLength(4);
          expect(store.operationalStatus(at(30_011)).outbox).toMatchObject({ pending: 0, rateLimitedUntil: null });
          expect(actionCounts(store, otherThread)).toEqual({ "slack.outbox.claimed": 1, "slack.outbox.delivered": 1 });
          expect(actionCounts(store, queuedLater)).toEqual({ "slack.outbox.claimed": 1, "slack.outbox.delivered": 1 });
        },
      );
      const retry = store.listAuditRecords({ limit: 200 }).find((row) => row.action === "slack.outbox.retry-scheduled");
      expect(retry?.metadata).toMatchObject({ errorCode: "rate_limited", rateLimitedUntil: at(30_010) });
    });
  });

  test("a non-rate-limit retryable error only holds back its own thread", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const failed = enqueue(store, taskId, correlationId, { id: "a-1" });
      const otherThread = enqueue(store, taskId, correlationId, { id: "b-1", threadTs: "2000.000001", createdAt: at(1) });
      await withFakeSlack([platformError("service_unavailable"), ok("1000.000099")], async ({ client }) => {
        expect(await deliver(store, client, at(10))).toMatchObject({ kind: "retry-scheduled", outboxId: failed });
        expect(store.operationalStatus(at(11)).outbox).toMatchObject({ rateLimitedUntil: null });
        expect(await deliver(store, client, at(11))).toEqual({ kind: "delivered", outboxId: otherThread });
      });
    });
  });

  test("an internal_error is quarantined and never resent", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([platformError("internal_error"), ok("1000.000099")], async ({ client, requests }) => {
        expect(await deliver(store, client, start)).toEqual({ kind: "quarantined", outboxId, errorCode: "internal_error" });
        expect(await deliver(store, client, at(3_600_000))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
      });
      expect(store.operationalStatus(at(1)).outbox).toMatchObject({ pending: 0, outcomeUnknown: 1 });
      const quarantine = store.listAuditRecords({ limit: 200 }).find((row) => row.action === "slack.outbox.quarantined");
      expect(quarantine).toMatchObject({ source: outboxId, result: "delivery-outcome-unknown" });
      expect(quarantine?.metadata).toMatchObject({ errorCode: "internal_error" });
    });
  });

  test("a pre-send network error is retried with backoff and then delivered", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      let calls = 0;
      await withFakeSlack([ok("1000.000099")], async ({ client, requests }) => {
        const first = await deliver(store, client, start);
        expect(first).toMatchObject({ kind: "retry-scheduled", outboxId });
        if (first.kind !== "retry-scheduled") throw new Error("expected retry");
        // Bun reports a refused connection as ConnectionRefused; Node/undici as ECONNREFUSED.
        expect(["ConnectionRefused", "ECONNREFUSED"]).toContain(first.errorCode);
        // Attempt 1 with random()=1: the full base delay (5s) of the default policy.
        expect(first.blockedUntil).toBe(at(5_000));
        expect(requests).toHaveLength(0);
        expect(await deliver(store, client, at(4_999))).toEqual({ kind: "idle" });
        expect(await deliver(store, client, at(5_000))).toEqual({ kind: "delivered", outboxId });
        expect(requests).toHaveLength(1);
      }, (real) => {
        const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
          calls += 1;
          // First send goes to a port nothing listens on, so the connection is refused before any bytes are written.
          return calls === 1 ? real("http://127.0.0.1:1/api/chat.postMessage", init) : real(input, init);
        };
        return Object.assign(wrapped, { preconnect: real.preconnect });
      });
    });
  });

  test("the attempt cap terminates a row that keeps being rate limited", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([{ status: 429, headers: { "retry-after": "1" } }], async ({ client, requests }) => {
        let now = start;
        const outcomes: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          const outcome = await deliver(store, client, now, { maxAttempts: 3 });
          outcomes.push(outcome.kind);
          if (outcome.kind === "retry-scheduled") now = outcome.blockedUntil;
          else now = at(24 * 3_600_000);
        }
        expect(outcomes).toEqual(["retry-scheduled", "retry-scheduled", "retry-exhausted", "idle", "idle"]);
        expect(requests).toHaveLength(3);
      });
      const exhausted = store.listAuditRecords({ limit: 200 }).filter((row) => row.action === "slack.outbox.retry-exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]).toMatchObject({ source: outboxId, result: "failed" });
      expect(exhausted[0]?.metadata).toMatchObject({ errorCode: "rate_limited", attempts: 3, retryable: false });
      expect(store.operationalStatus(at(1)).outbox).toMatchObject({ pending: 0, retryBlocked: 0, outcomeUnknown: 0 });
    });
  });

  test("invalid_blocks gets one plain escaped-text fallback, then fails terminally", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const payload: SlackOutboxPayload = {
        text: "Approval required",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Approval required* &lt;!channel&gt; run `rm -rf build`" } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "a", value: "v" }] },
        ],
      };
      const delivered = enqueue(store, taskId, correlationId, { id: "card-1", payload });
      const doomed = enqueue(store, taskId, correlationId, { id: "card-2", payload, createdAt: at(1) });
      await withFakeSlack(
        [platformError("invalid_blocks"), ok("1000.000099"), platformError("invalid_blocks"), platformError("msg_too_long")],
        async ({ client, requests }) => {
          expect(await deliver(store, client, at(10))).toEqual({ kind: "fallback-scheduled", outboxId: delivered, errorCode: "invalid_blocks" });
          expect(await deliver(store, client, at(10))).toEqual({ kind: "delivered", outboxId: delivered });
          expect(await deliver(store, client, at(10))).toEqual({ kind: "fallback-scheduled", outboxId: doomed, errorCode: "invalid_blocks" });
          expect(await deliver(store, client, at(10))).toEqual({ kind: "failed", outboxId: doomed, errorCode: "msg_too_long" });
          expect(await deliver(store, client, at(10))).toEqual({ kind: "idle" });
          expect(requests[0]?.blocks).toBeDefined();
          const fallback = requests[1];
          expect(fallback?.blocks).toBeUndefined();
          expect(fallback?.text).toContain("run `rm -rf build`");
          expect(fallback?.text).not.toContain("<!channel>");
          expect(fallback?.text).toContain("@\u200Bchannel");
          expect(fallback?.text).toContain("respond to this request in T3");
        },
      );
    });
  });

  test("a 429 without a usable Retry-After falls back to exponential backoff", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([{ status: 429 }, ok("1000.000099")], async ({ client }) => {
        expect(await deliver(store, client, start)).toEqual({
          kind: "retry-scheduled", outboxId, errorCode: "rate_limited", blockedUntil: at(5_000),
        });
        expect(await deliver(store, client, at(5_000))).toEqual({ kind: "delivered", outboxId });
      });
    });
  });

  test("deterministic errors fail without a retry", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([platformError("channel_not_found")], async ({ client, requests }) => {
        expect(await deliver(store, client, start)).toEqual({ kind: "failed", outboxId, errorCode: "channel_not_found" });
        expect(await deliver(store, client, at(3_600_000))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
      });
    });
  });
});

describe("Slack outbox claim", () => {
  test("skips blocked rows and keeps later rows of the same thread behind them", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const blocked = enqueue(store, taskId, correlationId, { id: "a-1" });
      const sameThreadLater = enqueue(store, taskId, correlationId, { id: "a-2", createdAt: at(1) });
      const otherThread = enqueue(store, taskId, correlationId, { id: "b-1", threadTs: "2000.000001", createdAt: at(2) });
      const first = store.claimNextOutbox({ workerId: "w", now: at(10), leaseMs: 10_000 });
      expect(first?.outboxId).toBe(blocked);
      store.retryOutbox({ outboxId: blocked, workerId: "w", errorCode: "rate_limited", blockedUntil: at(60_000), now: at(10) });

      expect(store.claimNextOutbox({ workerId: "w", now: at(20), leaseMs: 10_000 })?.outboxId).toBe(otherThread);
      expect(store.claimNextOutbox({ workerId: "w", now: at(20), leaseMs: 10_000 })).toBeNull();
      expect(store.claimNextOutbox({ workerId: "w", now: at(59_999), leaseMs: 10_000 })).toBeNull();

      const retried = store.claimNextOutbox({ workerId: "w", now: at(60_000), leaseMs: 10_000 });
      expect(retried).toMatchObject({ outboxId: blocked, attempt: 2, renderMode: "rich" });
      store.markOutboxDelivered({ outboxId: blocked, workerId: "w", slackMessageTs: "1.1", now: at(60_001) });
      expect(store.claimNextOutbox({ workerId: "w", now: at(60_002), leaseMs: 10_000 })?.outboxId).toBe(sameThreadLater);
    });
  });

  test("a rate-limit cooldown is never shortened and also follows retry exhaustion", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const first = enqueue(store, taskId, correlationId, { id: "a-1" });
      const second = enqueue(store, taskId, correlationId, { id: "b-1", threadTs: "2000.000001", createdAt: at(1) });
      enqueue(store, taskId, correlationId, { id: "c-1", threadTs: "3000.000001", createdAt: at(2) });
      expect(store.claimNextOutbox({ workerId: "w", now: at(10), leaseMs: 10_000 })?.outboxId).toBe(first);
      expect(store.claimNextOutbox({ workerId: "w", now: at(10), leaseMs: 10_000 })?.outboxId).toBe(second);
      store.retryOutbox({
        outboxId: first, workerId: "w", errorCode: "rate_limited", blockedUntil: at(60_000), rateLimitedUntil: at(60_000), now: at(20),
      });
      expect(store.claimNextOutbox({ workerId: "w", now: at(30), leaseMs: 10_000 })).toBeNull();
      // A second in-flight send that hits a shorter limit on its final attempt keeps the longer cooldown.
      store.exhaustOutboxRetries({
        outboxId: second, workerId: "w", errorCode: "rate_limited", attempts: 1, rateLimitedUntil: at(5_000), now: at(30),
      });
      expect(store.operationalStatus(at(5_000)).outbox).toMatchObject({ rateLimitedUntil: at(60_000) });
      expect(store.claimNextOutbox({ workerId: "w", now: at(59_999), leaseMs: 10_000 })).toBeNull();
      expect(store.claimNextOutbox({ workerId: "w", now: at(60_000), leaseMs: 10_000 })?.outboxId).toBe(first);
    });
  });

  test("retry settlement requires a live lease", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "a-1" });
      store.claimNextOutbox({ workerId: "w", now: start, leaseMs: 1_000 });
      expect(() =>
        store.retryOutbox({ outboxId, workerId: "other", errorCode: "rate_limited", blockedUntil: at(5_000), now: at(10) }),
      ).toThrow("outbox lease");
      expect(() =>
        store.retryOutbox({ outboxId, workerId: "w", errorCode: "rate_limited", blockedUntil: at(5_000), now: at(1_000) }),
      ).toThrow("outbox lease");
    });
  });

  test("the service outbox loop idles instead of spinning while every row is blocked", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "a-1" });
      store.claimNextOutbox({ workerId: "w", now: new Date().toISOString(), leaseMs: 10_000 });
      store.retryOutbox({
        outboxId, workerId: "w", errorCode: "rate_limited",
        blockedUntil: new Date(Date.now() + 3_600_000).toISOString(), now: new Date().toISOString(),
      });
      let posts = 0;
      let polls = 0;
      const logs: ServiceLogRecord[] = [];
      const service = new AgentTagService({
        store,
        bridge: {
          start: async () => {},
          stop: async () => {},
          deliverNextOutbox: async () => {
            polls += 1;
            return deliverNextSlackOutbox({
              config, store, workerId: "outbox-a",
              postMessage: async () => { posts += 1; return { ts: "1.1" }; },
            });
          },
        },
        coordinators: [{ processNext: async () => ({ kind: "idle" }) }],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        idleMs: 20,
        logger: (record) => logs.push(record),
      });
      await service.start();
      await Bun.sleep(150);
      await service.stop();
      expect(posts).toBe(0);
      expect(polls).toBeGreaterThan(0);
      expect(polls).toBeLessThanOrEqual(12);
      expect(logs.filter((record) => record.worker === "outbox")).toEqual([]);
    });
  });
});

describe("Slack delivery error classification", () => {
  const platform = (error: string, retryAfter?: number) => ({
    code: "slack_webapi_platform_error",
    data: { ok: false, error, response_metadata: retryAfter === undefined ? {} : { retryAfter } },
  });

  test("known-not-delivered errors are retryable", () => {
    expect(classifySlackDeliveryError({ code: "slack_webapi_rate_limited_error", retryAfter: 12 }))
      .toEqual({ kind: "retryable", errorCode: "rate_limited", retryAfterMs: 12_000 });
    expect(classifySlackDeliveryError(platform("ratelimited", 3)))
      .toEqual({ kind: "retryable", errorCode: "ratelimited", retryAfterMs: 3_000 });
    expect(classifySlackDeliveryError(platform("rate_limited"))).toEqual({ kind: "retryable", errorCode: "rate_limited" });
    expect(classifySlackDeliveryError(platform("service_unavailable")).kind).toBe("retryable");
    expect(classifySlackDeliveryError({ code: "slack_webapi_http_error", statusCode: 429, headers: { "retry-after": "7" } }))
      .toEqual({ kind: "retryable", errorCode: "http_429", retryAfterMs: 7_000 });
    expect(classifySlackDeliveryError(new Error("Retry header did not contain a valid timeout (url: x)")).kind).toBe("retryable");
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"]) {
      expect(classifySlackDeliveryError({ code: "slack_webapi_request_error", original: Object.assign(new Error("x"), { code }) }))
        .toEqual({ kind: "retryable", errorCode: code });
    }
    // undici puts the errno on the fetch error's cause.
    expect(classifySlackDeliveryError({
      code: "slack_webapi_request_error",
      original: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }),
    })).toEqual({ kind: "retryable", errorCode: "ENOTFOUND" });
    expect(classifySlackDeliveryError(Object.assign(new Error("reset"), { code: "ECONNRESET", syscall: "connect" })))
      .toEqual({ kind: "retryable", errorCode: "ECONNRESET" });
  });

  test("ambiguous errors are quarantined", () => {
    for (const error of ["internal_error", "fatal_error", "some_new_error"]) {
      expect(classifySlackDeliveryError(platform(error))).toEqual({ kind: "ambiguous", errorCode: error });
    }
    expect(classifySlackDeliveryError({ code: "slack_webapi_request_error", original: new DOMException("t", "TimeoutError") }))
      .toEqual({ kind: "ambiguous", errorCode: "timeout" });
    // A reset after connecting may follow a fully written request.
    expect(classifySlackDeliveryError(Object.assign(new Error("reset"), { code: "ECONNRESET" })))
      .toEqual({ kind: "ambiguous", errorCode: "ECONNRESET" });
    expect(classifySlackDeliveryError({ code: "slack_webapi_http_error", statusCode: 503, headers: {} }))
      .toEqual({ kind: "ambiguous", errorCode: "http_503" });
    expect(classifySlackDeliveryError(new Error("boom"))).toEqual({ kind: "ambiguous", errorCode: "Error" });
    expect(classifySlackDeliveryError("not an error")).toEqual({ kind: "ambiguous", errorCode: "SlackDeliveryError" });
  });

  test("deterministic errors are terminal; block and length errors allow a plain-text fallback", () => {
    for (const error of ["invalid_blocks", "msg_too_long"]) {
      expect(classifySlackDeliveryError(platform(error))).toEqual({ kind: "terminal", errorCode: error, plainTextFallback: true });
    }
    for (const error of ["channel_not_found", "not_in_channel", "invalid_auth", "is_archived"]) {
      expect(classifySlackDeliveryError(platform(error))).toEqual({ kind: "terminal", errorCode: error, plainTextFallback: false });
    }
  });

  test("backoff is exponential, jittered, capped, and never shorter than Retry-After", () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 10 };
    expect([1, 2, 3, 4, 5, 9].map((attempt) => outboxRetryDelayMs({ attempt, policy, random: () => 1 })))
      .toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(outboxRetryDelayMs({ attempt: 3, policy, random: () => 0 })).toBe(2_000);
    expect(outboxRetryDelayMs({ attempt: 1, policy, random: () => 0, retryAfterMs: 30_000 })).toBe(30_000);
    expect(outboxRetryDelayMs({ attempt: 5, policy, random: () => 1, retryAfterMs: 1_000 })).toBe(10_000);
  });

  test("plain-text fallback escapes mentions and fits one message", () => {
    const long = plainTextFallback({ text: `<!here> ${"x".repeat(50_000)}` });
    expect(long.blocks).toBeUndefined();
    expect(long.text.length).toBeLessThanOrEqual(3_500);
    expect(long.text).not.toContain("<!here>");
    expect(long.text).toContain("truncated");
  });
});
