import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { webApi } from "@slack/bolt";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagService, type ServiceLogRecord } from "../src/service.ts";
import { SLACK_CLIENT_OPTIONS } from "../src/slack/bridge.ts";
import { deliverNextSlackOutbox, type RefreshRenderers, type SlackOutboxOutcome } from "../src/slack/outbox.ts";
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

async function withStore(
  run: (store: AgentTagStore, taskId: string, correlationId: string, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-outbox-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    const receipt = store.ingestSlackEvent({
      deliveryId: "delivery-1", eventKey: "C1:1000.000001", workspaceId: "T1", conversationId: "C1",
      threadTs: "1000.000001", actorUserId: "U1", conversationType: "channel", profileId: "engineering",
      repositoryRoot: root, text: "request", receivedAt: start,
    });
    await run(store, receipt.taskId, receipt.operationId, path);
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

type FakeReply = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** A non-JSON response body, sent verbatim as text/plain. */
  readonly raw?: string;
};

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
      const params = Object.fromEntries(new URLSearchParams(await request.text()));
      requests.push({ ...params, apiMethod: new URL(request.url).pathname.replace("/api/", "") });
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      if (reply === undefined) throw new Error("no fake reply");
      if (reply.raw !== undefined) {
        return new Response(reply.raw, { status: reply.status, headers: { "content-type": "text/plain", ...reply.headers } });
      }
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
  extra: { readonly maxAttempts?: number; readonly refreshRenderers?: RefreshRenderers; readonly config?: typeof config } = {},
): Promise<SlackOutboxOutcome> {
  return deliverNextSlackOutbox({
    config: extra.config ?? config, store, workerId: "outbox-a", now: () => now, random: () => 1,
    ...(extra.maxAttempts === undefined ? {} : { retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: extra.maxAttempts } }),
    ...(extra.refreshRenderers === undefined ? {} : { refreshRenderers: extra.refreshRenderers }),
    postMessage: (message) => client.chat.postMessage(message),
    updateMessage: (message) => client.chat.update(message),
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

  test("a non-JSON response body is quarantined without storing its contents", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const outboxId = enqueue(store, taskId, correlationId, { id: "reply-1" });
      await withFakeSlack([{ status: 200, raw: "private task canary xoxb-secret-canary" }], async ({ client }) => {
        expect(await deliver(store, client, start))
          .toEqual({ kind: "quarantined", outboxId, errorCode: "unrecognized_platform_error" });
      });
      const audit = JSON.stringify(store.listAuditRecords({ limit: 200 }));
      expect(audit).not.toContain("canary");
      expect(audit).toContain("unrecognized_platform_error");
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
              updateMessage: async () => { posts += 1; return { ts: "1.1" }; },
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

describe("Slack message edits (chat.update)", () => {
  const card = (text: string): SlackOutboxPayload => ({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  /** update rows in the store, read straight from SQLite; also checks method='update' <=> target set. */
  function editRows(path: string): Array<{ outbox_id: string; status: string; refresh_kind: string | null }> {
    const database = new Database(path, { readonly: true, strict: true });
    try {
      expect(database.query("SELECT COUNT(*) AS n FROM slack_outbox WHERE (method = 'update') != (target_outbox_id IS NOT NULL)").get())
        .toEqual({ n: 0 });
      return database
        .query<{ outbox_id: string; status: string; refresh_kind: string | null }, []>(
          "SELECT outbox_id, status, refresh_kind FROM slack_outbox WHERE method = 'update' ORDER BY rowid",
        )
        .all();
    } finally {
      database.close();
    }
  }
  function edit(store: AgentTagStore, text: string, now = at(100)): string {
    const result = store.enqueueMessageEdit({ targetClientMessageId: "card-1", payload: { text }, now });
    if (result === null) throw new Error("expected an edit row");
    return result.outboxId;
  }

  test("an edit updates the target's message by its ts and replaces its blocks", async () => {
    await withStore(async (store, taskId, correlationId, path) => {
      const post = enqueue(store, taskId, correlationId, { id: "card-1", payload: card("Approval needed") });
      await withFakeSlack([ok("1000.000050"), ok("1000.000050")], async ({ client, requests }) => {
        expect(await deliver(store, client, at(10))).toEqual({ kind: "delivered", outboxId: post });
        const edited = edit(store, "Approved by <@U1>");
        expect(await deliver(store, client, at(100))).toEqual({ kind: "delivered", outboxId: edited });
        expect(requests[1]).toMatchObject({ apiMethod: "chat.update", channel: "C1", ts: "1000.000050", text: "Approved by <@U1>", blocks: "[]" });
        expect(requests[1]?.thread_ts).toBeUndefined();
        expect(requests).toHaveLength(2);
      });
      expect(editRows(path)).toEqual([{ outbox_id: expect.any(String), status: "delivered", refresh_kind: null }]);
      const enqueued = store.listAuditRecords({ limit: 200 }).find((row) => row.action === "slack.outbox.enqueued" && row.target !== post);
      expect(enqueued?.metadata).toMatchObject({ method: "update", targetOutboxId: post });
    });
  });

  test("an edit queued behind its rate-limited post waits for the post, then uses its ts", async () => {
    await withStore(async (store, taskId, correlationId) => {
      enqueue(store, taskId, correlationId, { id: "card-1", payload: card("Approval needed") });
      const edited = edit(store, "Approved", at(1));
      await withFakeSlack([{ status: 429, headers: { "retry-after": "30" } }, ok("1000.000051"), ok("1000.000051")], async ({ client, requests }) => {
        expect(await deliver(store, client, at(10))).toMatchObject({ kind: "retry-scheduled", errorCode: "rate_limited" });
        expect(await deliver(store, client, at(29_000))).toEqual({ kind: "idle" });
        expect((await deliver(store, client, at(30_010))).kind).toBe("delivered");
        expect(await deliver(store, client, at(30_010))).toEqual({ kind: "delivered", outboxId: edited });
        expect(requests.map((request) => [request.apiMethod, request.ts])).toEqual([
          ["chat.postMessage", undefined], ["chat.postMessage", undefined], ["chat.update", "1000.000051"],
        ]);
      });
    });
  });

  test("an edit whose post is still in flight is not claimed until the post is delivered", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const post = enqueue(store, taskId, correlationId, { id: "card-1" });
      expect(store.claimNextOutbox({ workerId: "other", now: at(1), leaseMs: 60_000 })?.outboxId).toBe(post);
      const edited = edit(store, "Approved", at(2));
      await withFakeSlack([ok("1000.000052")], async ({ client, requests }) => {
        for (const offset of [10, 2_010, 4_010]) {
          expect(await deliver(store, client, at(offset), { maxAttempts: 1 })).toEqual({ kind: "idle" });
        }
        store.markOutboxDelivered({ outboxId: post, workerId: "other", slackMessageTs: "1000.000052", now: at(5_000) });
        expect(await deliver(store, client, at(5_001), { maxAttempts: 1 })).toEqual({ kind: "delivered", outboxId: edited });
        expect(requests).toMatchObject([{ apiMethod: "chat.update", ts: "1000.000052" }]);
      });
      const claims = store.listAuditRecords({ limit: 200 }).filter((row) => row.action === "slack.outbox.claimed" && row.source === edited);
      expect(claims.map((row) => row.metadata.attempt)).toEqual([1]);
    });
  });

  test("an edit of a post that failed is dropped; none is enqueued afterwards", async () => {
    await withStore(async (store, taskId, correlationId, path) => {
      enqueue(store, taskId, correlationId, { id: "card-1" });
      const edited = edit(store, "Approved", at(1));
      await withFakeSlack([platformError("channel_not_found")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("failed");
        expect(await deliver(store, client, at(10))).toEqual({ kind: "failed", outboxId: edited, errorCode: "TargetNotDelivered" });
        expect(requests).toHaveLength(1);
      });
      expect(store.enqueueMessageEdit({ targetClientMessageId: "card-1", payload: { text: "x" }, now: at(20) })).toBeNull();
      expect(store.enqueueMessageEdit({ targetClientMessageId: "never-posted", payload: { text: "x" }, now: at(20) })).toBeNull();
      expect(editRows(path)).toHaveLength(1);
    });
  });

  test("refresh rows coalesce to one pending row and render the latest state at delivery", async () => {
    await withStore(async (store, taskId, correlationId, path) => {
      enqueue(store, taskId, correlationId, { id: "card-1", payload: card("v0") });
      let state = "v1";
      const renderedKeys: string[] = [];
      const refreshRenderers: RefreshRenderers = {
        "interaction-card": (key) => { renderedKeys.push(key); return card(`${key} ${state}`); },
      };
      const refresh = (now: string) =>
        store.enqueueMessageRefresh({ targetClientMessageId: "card-1", refreshKind: "interaction-card", refreshKey: "interaction-1", now });
      await withFakeSlack([ok("1000.000053")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        const first = refresh(at(20));
        expect(first?.reused).toBe(false);
        const outboxId = z.string().parse(first?.outboxId);
        expect(refresh(at(21))).toEqual({ outboxId, reused: true });
        expect(refresh(at(22))).toEqual({ outboxId, reused: true });
        expect(editRows(path)).toEqual([{ outbox_id: outboxId, status: "pending", refresh_kind: "interaction-card" }]);
        state = "v3";
        expect(await deliver(store, client, at(30), { refreshRenderers })).toEqual({ kind: "delivered", outboxId });
        expect(renderedKeys).toEqual(["interaction-1"]);
        expect(requests[1]).toMatchObject({ apiMethod: "chat.update", ts: "1000.000053", text: "interaction-1 v3" });
        expect(JSON.parse(requests[1]?.blocks ?? "[]")).toEqual(card("interaction-1 v3").blocks);
      });
      const enqueued = store.listAuditRecords({ limit: 200 }).filter((row) => row.action === "slack.outbox.enqueued" && row.correlationId === "interaction-1");
      expect(enqueued.map((row) => row.result)).toEqual(["pending", "coalesced", "coalesced"]);
    });
  });

  test("an edit requested while the previous one is in flight lands after it, and the latest wins", async () => {
    await withStore(async (store, taskId, correlationId, path) => {
      enqueue(store, taskId, correlationId, { id: "card-1" });
      await withFakeSlack([ok("1000.000054")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        const first = edit(store, "one", at(20));
        expect(store.claimNextOutbox({ workerId: "outbox-a", now: at(21), leaseMs: 10_000 })?.outboxId).toBe(first);
        const second = edit(store, "two", at(22));
        expect(second).not.toBe(first);
        expect(edit(store, "three", at(23))).toBe(second);
        // The in-flight edit is retried; the newer one must not overtake it.
        store.retryOutbox({ outboxId: first, workerId: "outbox-a", errorCode: "service_unavailable", blockedUntil: at(5_000), now: at(24) });
        expect(await deliver(store, client, at(30))).toEqual({ kind: "idle" });
        expect(await deliver(store, client, at(5_000))).toEqual({ kind: "delivered", outboxId: first });
        expect(await deliver(store, client, at(5_000))).toEqual({ kind: "delivered", outboxId: second });
        expect(requests.map((request) => request.text)).toEqual(["message card-1", "one", "three"]);
      });
      expect(editRows(path).map((row) => row.status)).toEqual(["delivered", "delivered"]);
    });
  });

  test("edits of one message apply in enqueue order even when their timestamps disagree", async () => {
    await withStore(async (store, taskId, correlationId) => {
      enqueue(store, taskId, correlationId, { id: "card-1" });
      await withFakeSlack([ok("1000.000059")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        const first = edit(store, "older", at(50));
        expect(store.claimNextOutbox({ workerId: "outbox-a", now: at(51), leaseMs: 10_000 })?.outboxId).toBe(first);
        // Enqueued later but stamped earlier (clock step): claim order alone would send it first.
        const second = edit(store, "newer", at(40));
        store.retryOutbox({ outboxId: first, workerId: "outbox-a", errorCode: "service_unavailable", blockedUntil: at(52), now: at(52) });
        expect(await deliver(store, client, at(60))).toEqual({ kind: "delivered", outboxId: first });
        expect(await deliver(store, client, at(60))).toEqual({ kind: "delivered", outboxId: second });
        expect(requests.slice(1).map((request) => request.text)).toEqual(["older", "newer"]);
      });
    });
  });

  test("a 429 on an edit is retried with backoff and then delivered", async () => {
    await withStore(async (store, taskId, correlationId) => {
      enqueue(store, taskId, correlationId, { id: "card-1" });
      await withFakeSlack([ok("1000.000055"), { status: 429, headers: { "retry-after": "20" } }, ok("1000.000055")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        const edited = edit(store, "Approved");
        expect(await deliver(store, client, at(100))).toEqual({
          kind: "retry-scheduled", outboxId: edited, errorCode: "rate_limited", blockedUntil: at(20_100),
        });
        expect(await deliver(store, client, at(20_099))).toEqual({ kind: "idle" });
        expect(await deliver(store, client, at(20_100))).toEqual({ kind: "delivered", outboxId: edited });
        expect(requests.filter((request) => request.apiMethod === "chat.update")).toHaveLength(2);
      });
    });
  });

  test("terminal edit errors fail at once, with no retry and no plain-text fallback", async () => {
    const codes = ["message_not_found", "cant_update_message", "edit_window_closed", "invalid_blocks", "msg_too_long", "missing_scope"];
    await withStore(async (store, taskId, correlationId) => {
      enqueue(store, taskId, correlationId, { id: "card-1", payload: card("Approval needed") });
      await withFakeSlack([ok("1000.000056"), ...codes.map(platformError)], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        for (const [index, code] of codes.entries()) {
          const edited = edit(store, `edit ${index}`, at(100 + index));
          expect(await deliver(store, client, at(100 + index))).toEqual({ kind: "failed", outboxId: edited, errorCode: code });
        }
        expect(await deliver(store, client, at(3_600_000))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1 + codes.length);
      });
    });
  });

  test("a refresh fails when its source is gone, its kind has no renderer, or authority was revoked", async () => {
    await withStore(async (store, taskId, correlationId) => {
      enqueue(store, taskId, correlationId, { id: "card-1" });
      const refresh = (now: string): string =>
        z.string().parse(store.enqueueMessageRefresh({
          targetClientMessageId: "card-1", refreshKind: "interaction-card", refreshKey: "interaction-1", now,
        })?.outboxId);
      const revoked = agentTagConfigSchema.parse({ ...config, slack: { ...config.slack, workspaceId: "T9" } });
      await withFakeSlack([ok("1000.000057")], async ({ client, requests }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
        const gone = refresh(at(20));
        expect(await deliver(store, client, at(20), { refreshRenderers: { "interaction-card": () => null } }))
          .toEqual({ kind: "failed", outboxId: gone, errorCode: "RefreshSourceMissing" });
        const unregistered = refresh(at(21));
        expect(await deliver(store, client, at(21))).toEqual({ kind: "failed", outboxId: unregistered, errorCode: "RefreshKindUnsupported" });
        const denied = refresh(at(22));
        expect(await deliver(store, client, at(22), { config: revoked, refreshRenderers: { "interaction-card": () => card("x") } }))
          .toEqual({ kind: "failed", outboxId: denied, errorCode: "ExecutionAuthorityDenied" });
        expect(requests).toHaveLength(1);
      });
      expect(() => store.enqueueMessageRefresh({
        targetClientMessageId: "card-1", refreshKind: "no-such-kind" as "interaction-card", refreshKey: "k", now: at(30),
      })).toThrow();
    });
  });

  /** Runs the outbox like the service loop, 2.001s apart, until idle or `maxSteps`; returns the outcomes. */
  async function drain(
    store: AgentTagStore,
    client: InstanceType<typeof webApi.WebClient>,
    from: number,
    extra: { readonly refreshRenderers?: RefreshRenderers } = {},
    maxSteps = 12,
  ): Promise<SlackOutboxOutcome[]> {
    const outcomes: SlackOutboxOutcome[] = [];
    for (let step = 0; step < maxSteps; step += 1) {
      const outcome = await deliver(store, client, at(from + step * 2_001), extra);
      if (outcome.kind === "idle") break;
      outcomes.push(outcome);
    }
    return outcomes;
  }
  const renderers: RefreshRenderers = { "interaction-card": (key) => card(`${key} rendered`) };

  test("an edit that sorts before its pending post by correlation id never blocks that post", async () => {
    await withStore(async (store, taskId) => {
      // Same created_at; the refresh's correlation id ("a-…") sorts before the post's ("z-…").
      const post = enqueue(store, taskId, "z-post", { id: "card-1", payload: card("Approval needed"), createdAt: at(5) });
      const refreshed = store.enqueueMessageRefresh({
        targetClientMessageId: "card-1", refreshKind: "interaction-card", refreshKey: "a-interaction", now: at(5),
      });
      await withFakeSlack([ok("1000.000060")], async ({ client, requests }) => {
        expect(await drain(store, client, 10, { refreshRenderers: renderers })).toEqual([
          { kind: "delivered", outboxId: post },
          { kind: "delivered", outboxId: z.string().parse(refreshed?.outboxId) },
        ]);
        expect(requests.map((request) => [request.apiMethod, request.ts])).toEqual([
          ["chat.postMessage", undefined], ["chat.update", "1000.000060"],
        ]);
      });
    });
  });

  test("an edit that ties its pending post and sorts first by outbox id never blocks that post", async () => {
    await withStore(async (store, taskId, correlationId) => {
      // Static edits share the post's correlation id and created_at, so outbox_id (random) decides
      // claim order. 32 pairs make an edit-first pair certain in practice.
      const pairs = Array.from({ length: 32 }, (_, index) => {
        const post = enqueue(store, taskId, correlationId, { id: `card-${index}`, threadTs: `3000.${index}`, createdAt: at(5) });
        const edited = store.enqueueMessageEdit({ targetClientMessageId: `card-${index}`, payload: { text: `edit ${index}` }, now: at(5) });
        return { post, edited: z.string().parse(edited?.outboxId) };
      });
      expect(pairs.some((pair) => pair.edited < pair.post)).toBe(true);
      await withFakeSlack([ok("3000.000001")], async ({ client, requests }) => {
        const outcomes = await drain(store, client, 10, {}, 80);
        expect(outcomes.every((outcome) => outcome.kind === "delivered")).toBe(true);
        expect(outcomes).toHaveLength(64);
        expect(requests.filter((request) => request.apiMethod === "chat.update")).toHaveLength(32);
      });
    });
  });

  test("an edit stamped before its post by a backward clock step still lands after the post", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const post = enqueue(store, taskId, correlationId, { id: "card-1", createdAt: at(100) });
      const edited = edit(store, "Approved", at(50));
      await withFakeSlack([ok("1000.000061")], async ({ client, requests }) => {
        expect(await drain(store, client, 110)).toEqual([
          { kind: "delivered", outboxId: post },
          { kind: "delivered", outboxId: edited },
        ]);
        expect(requests.map((request) => [request.apiMethod, request.text])).toEqual([
          ["chat.postMessage", "message card-1"], ["chat.update", "Approved"],
        ]);
      });
    });
  });

  test("an edit of a later post never blocks an earlier, unrelated post it sorts before", async () => {
    await withStore(async (store, taskId) => {
      // Thread order: edit(card-2) < card-1 < card-2. card-2 waits on card-1; the edit waits on card-2.
      const first = enqueue(store, taskId, "z-1", { id: "card-1", createdAt: at(5) });
      const second = enqueue(store, taskId, "z-2", { id: "card-2", createdAt: at(5) });
      const refreshed = store.enqueueMessageRefresh({
        targetClientMessageId: "card-2", refreshKind: "interaction-card", refreshKey: "a-interaction", now: at(5),
      });
      await withFakeSlack([ok("1000.000062"), ok("1000.000063"), ok("1000.000063")], async ({ client, requests }) => {
        expect(await drain(store, client, 10, { refreshRenderers: renderers })).toEqual([
          { kind: "delivered", outboxId: first },
          { kind: "delivered", outboxId: second },
          { kind: "delivered", outboxId: z.string().parse(refreshed?.outboxId) },
        ]);
        expect(requests.at(-1)).toMatchObject({ apiMethod: "chat.update", ts: "1000.000063" });
      });
    });
  });

  test("an edit waiting on an in-flight post never delays later posts in its thread", async () => {
    await withStore(async (store, taskId, correlationId) => {
      const target = enqueue(store, taskId, correlationId, { id: "card-1", createdAt: at(1) });
      expect(store.claimNextOutbox({ workerId: "other", now: at(2), leaseMs: 60_000 })?.outboxId).toBe(target);
      const edited = edit(store, "Approved", at(3));
      const later = enqueue(store, taskId, correlationId, { id: "reply-1", createdAt: at(4) });
      await withFakeSlack([ok("1000.000064"), ok("1000.000065")], async ({ client, requests }) => {
        expect(await drain(store, client, 10)).toEqual([{ kind: "delivered", outboxId: later }]);
        store.markOutboxDelivered({ outboxId: target, workerId: "other", slackMessageTs: "1000.000065", now: at(30_000) });
        expect(await drain(store, client, 30_001)).toEqual([{ kind: "delivered", outboxId: edited }]);
        expect(requests.map((request) => [request.apiMethod, request.ts])).toEqual([
          ["chat.postMessage", undefined], ["chat.update", "1000.000065"],
        ]);
      });
    });
  });

  test("a pending edit survives a restart and is delivered afterwards", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-edit-restart-"));
    const path = join(directory, "agent-tag.sqlite");
    try {
      let store = await AgentTagStore.open(path);
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1", eventKey: "C1:1000.000001", workspaceId: "T1", conversationId: "C1",
        threadTs: "1000.000001", actorUserId: "U1", conversationType: "channel", profileId: "engineering",
        repositoryRoot: root, text: "request", receivedAt: start,
      });
      enqueue(store, receipt.taskId, receipt.operationId, { id: "card-1" });
      await withFakeSlack([ok("1000.000058")], async ({ client }) => {
        expect((await deliver(store, client, at(10))).kind).toBe("delivered");
      });
      const edited = edit(store, "Approved");
      store.close();

      store = await AgentTagStore.open(path);
      try {
        expect(store.quarantineExpiredOutbox(at(200))).toBe(0);
        await withFakeSlack([ok("1000.000058")], async ({ client, requests }) => {
          expect(await deliver(store, client, at(200))).toEqual({ kind: "delivered", outboxId: edited });
          expect(requests).toMatchObject([{ apiMethod: "chat.update", ts: "1000.000058", text: "Approved" }]);
        });
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true });
    }
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
    for (const error of ["internal_error", "fatal_error"]) {
      expect(classifySlackDeliveryError(platform(error))).toEqual({ kind: "ambiguous", errorCode: error });
    }
    expect(classifySlackDeliveryError(platform("some_new_error")))
      .toEqual({ kind: "ambiguous", errorCode: "unrecognized_platform_error" });
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

  test("reported error codes never carry response text or secrets", () => {
    // The WebClient puts a whole non-JSON 200 body into data.error.
    const leaked = classifySlackDeliveryError(platform("private task canary xoxb-secret-canary"));
    expect(leaked).toEqual({ kind: "ambiguous", errorCode: "unrecognized_platform_error" });
    expect(classifySlackDeliveryError({ code: "slack_webapi_platform_error", data: { ok: false } }))
      .toEqual({ kind: "ambiguous", errorCode: "unrecognized_platform_error" });
    expect(classifySlackDeliveryError(Object.assign(new Error("x"), { code: "E xoxb-secret-canary" })))
      .toEqual({ kind: "ambiguous", errorCode: "network_error" });
    expect(classifySlackDeliveryError(Object.assign(new Error("x"), { name: "private xoxb-secret-canary" })))
      .toEqual({ kind: "ambiguous", errorCode: "SlackDeliveryError" });
  });

  test("chat.update rejections of the message itself are terminal without a fallback", () => {
    for (const error of ["message_not_found", "cant_update_message", "edit_window_closed"]) {
      expect(classifySlackDeliveryError(platform(error))).toEqual({ kind: "terminal", errorCode: error, plainTextFallback: false });
    }
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
