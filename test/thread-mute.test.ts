import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagCommands, type CommandReplySender } from "../src/commands/handler.ts";
import { agentTagConfigSchema } from "../src/config.ts";
import { handleSlackEvent } from "../src/slack/bridge.ts";
import { SlackEventRouter } from "../src/slack/events.ts";
import { AgentTagStore } from "../src/store/store.ts";

const receivedAt = "2026-09-21T00:00:00.000Z";
const thread = "1000.000001";
const key = { workspaceId: "T1", conversationId: "C1", threadTs: thread };
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering", repositoryRoot: "/srv/repos/example" }],
  limits: { maxConcurrentTasks: 2 },
});

const silent: CommandReplySender = { ephemeral: async () => {}, post: async () => ({ ts: "1" }) };

function body(input: { eventId: string; ts: string; text: string; type?: "app_mention" | "message"; threadTs?: string }): unknown {
  return {
    type: "event_callback",
    event_id: input.eventId,
    team_id: "T1",
    event: {
      type: input.type ?? "message",
      user: "U1",
      channel: "C1",
      ts: input.ts,
      text: input.text,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    },
  };
}

async function withMutedThread(
  run: (input: {
    readonly store: AgentTagStore;
    readonly db: Database;
    readonly router: SlackEventRouter;
    readonly send: (event: unknown) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-thread-mute-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const db = new Database(path);
  const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => receivedAt });
  const commands = new AgentTagCommands({ config: () => config, store, replies: silent });
  const send = (event: unknown) => handleSlackEvent({ router, commands }, event);
  try {
    await send(body({ eventId: "EvBind", type: "app_mention", ts: thread, text: "<@U0BOT> investigate" }));
    await send(body({ eventId: "EvMute", type: "app_mention", ts: "1000.000002", threadTs: thread, text: "<@U0BOT> !mute" }));
    expect(store.isThreadMuted(key)).toBe(true);
    expect(store.diagnostics()).toMatchObject({ operations: 1 });
    await run({ store, db, router, send });
  } finally {
    db.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-thread-mute-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function auditCount(db: Database, action: string): number {
  return (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get(action) as { count: number }).count;
}

describe("thread mute", () => {
  test("an unmentioned reply in a muted thread is ignored and creates no operation", async () => {
    await withMutedThread(async ({ store, router }) => {
      expect(router.ingest(body({ eventId: "Ev1", ts: "1000.000010", threadTs: thread, text: "any update?" }))).toEqual({
        kind: "ignored",
        reason: "thread-muted",
      });
      expect(store.diagnostics()).toMatchObject({ operations: 1 });
      expect(store.isThreadMuted(key)).toBe(true);
    });
  });

  test("a mention unmutes the thread once and becomes one request", async () => {
    await withMutedThread(async ({ store, db, router }) => {
      const text = "<@U0BOT> pick this back up";
      expect(router.ingest(body({ eventId: "Ev1", type: "app_mention", ts: "1000.000010", threadTs: thread, text })).kind).toBe(
        "accepted",
      );
      expect(router.ingest(body({ eventId: "Ev2", ts: "1000.000010", threadTs: thread, text })).kind).toBe("duplicate");
      expect(store.isThreadMuted(key)).toBe(false);
      expect(store.diagnostics()).toMatchObject({ operations: 2 });
      expect(auditCount(db, "thread.unmuted")).toBe(1);
      const metadata = JSON.parse(
        (db.query("SELECT metadata_json FROM audit_log WHERE action = 'thread.unmuted'").get() as { metadata_json: string })
          .metadata_json,
      );
      expect(metadata).toMatchObject({ reason: "mention" });

      expect(router.ingest(body({ eventId: "Ev3", ts: "1000.000011", threadTs: thread, text: "and also this" })).kind).toBe(
        "accepted",
      );
    });
  });

  test("a labelled mention also unmutes", async () => {
    await withMutedThread(async ({ store, router }) => {
      const result = router.ingest(
        body({ eventId: "Ev1", type: "app_mention", ts: "1000.000010", threadTs: thread, text: "<@U0BOT|agent> go" }),
      );
      expect(result.kind).toBe("accepted");
      expect(store.isThreadMuted(key)).toBe(false);
    });
  });

  test("!status in a muted thread neither unmutes nor creates work", async () => {
    await withMutedThread(async ({ store, send }) => {
      await send(body({ eventId: "Ev1", type: "app_mention", ts: "1000.000010", threadTs: thread, text: "<@U0BOT> !status" }));
      expect(store.isThreadMuted(key)).toBe(true);
      expect(store.diagnostics()).toMatchObject({ operations: 1 });
    });
  });

  test("a mention that is ignored for another reason does not unmute", async () => {
    await withMutedThread(async ({ store }) => {
      const moved = agentTagConfigSchema.parse({
        ...config,
        profiles: config.profiles.map((profile) => ({ ...profile, repositoryRoots: ["/srv/repos/example", "/srv/repos/other"] })),
        routes: [{ conversationId: "C1", profileId: "engineering", repositoryRoot: "/srv/repos/other" }],
      });
      const router = new SlackEventRouter({ config: moved, store, botUserId: "U0BOT", now: () => receivedAt });
      expect(
        router.ingest(body({ eventId: "Ev1", type: "app_mention", ts: "1000.000010", threadTs: thread, text: "<@U0BOT> go" })),
      ).toEqual({ kind: "ignored", reason: "task-route-denied" });
      expect(store.isThreadMuted(key)).toBe(true);
    });
  });

  test("mute is router-only: direct store ingest (scheduler, recovery paths) is unaffected", async () => {
    await withMutedThread(async ({ store }) => {
      const receipt = store.ingestSlackEvent({
        deliveryId: "direct-1",
        eventKey: "C1:1000.000020",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: thread,
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "scheduled follow-up",
        receivedAt,
        sourceOrderKey: "1000.000020",
      });
      expect(receipt.kind).toBe("accepted");
      expect(store.isThreadMuted(key)).toBe(true);
      expect(store.diagnostics()).toMatchObject({ operations: 2 });
    });
  });

  test("mute state is per thread", async () => {
    await withMutedThread(async ({ store, router }) => {
      expect(router.ingest(body({ eventId: "Ev1", type: "app_mention", ts: "2000.000001", text: "<@U0BOT> new" })).kind).toBe(
        "accepted",
      );
      expect(router.ingest(body({ eventId: "Ev2", ts: "2000.000002", threadTs: "2000.000001", text: "more" })).kind).toBe(
        "accepted",
      );
      expect(store.isThreadMuted({ ...key, threadTs: "2000.000001" })).toBe(false);
    });
  });
});
