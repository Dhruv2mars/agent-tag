import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { webApi } from "@slack/bolt";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { SLACK_CLIENT_OPTIONS } from "../src/slack/bridge.ts";
import type { OutboxRetryPolicy } from "../src/slack/outbox-policy.ts";
import { deliverNextSlackReaction, type SlackReactionAdd } from "../src/slack/reactions.ts";
import { AgentTagStore, type IngestReceipt } from "../src/store/store.ts";

const start = "2026-10-06T00:00:00.000Z";
const messageTs = "1000.000001";
const LEASE_MS = 30_000;

function at(offsetMs: number): string {
  return new Date(new Date(start).getTime() + offsetMs).toISOString();
}

const exampleConfig = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

const config = agentTagConfigSchema.parse({
  ...exampleConfig,
  slack: { workspaceId: "T1", appTokenFile: "/secrets/app", botTokenFile: "/secrets/bot" },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  routes: [{ conversationId: "C1", profileId: "engineering" }],
});
// The schema rejects a route whose channel is not allowed, so the revoked config is derived from the
// valid one: the route still points at C1 and only the channel allowlist no longer includes it.
const revokedConfig: typeof config = {
  ...config,
  access: { ...config.access, allowedChannelIds: ["C2"] },
};
const root = z.string().parse(config.profiles[0]?.repositoryRoots[0]);

async function withStore(run: (store: AgentTagStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-reactions-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
}

interface IngestOptions {
  readonly deliveryId: string;
  readonly eventKey: string;
  readonly receivedAt: string;
  readonly messageTs?: string;
  readonly ackReaction?: string;
}

function ingest(store: AgentTagStore, event: IngestOptions): IngestReceipt {
  return store.ingestSlackEvent({
    deliveryId: event.deliveryId,
    eventKey: event.eventKey,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: root,
    text: "request",
    receivedAt: event.receivedAt,
    ...(event.messageTs === undefined ? {} : { messageTs: event.messageTs }),
    ...(event.ackReaction === undefined ? {} : { ackReaction: event.ackReaction }),
  });
}

/** An accepted mention whose ack reaction goes on message `1000.00000<n>`. */
function ackEvent(store: AgentTagStore, n: number, receivedAt = start): IngestReceipt {
  return ingest(store, {
    deliveryId: `delivery-${n}`,
    eventKey: `C1:1000.00000${n}`,
    receivedAt,
    messageTs: `1000.00000${n}`,
    ackReaction: "eyes",
  });
}

function ackKey(receipt: IngestReceipt): string {
  return `${receipt.operationId}:ack`;
}

function readRows<T>(path: string, sql: string): T[] {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database.query<T, []>(sql).all();
  } finally {
    database.close();
  }
}

interface ReactionRow {
  readonly reaction_key: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_error_code: string | null;
  readonly blocked_until: string | null;
  readonly lease_owner: string | null;
  readonly message_ts: string;
  readonly name: string;
  readonly conversation_id: string;
}

const REACTION_COLUMNS =
  "reaction_key, status, attempts, last_error_code, blocked_until, lease_owner, message_ts, name, conversation_id";

function reactionRows(path: string): ReactionRow[] {
  return readRows<ReactionRow>(path, `SELECT ${REACTION_COLUMNS} FROM slack_reactions ORDER BY created_at, reaction_key`);
}

function reactionRow(path: string, key: string): ReactionRow {
  const row = reactionRows(path).find((candidate) => candidate.reaction_key === key);
  if (row === undefined) throw new Error(`no slack_reactions row ${key}`);
  return row;
}

function rateLimitRows(path: string): Array<{ scope: string; blocked_until: string; error_code: string }> {
  return readRows(path, "SELECT scope, blocked_until, error_code FROM slack_rate_limits ORDER BY scope");
}

function writeRateLimit(path: string, scope: string, blockedUntil: string, errorCode: string): void {
  const database = new Database(path, { strict: true });
  try {
    database
      .query("INSERT INTO slack_rate_limits (scope, blocked_until, error_code, updated_at) VALUES (?, ?, ?, ?)")
      .run(scope, blockedUntil, errorCode, start);
  } finally {
    database.close();
  }
}

/** The audit rows written for one reaction (its reaction key is the audit source). */
function auditFor(store: AgentTagStore, key: string): Array<{ action: string; result: string }> {
  return store
    .listAuditRecords({ limit: 200 })
    .filter((row) => row.source === key)
    .map((row) => ({ action: row.action, result: row.result }));
}

function enqueueReply(store: AgentTagStore, receipt: IngestReceipt): string {
  return store.enqueueOutbox({
    taskId: receipt.taskId,
    correlationId: receipt.operationId,
    conversationId: "C1",
    threadTs: "1000.000001",
    clientMessageId: "reply-1",
    payload: { text: "reply" },
    createdAt: start,
  }).outboxId;
}

type FakeReply = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
};

/** A local stand-in for slack.com/api driven through the real Slack WebClient with production options. */
async function withFakeSlack(
  replies: ReadonlyArray<FakeReply>,
  run: (input: {
    readonly client: InstanceType<typeof webApi.WebClient>;
    readonly requests: Array<Record<string, string>>;
  }) => Promise<void>,
): Promise<void> {
  const requests: Array<Record<string, string>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const params = Object.fromEntries(new URLSearchParams(await request.text()));
      requests.push({ ...params, apiMethod: new URL(request.url).pathname.replace(/^\/api\//, "") });
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
    });
    await run({ client, requests });
  } finally {
    await server.stop(true);
  }
}

const ok: FakeReply = { status: 200, body: { ok: true } };
const platformError = (error: string): FakeReply => ({ status: 200, body: { ok: false, error } });

type AddReaction = (reaction: SlackReactionAdd) => Promise<unknown>;

/** reactions.add through the real WebClient, recording each request the code under test makes. */
function addVia(client: InstanceType<typeof webApi.WebClient>, calls: SlackReactionAdd[]): AddReaction {
  return async (reaction) => {
    calls.push(reaction);
    return client.reactions.add(reaction);
  };
}

function deliver(
  store: AgentTagStore,
  now: string,
  addReaction: AddReaction,
  extra: { readonly config?: typeof config; readonly retryPolicy?: OutboxRetryPolicy } = {},
) {
  return deliverNextSlackReaction({
    config: extra.config ?? config,
    store,
    workerId: "reaction-a",
    now: () => now,
    random: () => 0,
    addReaction,
    ...(extra.retryPolicy === undefined ? {} : { retryPolicy: extra.retryPolicy }),
  });
}

describe("Slack reaction queue: ingest", () => {
  test("an accepted mention queues one pending ack reaction, and redeliveries queue no second row", async () => {
    await withStore(async (store, path) => {
      const receipt = ackEvent(store, 1);
      expect(receipt.kind).toBe("accepted");
      const key = ackKey(receipt);
      expect(reactionRows(path)).toEqual([
        {
          reaction_key: key, status: "pending", attempts: 0, last_error_code: null, blocked_until: null,
          lease_owner: null, message_ts: messageTs, name: "eyes", conversation_id: "C1",
        },
      ]);

      // Same delivery id, then a new delivery id for the same event key: both are duplicates.
      expect(ingest(store, { deliveryId: "delivery-1", eventKey: "C1:1000.000001", receivedAt: start, messageTs, ackReaction: "eyes" }).kind)
        .toBe("duplicate");
      expect(ingest(store, { deliveryId: "delivery-2", eventKey: "C1:1000.000001", receivedAt: start, messageTs, ackReaction: "eyes" }).kind)
        .toBe("duplicate");
      expect(reactionRows(path).map((row) => row.reaction_key)).toEqual([key]);
    });
  });

  test("an event without ackReaction, or without messageTs, queues no reaction", async () => {
    await withStore(async (store, path) => {
      expect(ingest(store, { deliveryId: "delivery-1", eventKey: "C1:1000.000001", receivedAt: start, messageTs }).kind)
        .toBe("accepted");
      expect(ingest(store, { deliveryId: "delivery-2", eventKey: "C1:1000.000002", receivedAt: start, ackReaction: "eyes" }).kind)
        .toBe("accepted");
      expect(reactionRows(path)).toEqual([]);
    });
  });
});

describe("Slack reaction queue: claims and leases", () => {
  test("claims the oldest pending reaction first and never hands out a leased one", async () => {
    await withStore(async (store, path) => {
      const first = ackEvent(store, 1, start);
      const second = ackEvent(store, 2, at(1_000));

      const claimA = store.claimNextReaction({ workerId: "reaction-a", now: at(2_000), leaseMs: LEASE_MS });
      expect(claimA).toEqual({
        reactionKey: ackKey(first), taskId: first.taskId, operationId: first.operationId, conversationId: "C1",
        messageTs, name: "eyes", attempt: 1, lastErrorCode: null,
      });
      expect(reactionRow(path, ackKey(first))).toMatchObject({
        status: "inflight", attempts: 1, lease_owner: "reaction-a", blocked_until: null,
      });

      expect(store.claimNextReaction({ workerId: "reaction-b", now: at(2_000), leaseMs: LEASE_MS })?.reactionKey)
        .toBe(ackKey(second));
      expect(store.claimNextReaction({ workerId: "reaction-c", now: at(2_000), leaseMs: LEASE_MS })).toBeNull();
    });
  });

  test("a leased reaction is reclaimed only after its lease expires, with attempt 2", async () => {
    await withStore(async (store, path) => {
      const receipt = ackEvent(store, 1);
      const key = ackKey(receipt);
      expect(store.claimNextReaction({ workerId: "reaction-a", now: start, leaseMs: LEASE_MS })?.attempt).toBe(1);
      expect(store.claimNextReaction({ workerId: "reaction-b", now: at(29_999), leaseMs: LEASE_MS })).toBeNull();

      expect(store.claimNextReaction({ workerId: "reaction-b", now: at(31_000), leaseMs: LEASE_MS })).toMatchObject({
        reactionKey: key, attempt: 2,
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "inflight", attempts: 2, lease_owner: "reaction-b" });
    });
  });

  test("a reaction retried with blockedUntil is claimable only from that instant", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      expect(store.claimNextReaction({ workerId: "reaction-a", now: start, leaseMs: LEASE_MS })?.attempt).toBe(1);
      store.retryReaction({
        reactionKey: key, workerId: "reaction-a", now: start, errorCode: "internal_error", blockedUntil: at(5_000),
      });
      expect(reactionRow(path, key)).toMatchObject({
        status: "pending", attempts: 1, blocked_until: at(5_000), last_error_code: "internal_error", lease_owner: null,
      });

      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(4_999), leaseMs: LEASE_MS })).toBeNull();
      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(5_000), leaseMs: LEASE_MS })).toMatchObject({
        reactionKey: key, attempt: 2,
      });
    });
  });

  test("a reactions rate limit pauses every reaction but not the outbox, and clears at rateLimitedUntil", async () => {
    await withStore(async (store, path) => {
      const receipt = ackEvent(store, 1);
      const key = ackKey(receipt);
      expect(store.claimNextReaction({ workerId: "reaction-a", now: start, leaseMs: LEASE_MS })?.attempt).toBe(1);
      store.retryReaction({
        reactionKey: key, workerId: "reaction-a", now: start, errorCode: "ratelimited",
        blockedUntil: at(1_000), rateLimitedUntil: at(60_000),
      });
      expect(rateLimitRows(path)).toEqual([{ scope: "reactions.add", blocked_until: at(60_000), error_code: "ratelimited" }]);

      // The reaction is past its own backoff, so only the cooldown keeps it back.
      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(30_000), leaseMs: LEASE_MS })).toBeNull();
      const outboxId = enqueueReply(store, receipt);
      expect(store.claimNextOutbox({ workerId: "outbox-a", now: at(30_000), leaseMs: LEASE_MS })?.outboxId).toBe(outboxId);

      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(59_999), leaseMs: LEASE_MS })).toBeNull();
      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(60_000), leaseMs: LEASE_MS })).toMatchObject({
        reactionKey: key, attempt: 2,
      });
    });
  });

  test("an outbox rate limit does not block reaction claims", async () => {
    await withStore(async (store, path) => {
      const receipt = ackEvent(store, 1);
      writeRateLimit(path, "chat.postMessage", at(60_000), "ratelimited");
      enqueueReply(store, receipt);

      expect(store.claimNextReaction({ workerId: "reaction-a", now: at(30_000), leaseMs: LEASE_MS })).toMatchObject({
        reactionKey: ackKey(receipt), attempt: 1,
      });
      // The outbox side of the same scope split is blocked, as intended.
      expect(store.claimNextOutbox({ workerId: "outbox-a", now: at(30_000), leaseMs: LEASE_MS })).toBeNull();
    });
  });

  test("settling with a lost lease throws and leaves the row untouched", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      expect(store.claimNextReaction({ workerId: "reaction-a", now: start, leaseMs: LEASE_MS })?.attempt).toBe(1);

      expect(() => store.markReactionDelivered({ reactionKey: key, workerId: "reaction-b", now: at(1_000) }))
        .toThrow(/reaction lease is missing/);
      expect(() => store.failReaction({ reactionKey: key, workerId: "reaction-b", now: at(1_000), errorCode: "missing_scope" }))
        .toThrow(/reaction lease is missing/);
      expect(() => store.retryReaction({
        reactionKey: key, workerId: "reaction-b", now: at(1_000), errorCode: "internal_error", blockedUntil: at(5_000),
      })).toThrow(/reaction lease is missing/);

      expect(reactionRow(path, key)).toMatchObject({ status: "inflight", attempts: 1, lease_owner: "reaction-a" });
      expect(auditFor(store, key)).toEqual([]);

      // The rightful owner can still settle it.
      store.markReactionDelivered({ reactionKey: key, workerId: "reaction-a", now: at(1_000) });
      expect(reactionRow(path, key)).toMatchObject({ status: "delivered", lease_owner: null });
    });
  });
});

describe("Slack reaction delivery", () => {
  test("a successful reactions.add sends the exact request and marks the reaction delivered", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const calls: SlackReactionAdd[] = [];
      await withFakeSlack([ok], async ({ client, requests }) => {
        const add = addVia(client, calls);
        expect(await deliver(store, start, add)).toEqual({ kind: "reaction-added", reactionKey: key });
        expect(await deliver(store, at(1_000), add)).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ apiMethod: "reactions.add", channel: "C1", timestamp: messageTs, name: "eyes" });
      });
      expect(calls).toEqual([{ channel: "C1", timestamp: messageTs, name: "eyes" }]);
      expect(reactionRow(path, key)).toMatchObject({ status: "delivered", attempts: 1, last_error_code: null, lease_owner: null });
      expect(auditFor(store, key)).toEqual([{ action: "slack.reaction.added", result: "delivered" }]);
    });
  });

  test("already_reacted counts as added and records the platform error code", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      await withFakeSlack([platformError("already_reacted")], async ({ client }) => {
        expect(await deliver(store, start, addVia(client, []))).toEqual({
          kind: "reaction-added", reactionKey: key, errorCode: "already_reacted",
        });
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "delivered", attempts: 1, last_error_code: "already_reacted" });
      const [audit] = store.listAuditRecords({ limit: 200 }).filter((row) => row.source === key);
      expect(audit).toMatchObject({ action: "slack.reaction.added", result: "delivered", metadata: { errorCode: "already_reacted" } });
    });
  });

  test("missing_scope fails the reaction terminally and it is never retried", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      await withFakeSlack([platformError("missing_scope")], async ({ client, requests }) => {
        const add = addVia(client, []);
        expect(await deliver(store, start, add)).toEqual({ kind: "reaction-failed", reactionKey: key, errorCode: "missing_scope" });
        expect(await deliver(store, at(60_000), add)).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "failed", attempts: 1, last_error_code: "missing_scope", lease_owner: null });
      const [audit] = store.listAuditRecords({ limit: 200 }).filter((row) => row.source === key);
      expect(audit).toMatchObject({ action: "slack.reaction.failed", result: "failed", metadata: { errorCode: "missing_scope" } });
    });
  });

  test("not_reactable and message_not_found fail their reactions", async () => {
    await withStore(async (store, path) => {
      const first = ackKey(ackEvent(store, 1, start));
      const second = ackKey(ackEvent(store, 2, at(1_000)));
      await withFakeSlack([platformError("not_reactable"), platformError("message_not_found")], async ({ client }) => {
        const add = addVia(client, []);
        expect(await deliver(store, at(2_000), add)).toEqual({ kind: "reaction-failed", reactionKey: first, errorCode: "not_reactable" });
        expect(await deliver(store, at(3_000), add)).toEqual({ kind: "reaction-failed", reactionKey: second, errorCode: "message_not_found" });
      });
      expect(reactionRow(path, first)).toMatchObject({ status: "failed", last_error_code: "not_reactable" });
      expect(reactionRow(path, second)).toMatchObject({ status: "failed", last_error_code: "message_not_found" });
    });
  });

  test("an ambiguous platform error is retried, not quarantined, and fails once attempts run out", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const policy = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 };
      await withFakeSlack([platformError("internal_error")], async ({ client, requests }) => {
        const add = addVia(client, []);
        expect(await deliver(store, start, add, { retryPolicy: policy })).toEqual({
          kind: "reaction-retry-scheduled", reactionKey: key, errorCode: "internal_error", blockedUntil: at(1),
        });
        expect(reactionRow(path, key)).toMatchObject({
          status: "pending", attempts: 1, blocked_until: at(1), last_error_code: "internal_error", lease_owner: null,
        });
        expect(await deliver(store, start, add, { retryPolicy: policy })).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);

        expect(await deliver(store, at(1), add, { retryPolicy: policy })).toEqual({
          kind: "reaction-failed", reactionKey: key, errorCode: "internal_error",
        });
        expect(requests).toHaveLength(2);
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "failed", attempts: 2, last_error_code: "internal_error" });
      expect(auditFor(store, key)).toEqual([{ action: "slack.reaction.failed", result: "failed" }]);
    });
  });

  test("a thrown plain Error is ambiguous too: retry-scheduled with the default policy", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const add: AddReaction = async () => {
        throw new Error("socket hang up");
      };
      // Default policy, random 0: attempt 1 waits half of the 2 s base delay.
      expect(await deliver(store, start, add)).toEqual({
        kind: "reaction-retry-scheduled", reactionKey: key, errorCode: "Error", blockedUntil: at(1_000),
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "pending", attempts: 1, last_error_code: "Error" });
      expect(auditFor(store, key)).toEqual([]);
    });
  });

  test("HTTP 429 with Retry-After: 7 schedules a retry and pauses reactions.add for 7 s", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      await withFakeSlack([{ status: 429, headers: { "retry-after": "7" } }, ok], async ({ client, requests }) => {
        const add = addVia(client, []);
        expect(await deliver(store, start, add)).toEqual({
          kind: "reaction-retry-scheduled", reactionKey: key, errorCode: "rate_limited", blockedUntil: at(7_000),
        });
        expect(rateLimitRows(path)).toEqual([{ scope: "reactions.add", blocked_until: at(7_000), error_code: "rate_limited" }]);

        expect(await deliver(store, at(6_999), add)).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(1);
        expect(await deliver(store, at(7_000), add)).toEqual({ kind: "reaction-added", reactionKey: key });
        expect(requests).toHaveLength(2);
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "delivered", attempts: 2 });
    });
  });

  test("a ratelimited platform error with response_metadata.retryAfter pauses reactions.add the same way", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const rateLimited: FakeReply = { status: 200, body: { ok: false, error: "ratelimited", response_metadata: { retryAfter: 7 } } };
      await withFakeSlack([rateLimited], async ({ client }) => {
        expect(await deliver(store, start, addVia(client, []))).toEqual({
          kind: "reaction-retry-scheduled", reactionKey: key, errorCode: "ratelimited", blockedUntil: at(7_000),
        });
      });
      expect(rateLimitRows(path)).toEqual([{ scope: "reactions.add", blocked_until: at(7_000), error_code: "ratelimited" }]);
      expect(reactionRow(path, key)).toMatchObject({ status: "pending", last_error_code: "ratelimited" });
    });
  });

  test("a revoked channel fails the reaction with ExecutionAuthorityDenied and never calls Slack", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const calls: SlackReactionAdd[] = [];
      await withFakeSlack([ok], async ({ client, requests }) => {
        expect(await deliver(store, start, addVia(client, calls), { config: revokedConfig })).toEqual({
          kind: "reaction-failed", reactionKey: key, errorCode: "ExecutionAuthorityDenied",
        });
        expect(requests).toHaveLength(0);
      });
      expect(calls).toEqual([]);
      expect(reactionRow(path, key)).toMatchObject({ status: "failed", attempts: 1, last_error_code: "ExecutionAuthorityDenied" });
      expect(auditFor(store, key)).toEqual([{ action: "slack.reaction.failed", result: "failed" }]);
    });
  });

  test("a reaction reclaimed past maxAttempts after crashed workers is failed without calling Slack", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const policy = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 };
      // Two workers claim and die mid-call; their leases expire.
      store.claimNextReaction({ workerId: "dead-1", now: start, leaseMs: LEASE_MS });
      store.claimNextReaction({ workerId: "dead-2", now: at(31_000), leaseMs: LEASE_MS });
      const calls: SlackReactionAdd[] = [];
      await withFakeSlack([ok], async ({ client, requests }) => {
        expect(await deliver(store, at(62_000), addVia(client, calls), { retryPolicy: policy })).toEqual({
          kind: "reaction-failed", reactionKey: key, errorCode: "attempts_exhausted",
        });
        expect(requests).toHaveLength(0);
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "failed", attempts: 3, last_error_code: "attempts_exhausted" });
    });
  });

  test("a delivery after a retried error clears the stale error code", async () => {
    await withStore(async (store, path) => {
      const key = ackKey(ackEvent(store, 1));
      const policy = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 };
      await withFakeSlack([platformError("internal_error"), ok], async ({ client }) => {
        const add = addVia(client, []);
        expect((await deliver(store, start, add, { retryPolicy: policy })).kind).toBe("reaction-retry-scheduled");
        expect(await deliver(store, at(1), add, { retryPolicy: policy })).toEqual({ kind: "reaction-added", reactionKey: key });
      });
      expect(reactionRow(path, key)).toMatchObject({ status: "delivered", attempts: 2, last_error_code: null });
    });
  });

  test("an empty queue is idle and calls nothing", async () => {
    await withStore(async (store, path) => {
      const calls: SlackReactionAdd[] = [];
      await withFakeSlack([ok], async ({ client, requests }) => {
        expect(await deliver(store, start, addVia(client, calls))).toEqual({ kind: "idle" });
        expect(requests).toHaveLength(0);
      });
      expect(calls).toEqual([]);
      expect(reactionRows(path)).toEqual([]);
    });
  });
});
