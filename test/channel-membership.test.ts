import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import type { ServiceLogRecord } from "../src/service.ts";
import { createSlackMembershipCache } from "../src/slack/bridge.ts";
import {
  ChannelMembershipCache,
  createMembershipWorker,
  MEMBERS_PAGE_SIZE,
  membershipChannels,
  type SlackConversationMembers,
} from "../src/slack/membership.ts";
import { AgentTagStore } from "../src/store/store.ts";

const settings = { ttlSeconds: 300, maxStaleSeconds: 3_600, maxMembers: 5_000, guests: "deny" as const };

function clock(start = Date.parse("2026-10-21T00:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance: (seconds: number) => {
      current += seconds * 1_000;
    },
  };
}

/** A fake conversations.members over fixed pages per channel; `members` is swappable between walks. */
function fakeSlack(initial: Record<string, ReadonlyArray<ReadonlyArray<string>>>) {
  const calls: Array<{ channel: string; limit: number; cursor?: string }> = [];
  let pages = initial;
  let failure: unknown = null;
  const list: SlackConversationMembers = async (args) => {
    calls.push({ ...args });
    if (failure !== null) {
      if (failure instanceof Error) throw failure;
      return failure;
    }
    const channelPages = pages[args.channel];
    if (channelPages === undefined) return { ok: false, error: "channel_not_found" };
    const index = args.cursor === undefined ? 0 : Number(args.cursor);
    const next = index + 1 < channelPages.length ? String(index + 1) : "";
    return { ok: true, members: channelPages[index], response_metadata: { next_cursor: next } };
  };
  return {
    list,
    calls,
    setPages: (next: Record<string, ReadonlyArray<ReadonlyArray<string>>>) => {
      pages = next;
    },
    fail: (value: unknown) => {
      failure = value;
    },
  };
}

function collectLogs() {
  const records: ServiceLogRecord[] = [];
  return { records, logger: (record: ServiceLogRecord) => records.push(record) };
}

describe("ChannelMembershipCache", () => {
  test("walks every cursor page with limit 200 and answers member / not-member", async () => {
    const slack = fakeSlack({ C1: [["U1", "U2"], ["U3"], ["U4", "U5"]] });
    const time = clock();
    const cache = new ChannelMembershipCache({ list: slack.list, settings, now: time.now, logger: () => {} });
    expect(cache.lookup("C1", "U1")).toBe("unknown");
    await cache.ensureFresh("C1");
    expect(slack.calls).toEqual([
      { channel: "C1", limit: MEMBERS_PAGE_SIZE },
      { channel: "C1", limit: 200, cursor: "1" },
      { channel: "C1", limit: 200, cursor: "2" },
    ]);
    for (const user of ["U1", "U2", "U3", "U4", "U5"]) expect(cache.lookup("C1", user)).toBe("member");
    expect(cache.lookup("C1", "U9")).toBe("not-member");
    expect(cache.lookup("C2", "U1")).toBe("unknown");
    expect(cache.status("C1")).toEqual({ id: "C1", membership: "ok", members: 5, ageSeconds: 0 });
    expect(cache.status("C2")).toEqual({ id: "C2", membership: "pending", members: null, ageSeconds: null });
  });

  test("refreshes only after ttlSeconds, and a refreshed snapshot drops a member who left", async () => {
    const slack = fakeSlack({ C1: [["U1", "U2"]] });
    const time = clock();
    const cache = new ChannelMembershipCache({ list: slack.list, settings, now: time.now, logger: () => {} });
    await cache.ensureFresh("C1");
    time.advance(299);
    await cache.ensureFresh("C1");
    expect(slack.calls).toHaveLength(1);
    expect(cache.isFresh("C1")).toBe(true);
    slack.setPages({ C1: [["U1"]] });
    time.advance(1);
    expect(cache.isFresh("C1")).toBe(false);
    // Past the TTL but inside maxStaleSeconds the old snapshot still answers.
    expect(cache.lookup("C1", "U2")).toBe("member");
    await cache.ensureFresh("C1");
    expect(slack.calls).toHaveLength(2);
    expect(cache.lookup("C1", "U2")).toBe("not-member");
    expect(cache.lookup("C1", "U1")).toBe("member");
  });

  test("single-flight: 10 concurrent ensureFresh calls share one walk", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let walks = 0;
    const cache = new ChannelMembershipCache({
      list: async () => {
        walks += 1;
        await gate;
        return { ok: true, members: ["U1"], response_metadata: { next_cursor: "" } };
      },
      settings,
      logger: () => {},
    });
    const pending = Array.from({ length: 10 }, () => cache.ensureFresh("C1"));
    release();
    await Promise.all(pending);
    expect(walks).toBe(1);
    expect(cache.lookup("C1", "U1")).toBe("member");
  });

  test("missing_scope: one degraded callback and one warn per channel, then allowlist-only", async () => {
    const slack = fakeSlack({});
    slack.fail({ ok: false, error: "missing_scope", needed: "channels:read" });
    const time = clock();
    const logs = collectLogs();
    const degraded: unknown[] = [];
    const cache = new ChannelMembershipCache({
      list: slack.list,
      settings,
      now: time.now,
      logger: logs.logger,
      onDegraded: (input) => degraded.push(input),
    });
    await cache.ensureFresh("C1");
    // Inside the retry window nothing is called again.
    await cache.ensureFresh("C1");
    expect(slack.calls).toHaveLength(1);
    time.advance(settings.ttlSeconds);
    await cache.ensureFresh("C1");
    expect(slack.calls).toHaveLength(2);
    expect(degraded).toEqual([{ conversationId: "C1", state: "missing_scope", errorCode: "missing_scope" }]);
    expect(logs.records.map((record) => [record.level, record.event, record.conversationId, record.errorCode])).toEqual([
      ["warn", "slack.membership.degraded", "C1", "missing_scope"],
      ["info", "slack.membership.degraded", "C1", "missing_scope"],
    ]);
    expect(cache.lookup("C1", "U1")).toBe("unknown");
    expect(cache.status("C1")).toMatchObject({ membership: "missing_scope", members: null, errorCode: "missing_scope" });
  });

  test("ratelimited keeps the last snapshot until maxStaleSeconds, then fails closed", async () => {
    const slack = fakeSlack({ C1: [["U1"]] });
    const time = clock();
    const logs = collectLogs();
    const degraded: unknown[] = [];
    const cache = new ChannelMembershipCache({
      list: slack.list,
      settings,
      now: time.now,
      logger: logs.logger,
      onDegraded: (input) => degraded.push(input),
    });
    await cache.ensureFresh("C1");
    // The Web API client rejects a 429 with this code (rejectRateLimitedCalls).
    slack.fail(Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error" }));
    time.advance(settings.ttlSeconds);
    await cache.ensureFresh("C1");
    expect(cache.status("C1")).toMatchObject({ membership: "error", members: 1, errorCode: "ratelimited" });
    expect(cache.lookup("C1", "U1")).toBe("member");
    time.advance(settings.maxStaleSeconds - settings.ttlSeconds - 1);
    expect(cache.lookup("C1", "U1")).toBe("member");
    time.advance(1);
    expect(cache.lookup("C1", "U1")).toBe("unknown");
    expect(cache.lookup("C1", "U9")).toBe("unknown");
    // Transient errors warn (first time) but are not a degraded channel.
    expect(degraded).toEqual([]);
    expect(logs.records[0]).toMatchObject({ level: "warn", event: "slack.membership.failed", errorCode: "ratelimited" });
  });

  test("a channel above maxMembers is degraded (too-large) and answers unknown", async () => {
    const slack = fakeSlack({ C1: [["U1", "U2"], ["U3", "U4"], ["U5"]] });
    const degraded: unknown[] = [];
    const cache = new ChannelMembershipCache({
      list: slack.list,
      settings: { ...settings, maxMembers: 3 },
      logger: () => {},
      onDegraded: (input) => degraded.push(input),
    });
    await cache.ensureFresh("C1");
    expect(slack.calls).toHaveLength(2);
    expect(cache.lookup("C1", "U1")).toBe("unknown");
    expect(cache.status("C1")).toMatchObject({ membership: "too-large", members: null });
    expect(degraded).toEqual([{ conversationId: "C1", state: "too-large", errorCode: "too_many_members" }]);
  });

  test("an unparseable page is an error, never a partial member list", async () => {
    const cache = new ChannelMembershipCache({
      list: async () => ({ ok: true, members: "U1" }),
      settings,
      logger: () => {},
    });
    await cache.ensureFresh("C1");
    expect(cache.status("C1")).toMatchObject({ membership: "error", errorCode: "invalid_response" });
    expect(cache.lookup("C1", "U1")).toBe("unknown");
  });

  test("userKind reads the directory's cached kind and is unknown without one", () => {
    const withUsers = new ChannelMembershipCache({
      list: async () => ({}),
      settings,
      users: { cachedKind: (userId) => (userId === "UG" ? "guest" : "member") },
    });
    expect(withUsers.userKind("UG")).toBe("guest");
    expect(new ChannelMembershipCache({ list: async () => ({}), settings }).userKind("UG")).toBe("unknown");
  });
});

describe("membership wiring", () => {
  test("only routed, non-DM conversations are refreshed (an allowed but unrouted channel is not)", () => {
    const example = require("../config/agent-tag.example.json");
    const config = agentTagConfigSchema.parse({
      ...example,
      access: { mode: "channel-members", allowedChannelIds: ["C1", "G1", "C2", "D1"], allowedUserIds: ["U1"] },
      profiles: example.profiles.map((profile: { memory: object }) => ({ ...profile, memory: { ...profile.memory, privateDm: true } })),
      routes: [
        { conversationId: "C1", profileId: "engineering" },
        { conversationId: "G1", profileId: "engineering" },
        { conversationId: "D1", conversationType: "dm", ownerUserId: "U1", profileId: "engineering" },
      ],
    });
    expect(membershipChannels(config)).toEqual(["C1", "G1"]);
  });

  test("the worker refreshes at start, then at most once per tick", async () => {
    let refreshes = 0;
    let current = 0;
    const worker = createMembershipWorker({ refresh: async () => void (refreshes += 1), now: () => new Date(current) });
    await worker.processNext();
    await worker.processNext();
    expect(refreshes).toBe(1);
    current += 15_000;
    await worker.processNext();
    expect(refreshes).toBe(2);
  });

  test("the bridge's cache, over the real Web API client, writes one access.membership.degraded audit row on missing_scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-membership-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        requests += 1;
        expect(new URL(request.url).pathname).toBe("/api/conversations.members");
        return Response.json({ ok: false, error: "missing_scope", needed: "groups:read", provided: "chat:write" });
      },
    });
    try {
      const example = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();
      const config = agentTagConfigSchema.parse({
        ...example,
        access: { mode: "channel-members", allowedChannelIds: ["G1"], allowedUserIds: [] },
        routes: [{ conversationId: "G1", profileId: "engineering" }],
      });
      const logs = collectLogs();
      const cache = await createSlackMembershipCache({
        botToken: "xoxb-fixture",
        config,
        store,
        users: { cachedKind: () => "member" },
        logger: logs.logger,
        slackApiUrl: `http://127.0.0.1:${server.port}/api/`,
      });
      await cache.ensureFresh("G1");
      await cache.ensureFresh("G1");
      expect(requests).toBe(1);
      expect(cache.lookup("G1", "U1")).toBe("unknown");
      const rows = store.listAuditRecords().filter((record) => record.action === "access.membership.degraded");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: "agent-tag",
        actorId: "agent-tag",
        authority: "access",
        target: "G1",
        result: "missing_scope",
        metadata: { errorCode: "missing_scope" },
      });
      expect(logs.records.filter((record) => record.level === "warn")).toHaveLength(1);
      expect(JSON.stringify(logs.records)).not.toContain("xoxb-fixture");
    } finally {
      await server.stop(true);
      store.close();
      await rm(directory, { recursive: true });
    }
  });
});
