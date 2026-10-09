import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
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
  test("binds a DM route to one authorized human and persists its private conversation type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-dm-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const profile = config.profiles[0];
    if (profile === undefined) throw new Error("Slack fixture profile is missing");
    const dmConfig = agentTagConfigSchema.parse({
      ...config,
      access: {
        ...config.access,
        allowedChannelIds: [...config.access.allowedChannelIds, "D1"],
      },
      profiles: [{ ...profile, memory: { ...profile.memory, privateDm: true } }],
      routes: [
        ...config.routes,
        {
          conversationId: "D1",
          conversationType: "dm",
          ownerUserId: "U1",
          profileId: profile.id,
        },
      ],
    });
    const router = new SlackEventRouter({ config: dmConfig, store, botUserId: "U0BOT", now: () => receivedAt });
    try {
      expect(
        router.ingest(
          eventBody({ eventId: "EvDM0", type: "message", channel: "D1", user: "U2", text: "private" }),
        ),
      ).toEqual({ kind: "ignored", reason: "dm-owner-denied" });
      const accepted = router.ingest(
        eventBody({ eventId: "EvDM1", type: "message", channel: "D1", text: "private request" }),
      );
      if (accepted.kind === "ignored") throw new Error(`DM event was ignored: ${accepted.reason}`);
      if (accepted.kind === "noted") throw new Error("DM event became a note");
      expect(store.getTaskExecution(accepted.receipt.taskId)).toMatchObject({
        conversationType: "dm",
        ownerUserId: "U1",
      });
      expect(
        store.requestTaskCancellation({
          taskId: accepted.receipt.taskId,
          workspaceId: "T1",
          conversationId: "D1",
          threadTs: "1000.000001",
          actorUserId: "U2",
          sourceActionId: "forged-dm-cancel",
          now: receivedAt,
        }),
      ).toEqual({ kind: "denied" });
      expect(
        router.ingest(
          eventBody({
            eventId: "EvDM2",
            type: "message",
            channel: "D1",
            user: "U2",
            ts: "1000.000002",
            threadTs: "1000.000001",
            text: "forged steering",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "dm-owner-denied" });
      expect(() =>
        store.ingestSlackEvent({
          deliveryId: "bypass-dm-owner",
          eventKey: "D1:1000.000004",
          workspaceId: "T1",
          conversationId: "D1",
          threadTs: "1000.000001",
          actorUserId: "U2",
          conversationType: "dm",
          profileId: profile.id,
          repositoryRoot: "/srv/repos/example",
          text: "bypass the router",
          receivedAt,
          sourceOrderKey: "1000.000004",
        }),
      ).toThrow("task conversation identity does not match the incoming event");
      expect(
        router.ingest(
          eventBody({
            eventId: "EvDM3",
            type: "message",
            channel: "D1",
            ts: "1000.000003",
            threadTs: "1000.000001",
            text: "authorized steering",
          }),
        ).kind,
      ).toBe("accepted");
      expect(store.diagnostics()).toMatchObject({ events: 2, tasks: 1, operations: 2 });
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-dm-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("keeps ambient participation opt-in, relevant, bounded, quiet, and auditable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-ambient-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const ambientConfig = agentTagConfigSchema.parse({
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        ambient: {
          enabled: true,
          keywords: ["incident"],
          cooldownSeconds: 60,
          maxTurnsPerHour: 2,
        },
      })),
    });
    const ingestAt = (time: string, body: unknown) =>
      new SlackEventRouter({ config: ambientConfig, store, botUserId: "U0BOT", now: () => time }).ingest(body);
    try {
      expect(
        ingestAt(
          "2026-09-21T00:00:00.000Z",
          eventBody({ eventId: "EvA1", type: "message", ts: "1000.000010", text: "incident alpha" }),
        ).kind,
      ).toBe("accepted");
      expect(
        ingestAt(
          "2026-09-21T00:00:30.000Z",
          eventBody({ eventId: "EvA2", type: "message", ts: "1000.000020", text: "incident beta" }),
        ),
      ).toEqual({ kind: "ignored", reason: "ambient-quiet" });
      expect(
        ingestAt(
          "2026-09-21T00:02:00.000Z",
          eventBody({ eventId: "EvA3", type: "message", ts: "1000.000030", text: " Incident   Alpha " }),
        ),
      ).toEqual({ kind: "ignored", reason: "ambient-quiet" });
      expect(
        ingestAt(
          "2026-09-21T00:02:01.000Z",
          eventBody({ eventId: "EvA4", type: "message", ts: "1000.000040", text: "incident beta" }),
        ).kind,
      ).toBe("accepted");
      expect(
        ingestAt(
          "2026-09-21T00:03:02.000Z",
          eventBody({ eventId: "EvA5", type: "message", ts: "1000.000050", text: "incident gamma" }),
        ),
      ).toEqual({ kind: "ignored", reason: "ambient-quiet" });
      expect(
        ingestAt(
          "2026-09-21T00:04:00.000Z",
          eventBody({ eventId: "EvA6", type: "message", ts: "1000.000060", text: "ordinary update" }),
        ),
      ).toEqual({ kind: "ignored", reason: "ambient-not-relevant" });
      expect(store.diagnostics()).toMatchObject({
        ambientDecisions: 5,
        events: 2,
        operations: 2,
      });
      const decisions = store.listAuditRecords().filter((record) => record.action === "ambient.decided");
      expect(decisions).toHaveLength(5);
      expect(decisions.map((record) => record.result)).toEqual(
        expect.arrayContaining(["triggered", "quiet"]),
      );
      expect(decisions.map((record) => record.metadata.reason)).toEqual(
        expect.arrayContaining(["relevant", "cooldown", "unchanged", "hourly-limit"]),
      );
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-ambient-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

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
        messageTs: "1000.000001",
        origin: "slack",
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
      ).toEqual({ kind: "ignored", reason: "self-event" });
      expect(
        router.ingest(eventBody({ eventId: "Ev4b", type: "message", user: "U9", botId: "B9" })),
      ).toEqual({ kind: "ignored", reason: "bot-event" });
      expect(
        router.ingest(eventBody({ eventId: "Ev5", type: "message", subtype: "message_changed" })),
      ).toEqual({ kind: "ignored", reason: "message-subtype" });
      expect(
        router.ingest(
          eventBody({ eventId: "Ev6", type: "message", ts: "1000.000006", text: "incident without opt-in" }),
        ),
      ).toEqual({ kind: "ignored", reason: "ambient-disabled" });
      expect(store.diagnostics()).toMatchObject({ events: 0, deliveries: 0, tasks: 0, operations: 0 });
    });
  });
});

describe("thread context seed", () => {
  function claimOne(store: AgentTagStore) {
    return store.claimNextOperation({
      workerId: "worker-a",
      now: receivedAt,
      leaseMs: 10_000,
      maxConcurrentTasks: 2,
    });
  }

  function withEdited(body: unknown, edited: Record<string, unknown>): unknown {
    const parsed = body as { event: Record<string, unknown> };
    return { ...parsed, event: { ...parsed.event, edited } };
  }

  test("seeds thread context on the first mention inside an existing unbound thread", async () => {
    await withRouter(({ store, router }) => {
      expect(
        router.ingest(
          eventBody({ eventId: "Ev1", type: "app_mention", ts: "1000.000009", threadTs: "1000.000001" }),
        ),
      ).toMatchObject({ kind: "accepted" });
      expect(claimOne(store)?.payload.threadContext).toEqual({
        rootTs: "1000.000001",
        beforeTs: "1000.000009",
      });
    });
  });

  test("does not seed thread context on a top-level mention", async () => {
    await withRouter(({ store, router }) => {
      expect(router.ingest(eventBody({ eventId: "Ev1", type: "app_mention" }))).toMatchObject({
        kind: "accepted",
      });
      expect(claimOne(store)?.payload).not.toHaveProperty("threadContext");
    });
  });

  test("does not seed thread context on steering inside an already-bound thread", async () => {
    await withRouter(({ store, router }) => {
      expect(router.ingest(eventBody({ eventId: "Ev1", type: "app_mention" }))).toMatchObject({
        kind: "accepted",
      });
      expect(
        router.ingest(
          eventBody({
            eventId: "Ev2",
            type: "message",
            user: "U2",
            ts: "1000.000002",
            threadTs: "1000.000001",
            text: "also check the retry path",
          }),
        ),
      ).toMatchObject({ kind: "accepted" });

      const first = claimOne(store);
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
      expect(steering?.payload).toMatchObject({ text: "also check the retry path", actorUserId: "U2" });
      expect(steering?.payload).not.toHaveProperty("threadContext");
    });
  });

  test("does not seed thread context when the route profile disables it", async () => {
    const disabledConfig = agentTagConfigSchema.parse({
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        threadContext: {
          enabled: false,
          maxMessages: 30,
          maxChars: 12_000,
          maxMessageChars: 2_000,
          includeBotMessages: "root-only",
          includeNonAllowedUsers: true,
        },
      })),
    });
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-events-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const router = new SlackEventRouter({ config: disabledConfig, store, botUserId: "U0BOT", now: () => receivedAt });
    try {
      expect(
        router.ingest(
          eventBody({ eventId: "Ev1", type: "app_mention", ts: "1000.000009", threadTs: "1000.000001" }),
        ),
      ).toMatchObject({ kind: "accepted" });
      expect(claimOne(store)?.payload).not.toHaveProperty("threadContext");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-events-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("ignores edited app mentions without creating an operation", async () => {
    await withRouter(({ store, router }) => {
      expect(router.ingest(eventBody({ eventId: "Ev1", type: "app_mention" }))).toMatchObject({
        kind: "accepted",
      });
      const before = store.diagnostics().operations;
      expect(before).toBe(1);
      expect(
        router.ingest(
          withEdited(eventBody({ eventId: "Ev2", type: "app_mention" }), { user: "U1", ts: "1000.000010" }),
        ),
      ).toEqual({ kind: "ignored", reason: "edit-irrelevant" });
      expect(store.diagnostics().operations).toBe(before);
    });
  });

  test("treats a mention whose thread_ts equals its ts as top-level", async () => {
    await withRouter(({ store, router }) => {
      expect(
        router.ingest(
          eventBody({ eventId: "Ev1", type: "app_mention", ts: "1000.000005", threadTs: "1000.000005" }),
        ),
      ).toMatchObject({ kind: "accepted" });
      expect(claimOne(store)?.payload).not.toHaveProperty("threadContext");
    });
  });
});

const selfBotId = "B0SELF";

type ThreadContextOverride = Partial<AgentTagConfig["profiles"][number]["threadContext"]>;

function withThreadContext(overrides: ThreadContextOverride): AgentTagConfig {
  return agentTagConfigSchema.parse({
    ...config,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      threadContext: {
        enabled: true,
        maxMessages: 30,
        maxChars: 12_000,
        maxMessageChars: 2_000,
        includeBotMessages: "root-only",
        includeNonAllowedUsers: true,
        ...overrides,
      },
    })),
  });
}

const dmConfig = agentTagConfigSchema.parse({
  ...config,
  access: { ...config.access, allowedChannelIds: [...config.access.allowedChannelIds, "D1"] },
  profiles: config.profiles.map((profile) => ({ ...profile, memory: { ...profile.memory, privateDm: true } })),
  routes: [
    ...config.routes,
    { conversationId: "D1", conversationType: "dm", ownerUserId: "U1", profileId: "engineering" },
  ],
});

function rawBody(eventId: string, event: Record<string, unknown>): unknown {
  return { type: "event_callback", event_id: eventId, team_id: "T1", event };
}

/** A `message_changed` event in C1. `previous` omitted means Slack sent no previous_message. */
function editBody(input: {
  readonly eventId: string;
  readonly changeTs: string;
  readonly message: Record<string, unknown>;
  readonly previous?: Record<string, unknown>;
}): unknown {
  return rawBody(input.eventId, {
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    ts: input.changeTs,
    message: input.message,
    ...(input.previous === undefined ? {} : { previous_message: input.previous }),
  });
}

function threadReply(ts: string, text: string, user = "U1", threadTs = "1000.000001"): Record<string, unknown> {
  return { type: "message", user, text, ts, thread_ts: threadTs };
}

function editedReply(ts: string, text: string, editTs: string, user = "U1"): Record<string, unknown> {
  return { ...threadReply(ts, text, user), edited: { user, ts: editTs } };
}

/** A CI-style bot post. Bot messages carry no `user`, only `bot_id` and `bot_profile`. */
function botMessage(eventId: string, ts: string, threadTs?: string): unknown {
  return rawBody(eventId, {
    type: "message",
    subtype: "bot_message",
    channel: "C1",
    ts,
    text: "build failed <@U0BOT>",
    bot_id: "B0C3",
    bot_profile: { name: "CI" },
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
  });
}

interface BoundFixture {
  readonly store: AgentTagStore;
  readonly router: SlackEventRouter;
  /** A router over the same store with a different config (profile overrides). */
  readonly routerFor: (fixtureConfig: AgentTagConfig) => SlackEventRouter;
  readonly taskId: string;
}

/** Opens a store and binds thread 1000.000001 with an allowed user's start mention (or DM message). */
async function withBoundThread(
  run: (fixture: BoundFixture) => void | Promise<void>,
  options: { readonly config?: AgentTagConfig; readonly channel?: "C1" | "D1" } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-routing-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  const routerFor = (fixtureConfig: AgentTagConfig) =>
    new SlackEventRouter({
      config: fixtureConfig,
      store,
      botUserId: "U0BOT",
      selfBotId,
      now: () => receivedAt,
    });
  const channel = options.channel ?? "C1";
  try {
    const router = routerFor(options.config ?? config);
    const started = router.ingest(
      eventBody({
        eventId: "EvStart",
        type: channel === "C1" ? "app_mention" : "message",
        channel,
        text: "<@U0BOT> start",
      }),
    );
    if (started.kind !== "accepted") throw new Error(`fixture thread did not bind: ${JSON.stringify(started)}`);
    await run({ store, router, routerFor, taskId: started.receipt.taskId });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-routing-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("bot, self and edit routing", () => {
  test("records an allowed user's edit in a bound thread as one edit note, not a turn", async () => {
    await withBoundThread(async ({ store, router, taskId }) => {
      expect(
        router.ingest(
          eventBody({ eventId: "Ev2", type: "message", user: "U1", ts: "1000.000002", threadTs: "1000.000001", text: "old text" }),
        ),
      ).toMatchObject({ kind: "accepted" });
      const before = store.diagnostics();
      expect(before).toMatchObject({ operations: 2, tasks: 1 });

      const first = router.ingest(
        editBody({
          eventId: "EvEdit1",
          changeTs: "1000.000005",
          message: editedReply("1000.000002", "new text", "1000.000005"),
          previous: threadReply("1000.000002", "old text"),
        }),
      );
      if (first.kind !== "noted") throw new Error(`edit was not noted: ${JSON.stringify(first)}`);
      expect(first).toEqual({ kind: "noted", noteId: first.noteId, duplicate: false });
      expect(store.listPendingThreadNotes(taskId)).toEqual([
        {
          noteId: first.noteId,
          kind: "edit",
          speakerKind: "human",
          speakerId: "U1",
          speakerLabel: null,
          steeringAllowed: true,
          messageTs: "1000.000002",
          text: "new text",
          previousText: "old text",
        },
      ]);
      expect(store.diagnostics()).toMatchObject({
        events: before.events,
        deliveries: before.deliveries,
        tasks: before.tasks,
        operations: before.operations,
      });
    });
  });

  test("treats a redelivered edit (new event_id, same message and edited ts) as a duplicate", async () => {
    await withBoundThread(async ({ store, router, taskId }) => {
      router.ingest(
        eventBody({ eventId: "Ev2", type: "message", user: "U1", ts: "1000.000002", threadTs: "1000.000001", text: "old text" }),
      );
      const edit = (eventId: string) =>
        editBody({
          eventId,
          changeTs: "1000.000005",
          message: editedReply("1000.000002", "new text", "1000.000005"),
          previous: threadReply("1000.000002", "old text"),
        });
      const first = router.ingest(edit("EvEdit1"));
      if (first.kind !== "noted") throw new Error(`edit was not noted: ${JSON.stringify(first)}`);
      expect(router.ingest(edit("EvEdit1-redelivery"))).toEqual({
        kind: "noted",
        noteId: first.noteId,
        duplicate: true,
      });
      expect(store.listPendingThreadNotes(taskId)).toHaveLength(1);
    });
  });

  test("falls back to the stored text without previous_message, and to null when neither exists", async () => {
    await withBoundThread(async ({ store, router, taskId }) => {
      // Stored text is the mention-stripped form: "old draft", not "<@U0BOT> old draft".
      router.ingest(
        eventBody({ eventId: "Ev2", type: "message", user: "U1", ts: "1000.000003", threadTs: "1000.000001", text: "<@U0BOT> old draft" }),
      );
      expect(
        router.ingest(
          editBody({
            eventId: "EvEdit1",
            changeTs: "1000.000007",
            message: editedReply("1000.000003", "new draft", "1000.000007"),
          }),
        ),
      ).toMatchObject({ kind: "noted", duplicate: false });
      expect(
        router.ingest(
          editBody({
            eventId: "EvEdit2",
            changeTs: "1000.000009",
            message: editedReply("1000.000009", "edited unseen", "1000.000009"),
          }),
        ),
      ).toMatchObject({ kind: "noted", duplicate: false });
      expect(store.listPendingThreadNotes(taskId).map((note) => [note.messageTs, note.previousText])).toEqual([
        ["1000.000003", "old draft"],
        ["1000.000009", null],
      ]);
    });
  });

  test("ignores edits that cannot change context: unchanged text, tombstones, top-level messages", async () => {
    await withBoundThread(({ store, router, taskId }) => {
      const before = store.diagnostics();
      expect(
        router.ingest(
          editBody({
            eventId: "EvIrr1",
            changeTs: "1000.000021",
            message: editedReply("1000.000002", "same", "1000.000021"),
            previous: threadReply("1000.000002", "same"),
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "edit-irrelevant" });
      expect(
        router.ingest(
          editBody({
            eventId: "EvIrr2",
            changeTs: "1000.000022",
            message: { type: "message", subtype: "tombstone", text: "This message was deleted.", ts: "1000.000002", thread_ts: "1000.000001" },
            previous: threadReply("1000.000002", "old text"),
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "edit-irrelevant" });
      expect(
        router.ingest(
          editBody({
            eventId: "EvIrr3",
            changeTs: "1000.000023",
            message: { type: "message", user: "U1", text: "changed", ts: "1000.000011", edited: { user: "U1", ts: "1000.000023" } },
            previous: { type: "message", user: "U1", text: "was", ts: "1000.000011" },
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "edit-irrelevant" });
      expect(store.diagnostics()).toEqual(before);
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
    });
  });

  test("ignores an edit that adds a mention in an unbound thread without any write", async () => {
    await withBoundThread(({ store, router, taskId }) => {
      const before = store.diagnostics();
      expect(
        router.ingest(
          editBody({
            eventId: "EvUnbound1",
            changeTs: "2000.000005",
            message: {
              ...threadReply("2000.000002", "<@U0BOT> hello", "U1", "2000.000001"),
              edited: { user: "U1", ts: "2000.000005" },
            },
            previous: threadReply("2000.000002", "hello", "U1", "2000.000001"),
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "unbound-edit" });
      expect(store.diagnostics()).toEqual(before);
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
    });
  });

  test("drops the agent's own posts and chat.update echoes before any store write", async () => {
    await withBoundThread(({ store, router, taskId }) => {
      const before = store.diagnostics();
      const bodies = [
        eventBody({ eventId: "EvSelf1", type: "message", user: "U0BOT", ts: "1000.000003", threadTs: "1000.000001", text: "posted by agent" }),
        rawBody("EvSelf2", {
          type: "message",
          subtype: "bot_message",
          channel: "C1",
          ts: "1000.000004",
          thread_ts: "1000.000001",
          text: "posted by agent",
          bot_id: selfBotId,
        }),
        editBody({
          eventId: "EvSelf3",
          changeTs: "1000.000006",
          message: {
            type: "message",
            subtype: "bot_message",
            bot_id: selfBotId,
            text: "chat.update text",
            ts: "1000.000004",
            thread_ts: "1000.000001",
            edited: { user: "U0BOT", ts: "1000.000006" },
          },
          previous: { type: "message", subtype: "bot_message", bot_id: selfBotId, text: "posted by agent", ts: "1000.000004", thread_ts: "1000.000001" },
        }),
      ];
      for (const body of bodies) {
        expect(router.ingest(body)).toEqual({ kind: "ignored", reason: "self-event" });
      }
      expect(store.diagnostics()).toEqual(before);
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
    });
  });

  test("records a bot message in a bound thread as a bot context note without an operation", async () => {
    await withBoundThread(({ store, router, taskId }) => {
      const before = store.diagnostics();
      const result = router.ingest(botMessage("EvBot1", "1000.000004", "1000.000001"));
      if (result.kind !== "noted") throw new Error(`bot message was not noted: ${JSON.stringify(result)}`);
      expect(result).toEqual({ kind: "noted", noteId: result.noteId, duplicate: false });
      expect(store.listPendingThreadNotes(taskId)).toEqual([
        {
          noteId: result.noteId,
          kind: "message",
          speakerKind: "bot",
          speakerId: "B0C3",
          speakerLabel: "CI",
          steeringAllowed: false,
          messageTs: "1000.000004",
          text: "build failed <@U0BOT>",
          previousText: null,
        },
      ]);
      expect(store.diagnostics().operations).toBe(before.operations);
    });
  });

  test("ignores bot messages outside bound channel threads, or when includeBotMessages is none", async () => {
    await withBoundThread(({ store, router, routerFor, taskId }) => {
      const before = store.diagnostics();
      expect(router.ingest(botMessage("EvBot2", "2000.000002", "2000.000001"))).toEqual({
        kind: "ignored",
        reason: "bot-event",
      });
      expect(router.ingest(botMessage("EvBot3", "3000.000001"))).toEqual({ kind: "ignored", reason: "bot-event" });
      expect(store.diagnostics()).toEqual(before);

      const noBots = routerFor(withThreadContext({ includeBotMessages: "none" }));
      expect(noBots.ingest(botMessage("EvBot4", "1000.000004", "1000.000001"))).toEqual({
        kind: "ignored",
        reason: "bot-event",
      });
      expect(store.diagnostics()).toEqual(before);
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
    });
  });

  test("records a non-allowlisted human in a bound thread only when includeNonAllowedUsers allows it", async () => {
    await withBoundThread(({ store, router, routerFor, taskId }) => {
      const aside = eventBody({ eventId: "EvU3a", type: "message", user: "U3", ts: "1000.000006", threadTs: "1000.000001", text: "U3 aside" });
      const result = router.ingest(aside);
      if (result.kind !== "noted") throw new Error(`non-allowlisted reply was not noted: ${JSON.stringify(result)}`);
      expect(result).toEqual({ kind: "noted", noteId: result.noteId, duplicate: false });
      expect(store.listPendingThreadNotes(taskId)).toEqual([
        {
          noteId: result.noteId,
          kind: "message",
          speakerKind: "human",
          speakerId: "U3",
          speakerLabel: null,
          steeringAllowed: false,
          messageTs: "1000.000006",
          text: "U3 aside",
          previousText: null,
        },
      ]);

      const before = store.diagnostics();
      const strict = routerFor(withThreadContext({ includeNonAllowedUsers: false }));
      expect(
        strict.ingest(eventBody({ eventId: "EvU3b", type: "message", user: "U3", ts: "1000.000007", threadTs: "1000.000001", text: "ignored" })),
      ).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(store.diagnostics()).toEqual(before);
    });
  });

  test("denies a non-allowlisted human outside a bound thread regardless of the profile", async () => {
    await withBoundThread(({ store, router, routerFor, taskId }) => {
      const before = store.diagnostics();
      expect(
        router.ingest(eventBody({ eventId: "EvU3c", type: "message", user: "U3", ts: "3000.000001", text: "hello" })),
      ).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(
        router.ingest(eventBody({ eventId: "EvU3d", type: "message", user: "U3", ts: "2000.000002", threadTs: "2000.000001", text: "hello" })),
      ).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(routerFor(withThreadContext({ includeNonAllowedUsers: true })).ingest(
        eventBody({ eventId: "EvU3e", type: "message", user: "U3", ts: "3000.000002", text: "hello again" }),
      )).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(store.diagnostics()).toEqual(before);
      expect(store.listPendingThreadNotes(taskId)).toEqual([]);
    });
  });

  test("denies a non-owner in a bound DM without a note", async () => {
    await withBoundThread(
      ({ store, router, taskId }) => {
        const before = store.diagnostics();
        expect(
          router.ingest(
            eventBody({ eventId: "EvDmU3", type: "message", channel: "D1", user: "U3", ts: "1000.000006", threadTs: "1000.000001", text: "not mine" }),
          ),
        ).toEqual({ kind: "ignored", reason: "dm-owner-denied" });
        expect(store.diagnostics()).toEqual(before);
        expect(store.listPendingThreadNotes(taskId)).toEqual([]);
      },
      { config: dmConfig, channel: "D1" },
    );
  });

  test("accepts a thread_broadcast reply from an allowed user as a turn", async () => {
    await withBoundThread(({ store, router }) => {
      expect(
        router.ingest(
          eventBody({
            eventId: "EvBroadcast",
            type: "message",
            user: "U1",
            ts: "1000.000002",
            threadTs: "1000.000001",
            subtype: "thread_broadcast",
            text: "broadcast reply",
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
      expect(store.diagnostics().operations).toBe(2);
    });
  });

  test("ignores file_share messages from an allowed user without any write", async () => {
    await withBoundThread(({ store, router }) => {
      const before = store.diagnostics();
      expect(
        router.ingest(
          eventBody({
            eventId: "EvFile",
            type: "message",
            user: "U1",
            ts: "1000.000002",
            threadTs: "1000.000001",
            subtype: "file_share",
            text: "here is a file",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "message-subtype" });
      expect(store.diagnostics()).toEqual(before);
    });
  });
});
