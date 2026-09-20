import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { SlackEventRouter } from "../src/slack/events.ts";
import { AgentTagStore } from "../src/store/store.ts";

const receivedAt = "2026-09-21T00:00:00.000Z";
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
  routes: [
    {
      conversationId: "C1",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
    },
  ],
  limits: { maxConcurrentTasks: 2 },
});

function eventBody(input: {
  readonly eventId: string;
  readonly type: "app_mention" | "message";
  readonly user?: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly threadTs?: string;
  readonly text?: string;
  readonly teamId?: string;
  readonly subtype?: string;
  readonly botId?: string;
}): unknown {
  return {
    type: "event_callback",
    event_id: input.eventId,
    team_id: input.teamId ?? "T1",
    event: {
      type: input.type,
      user: input.user ?? "U1",
      channel: input.channel ?? "C1",
      ts: input.ts ?? "1000.000001",
      text: input.text ?? "<@U0BOT> investigate this",
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      ...(input.botId === undefined ? {} : { bot_id: input.botId }),
    },
  };
}

async function withRouter(
  run: (input: { readonly store: AgentTagStore; readonly router: SlackEventRouter }) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-events-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => receivedAt });
  try {
    await run({ store, router });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-events-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("Slack event ingress", () => {
  test("collapses overlapping mention and message deliveries into one ordered turn", async () => {
    await withRouter(({ store, router }) => {
      const mention = router.ingest(eventBody({ eventId: "Ev1", type: "app_mention" }));
      const overlap = router.ingest(eventBody({ eventId: "Ev2", type: "message" }));
      expect(mention.kind).toBe("accepted");
      expect(overlap.kind).toBe("duplicate");
      expect(store.diagnostics()).toMatchObject({ events: 1, deliveries: 2, tasks: 1, operations: 1 });

      const claimed = store.claimNextOperation({
        workerId: "worker-a",
        now: receivedAt,
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      expect(claimed?.payload).toMatchObject({
        text: "investigate this",
        actorUserId: "U1",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
      });
    });
  });

  test("accepts authorized human steering only inside an existing task thread", async () => {
    await withRouter(({ store, router }) => {
      router.ingest(eventBody({ eventId: "Ev1", type: "app_mention" }));
      expect(
        router.ingest(
          eventBody({
            eventId: "Ev2",
            type: "message",
            user: "U2",
            ts: "1000.000002",
            threadTs: "1000.000001",
            text: "also inspect the retry path",
          }),
        ).kind,
      ).toBe("accepted");
      expect(
        router.ingest(
          eventBody({
            eventId: "Ev3",
            type: "message",
            user: "U2",
            ts: "2000.000001",
            threadTs: "1999.000001",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "unbound-thread" });

      const first = store.claimNextOperation({
        workerId: "worker-a",
        now: receivedAt,
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      if (first === null) throw new Error("initial mention was not claimable");
      store.completeOperation({
        operationId: first.operationId,
        workerId: "worker-a",
        resultSequence: 1,
        now: "2026-09-21T00:00:01.000Z",
      });
      const steering = store.claimNextOperation({
        workerId: "worker-a",
        now: "2026-09-21T00:00:02.000Z",
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      expect(steering?.payload).toMatchObject({
        text: "also inspect the retry path",
        actorUserId: "U2",
      });
    });
  });

  test("rejects unauthorized, bot, subtype, and unrouted traffic before persistence", async () => {
    await withRouter(({ store, router }) => {
      expect(router.ingest(eventBody({ eventId: "Ev1", type: "app_mention", teamId: "T2" }))).toEqual({
        kind: "ignored",
        reason: "workspace-denied",
      });
      expect(router.ingest(eventBody({ eventId: "Ev2", type: "app_mention", channel: "C2" }))).toEqual({
        kind: "ignored",
        reason: "channel-denied",
      });
      expect(router.ingest(eventBody({ eventId: "Ev3", type: "app_mention", user: "U3" }))).toEqual({
        kind: "ignored",
        reason: "user-denied",
      });
      expect(
        router.ingest(eventBody({ eventId: "Ev4", type: "message", user: "U0BOT", botId: "B1" })),
      ).toEqual({ kind: "ignored", reason: "bot-event" });
      expect(
        router.ingest(eventBody({ eventId: "Ev5", type: "message", subtype: "message_changed" })),
      ).toEqual({ kind: "ignored", reason: "message-subtype" });
      expect(store.diagnostics()).toMatchObject({ events: 0, deliveries: 0, tasks: 0, operations: 0 });
    });
  });
});
