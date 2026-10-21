// J3: routines from Slack (PR-J §7 J3 Done 4). Fake clock, real store, fake Slack.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagCommands, type CommandReplySender } from "../src/commands/handler.ts";
import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { shortScheduleId } from "../src/routines/describe.ts";
import { handleSlackEvent } from "../src/slack/bridge.ts";
import { SlackEventRouter } from "../src/slack/events.ts";
import { listReply, ROUTINE_CANCEL_ACTION_ID, ROUTINE_LIST_LIMIT } from "../src/slack/routine-replies.ts";
import { matchCancelTargets, type RoutineUserDirectory, SlackRoutines } from "../src/slack/routines.ts";
import { outboxPayloadSchema } from "../src/store/schema.ts";
import type { ScheduleSummary, SlackOutboxPayload } from "../src/store/store.ts";
import { AgentTagStore } from "../src/store/store.ts";

// Wednesday 2026-10-21, 06:00 in New York. Each event advances the clock a second, so list order
// (creation order) is deterministic.
const start = Date.parse("2026-10-21T10:00:00.000Z");
const root = "/srv/repos/example";

const baseInput = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1", "C2", "D1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: [root],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: true, retentionDays: 180 },
    },
  ],
  routes: [
    { conversationId: "C1", profileId: "engineering", repositoryRoot: root },
    { conversationId: "C2", profileId: "engineering", repositoryRoot: root },
    { conversationId: "D1", conversationType: "dm", ownerUserId: "U1", profileId: "engineering" },
  ],
  limits: { maxConcurrentTasks: 2 },
};

function makeConfig(overrides: Record<string, unknown> = {}): AgentTagConfig {
  return agentTagConfigSchema.parse({ ...baseInput, ...overrides });
}

function fakeUsers(zones: Record<string, string | null | Error>): RoutineUserDirectory & { readonly zoneCalls: string[] } {
  const zoneCalls: string[] = [];
  const names: Record<string, string> = { U1: "Ursula", U2: "Victor" };
  return {
    zoneCalls,
    async timeZone(userId) {
      zoneCalls.push(userId);
      const zone = zones[userId];
      if (zone instanceof Error) throw zone;
      return zone ?? null;
    },
    async label(userId) {
      return { label: names[userId] ?? userId };
    },
  };
}

interface Ephemeral {
  readonly channel: string;
  readonly user: string;
  readonly text: string;
}

function fakeSender(): CommandReplySender & { readonly sent: Ephemeral[] } {
  const sent: Ephemeral[] = [];
  return {
    sent,
    async ephemeral({ channel, user, payload }) {
      sent.push({ channel, user, text: payload.text });
    },
    async post() {
      throw new Error("routines never post directly");
    },
  };
}

let tsCounter = 0;
function nextTs(): string {
  tsCounter += 1;
  return `2000.${String(tsCounter).padStart(6, "0")}`;
}

function mention(input: {
  readonly text: string;
  readonly ts?: string;
  readonly user?: string;
  readonly channel?: string;
  readonly threadTs?: string;
  readonly type?: "app_mention" | "message";
  readonly eventId?: string;
  readonly mention?: boolean;
}): unknown {
  const ts = input.ts ?? nextTs();
  return {
    type: "event_callback",
    event_id: input.eventId ?? `Ev${ts.replace(".", "")}`,
    team_id: "T1",
    event: {
      type: input.type ?? "app_mention",
      user: input.user ?? "U1",
      channel: input.channel ?? "C1",
      ts,
      text: input.mention === false ? input.text : `<@U0BOT> ${input.text}`,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    },
  };
}

interface OutboxRow {
  readonly clientMessageId: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly payload: SlackOutboxPayload;
}

interface Harness {
  readonly store: AgentTagStore;
  readonly db: Database;
  readonly users: ReturnType<typeof fakeUsers>;
  readonly sender: ReturnType<typeof fakeSender>;
  readonly routines: SlackRoutines;
  readonly send: (body: unknown) => Promise<void>;
  readonly route: (body: unknown) => ReturnType<SlackEventRouter["ingest"]>;
  readonly outbox: () => ReadonlyArray<OutboxRow>;
  readonly active: (conversationId?: string) => ReadonlyArray<ScheduleSummary>;
  readonly ledger: () => ReadonlyArray<{ command_kind: string; outcome: string; reason: string | null }>;
}

async function withHarness(
  options: { readonly config?: AgentTagConfig; readonly zones?: Record<string, string | null | Error> },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const config = options.config ?? makeConfig();
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-routines-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const db = new Database(path);
  const sender = fakeSender();
  const users = fakeUsers(options.zones ?? { U1: "America/New_York", U2: null });
  let clock = start;
  const now = () => new Date(clock);
  const routines = new SlackRoutines({ config: () => config, store, users, replies: sender, botName: "agent-tag", now });
  const commands = new AgentTagCommands({ config: () => config, store, replies: sender, now });
  const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => now().toISOString() });
  try {
    await run({
      store,
      db,
      users,
      sender,
      routines,
      send: (body) => {
        clock += 1_000;
        return handleSlackEvent({ router, commands, routines }, body);
      },
      route: (body) => router.ingest(body),
      outbox: () =>
        (
          db
            .query("SELECT client_message_id, task_id, conversation_id, thread_ts, payload_json FROM slack_outbox ORDER BY created_at, rowid")
            .all() as { client_message_id: string; task_id: string; conversation_id: string; thread_ts: string; payload_json: string }[]
        ).map((row) => ({
          clientMessageId: row.client_message_id,
          taskId: row.task_id,
          conversationId: row.conversation_id,
          threadTs: row.thread_ts,
          payload: outboxPayloadSchema.parse(JSON.parse(row.payload_json)),
        })),
      active: (conversationId = "C1") =>
        store.listActiveSchedulesForConversation({ workspaceId: "T1", conversationId, limit: 1_000 }),
      ledger: () =>
        db.query("SELECT command_kind, outcome, reason FROM slack_command_events ORDER BY rowid").all() as {
          command_kind: string;
          outcome: string;
          reason: string | null;
        }[],
    });
  } finally {
    db.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-routines-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function blockTexts(payload: SlackOutboxPayload): string {
  return (payload.blocks ?? [])
    .flatMap((block) =>
      block.type === "section" ? [block.text.text] : block.type === "context" ? block.elements.map((element) => element.text) : [],
    )
    .join("\n");
}

function buttons(payload: SlackOutboxPayload) {
  return (payload.blocks ?? []).flatMap((block) => (block.type === "actions" ? block.elements : []));
}

function click(input: {
  readonly scheduleId: string;
  readonly user?: string;
  readonly team?: string;
  readonly channel?: string;
  readonly messageTs?: string;
  readonly threadTs?: string;
}): unknown {
  return {
    type: "block_actions",
    team: { id: input.team ?? "T1" },
    user: { id: input.user ?? "U1", team_id: input.team ?? "T1" },
    channel: { id: input.channel ?? "C1" },
    container: {
      type: "message",
      message_ts: input.messageTs ?? "2999.000001",
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    },
    message: { ts: input.messageTs ?? "2999.000001", ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }) },
    actions: [{ action_id: ROUTINE_CANCEL_ACTION_ID, value: JSON.stringify({ scheduleId: input.scheduleId }) }],
  };
}

describe("Slack routines: create", () => {
  test("a weekday routine from a New York user creates one schedule in NY and one confirmation; redelivery adds nothing", async () => {
    await withHarness({}, async ({ send, active, outbox, ledger, users, sender }) => {
      const ts = "2100.000001";
      const body = mention({ text: "every weekday at 9am summarize open PRs", ts, eventId: "EvA" });
      await send(body);
      // Socket Mode redelivery, and the `message` twin Slack sends for the same mention.
      await send(body);
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts, eventId: "EvB", type: "message" }));

      const schedules = active();
      expect(schedules).toHaveLength(1);
      const [schedule] = schedules as [ScheduleSummary];
      expect(schedule).toMatchObject({
        kind: "agent",
        prompt: "summarize open PRs",
        state: "active",
        conversationId: "C1",
        threadTs: ts,
        actorUserId: "U1",
        timeZone: "America/New_York",
        recurrence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" },
        nextRunAt: "2026-10-21T13:00:00.000Z",
      });
      expect(users.zoneCalls).toEqual(["U1"]);

      const rows = outbox();
      expect(rows).toHaveLength(1);
      const [row] = rows as [OutboxRow];
      expect(row).toMatchObject({ clientMessageId: `routine:C1:${ts}:create`, taskId: schedule.taskId, threadTs: ts });
      const text = blockTexts(row.payload);
      expect(text).toContain(":repeat: Routine scheduled: *summarize open PRs*");
      expect(text).toContain("every weekday at 9:00 AM (America/New_York)");
      expect(text).toContain(`*ID:* \`${shortScheduleId(schedule.scheduleId)}\``);
      expect(text).toContain("Results post in this thread.");
      expect(text).toContain("Using your Slack time zone.");
      expect(row.payload.text).toContain("2026-10-21T13:00:00.000Z");
      expect(row.payload.text).not.toContain("<!date");
      expect(buttons(row.payload)).toEqual([
        expect.objectContaining({
          action_id: ROUTINE_CANCEL_ACTION_ID,
          value: JSON.stringify({ scheduleId: schedule.scheduleId }),
          style: "danger",
          confirm: expect.objectContaining({ style: "danger" }),
        }),
      ]);
      expect(ledger()).toEqual([{ command_kind: "routine-create", outcome: "succeeded", reason: null }]);
      expect(sender.sent).toEqual([]);
    });
  });

  test("a routine asked for in a closed thread binds to that task without reopening it", async () => {
    await withHarness({}, async ({ send, active, store }) => {
      const ts = "2100.000009";
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts }));
      const [first] = active() as [ScheduleSummary];
      const delivery = store.claimNextOutbox({ workerId: "o", now: new Date(start + 10_000).toISOString(), leaseMs: 10_000 });
      if (delivery === null) throw new Error("confirmation was not queued");
      store.markOutboxDelivered({ outboxId: delivery.outboxId, workerId: "o", slackMessageTs: "2100.000010", now: new Date(start + 10_000).toISOString() });
      expect(store.closeTask({ taskId: first.taskId, reason: "admin", actorId: "t", now: new Date(start + 20_000).toISOString() }))
        .toMatchObject({ kind: "closed" });

      await send(mention({ text: "remind me tomorrow at 3pm to deploy", threadTs: ts }));
      expect(active().map((schedule) => schedule.taskId)).toEqual([first.taskId, first.taskId]);
      expect(store.getTaskExecution(first.taskId)).toMatchObject({ state: "closed", sessionGeneration: 1 });
    });
  });

  test("falls back to the default zone when the profile has none, and says so", async () => {
    await withHarness({ zones: { U1: null, U2: new Error("boom") } }, async ({ send, active, outbox }) => {
      await send(mention({ text: "every day at 9am post standup notes" }));
      await send(mention({ text: "every day at 10am post the build report", user: "U2" }));
      expect(active().map((schedule) => schedule.timeZone)).toEqual(["UTC", "UTC"]);
      for (const row of outbox()) {
        expect(blockTexts(row.payload)).toContain("Using the default time zone UTC because your Slack time zone isn't available.");
      }
    });
  });

  test("uses the configured default zone", async () => {
    const config = makeConfig({ routines: { defaultTimeZone: "Asia/Kolkata" } });
    await withHarness({ config, zones: { U1: null } }, async ({ send, active }) => {
      await send(mention({ text: "every day at 9am post standup notes" }));
      expect(active()[0]?.timeZone).toBe("Asia/Kolkata");
    });
  });

  test("an explicit zone wins and skips the profile lookup", async () => {
    await withHarness({}, async ({ send, active, outbox, users }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs in Europe/London" }));
      expect(active()[0]).toMatchObject({
        timeZone: "Europe/London",
        recurrence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/London" },
      });
      expect(users.zoneCalls).toEqual([]);
      expect(blockTexts(outbox()[0]!.payload)).toContain("Using the time zone you named (Europe/London).");
    });
  });

  test("a fixed cadence gets no zone note", async () => {
    await withHarness({}, async ({ send, active, outbox }) => {
      await send(mention({ text: "every 2 hours check CI" }));
      expect(active()[0]?.cadenceSeconds).toBe(7_200);
      expect(blockTexts(outbox()[0]!.payload)).not.toContain("time zone");
    });
  });

  test("remind me creates a reminder that mentions the requester", async () => {
    await withHarness({}, async ({ send, active, outbox }) => {
      await send(mention({ text: "remind me tomorrow at 3pm to deploy" }));
      const [schedule] = active() as [ScheduleSummary];
      expect(schedule).toMatchObject({ kind: "reminder", notifyUserId: "U1", prompt: "deploy", nextRunAt: "2026-10-22T19:00:00.000Z" });
      const text = blockTexts(outbox()[0]!.payload);
      expect(text).toContain(":alarm_clock: I'll remind <@U1> once on");
      expect(text).toContain(": *deploy*");
    });
  });

  test("an unknown time zone or unparseable time replies with the reason and creates nothing", async () => {
    await withHarness({}, async ({ send, active, outbox, ledger }) => {
      await send(mention({ text: "every day at 9am in Europe/Lndon check CI" }));
      await send(mention({ text: "every 2 minutes check CI" }));
      expect(active()).toEqual([]);
      const rows = outbox();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.payload.text).toBe(":warning: I don't know the time zone `Europe/Lndon`. Use a name like America/New_York.");
      expect(rows[1]!.payload.text).toContain("too frequent");
      expect(ledger().map((row) => [row.outcome, row.reason])).toEqual([
        ["rejected", "time-zone"],
        ["rejected", "parse-error"],
      ]);
    });
  });

  test("the per-conversation limit stops a new routine", async () => {
    const config = makeConfig({ routines: { maxActivePerConversation: 1 } });
    await withHarness({ config }, async ({ send, active, outbox }) => {
      await send(mention({ text: "every day at 9am post standup notes" }));
      await send(mention({ text: "every day at 10am post the build report" }));
      expect(active()).toHaveLength(1);
      expect(outbox()[1]!.payload.text).toBe(":warning: This conversation already has 1 active routines. Cancel one first.");
    });
  });

  test("the workspace limit stops a new routine", async () => {
    const config = makeConfig({ limits: { maxConcurrentTasks: 2, maxActiveSchedules: 1 } });
    await withHarness({ config }, async ({ send, active, outbox, ledger }) => {
      await send(mention({ text: "every day at 9am post standup notes" }));
      await send(mention({ text: "every day at 10am post the build report", channel: "C2" }));
      expect(active("C2")).toEqual([]);
      expect(outbox()[1]!.payload.text).toBe(":warning: The workspace routine limit (1) is reached. Cancel a routine first.");
      expect(ledger()[1]).toEqual({ command_kind: "routine-create", outcome: "rejected", reason: "schedule-limit" });
    });
  });

  test("works in the owner's DM without a mention", async () => {
    await withHarness({}, async ({ send, active, outbox }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs", channel: "D1", type: "message", mention: false }));
      expect(active("D1")).toHaveLength(1);
      expect(outbox()).toHaveLength(1);
    });
  });
});

describe("Slack routines: list", () => {
  test("lists active routines with creators as labels (no pings) and a Cancel button each", async () => {
    await withHarness({}, async ({ send, outbox, active, ledger }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      await send(mention({ text: "every day at 5pm post the build report", user: "U2" }));
      const ts = nextTs();
      await send(mention({ text: "list routines", ts }));

      const list = outbox().find((row) => row.clientMessageId === `routine:C1:${ts}:list`);
      if (list === undefined) throw new Error("no list reply");
      expect(list.threadTs).toBe(ts);
      const text = blockTexts(list.payload);
      expect(text).toContain("*Routines in this channel* (2 active)");
      expect(text).toContain("1. :repeat:");
      expect(text).toContain("*summarize open PRs*");
      expect(text).toContain("by Ursula");
      expect(text).toContain("by Victor");
      expect(text).not.toContain("<@U");
      expect(buttons(list.payload).map((button) => JSON.parse(button.value).scheduleId)).toEqual(
        active().map((schedule) => schedule.scheduleId),
      );
      expect(ledger().at(-1)).toEqual({ command_kind: "routine-list", outcome: "succeeded", reason: null });
    });
  });

  test("an empty list suggests an example", async () => {
    await withHarness({}, async ({ send, outbox }) => {
      await send(mention({ text: "show me the routines here?" }));
      expect(outbox()[0]!.payload.text).toBe(
        "No routines in this channel yet. Try `@agent-tag every weekday at 9am summarize open PRs`.",
      );
    });
  });

  test("shows recently auto-disabled routines without a button", async () => {
    await withHarness({}, async ({ send, outbox, active, db }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      const [schedule] = active() as [ScheduleSummary];
      db.query(
        "UPDATE schedules SET state = 'cancelled', ended_reason = 'auto-disabled', ended_at = ?, consecutive_failures = 3 WHERE schedule_id = ?",
      ).run("2026-10-20T10:00:00.000Z", schedule.scheduleId);
      await send(mention({ text: "list routines" }));
      const list = outbox().at(-1)!;
      expect(blockTexts(list.payload)).toContain("(0 active)");
      expect(blockTexts(list.payload)).toContain("turned off <!date^");
      expect(blockTexts(list.payload)).toContain("after 3 failed runs in a row");
      expect(buttons(list.payload)).toEqual([]);
    });
  });

  test("a DM lists only that DM's routines", async () => {
    await withHarness({}, async ({ send, outbox }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      await send(mention({ text: "list routines", channel: "D1", type: "message", mention: false }));
      expect(outbox().at(-1)!.payload.text).toStartWith("No routines in this DM yet.");
    });
  });

  test("caps the list at 20 rows within Slack's 50-block limit", () => {
    const rows = Array.from({ length: 23 }, (_, index) => ({
      schedule: {
        scheduleId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        taskId: "task",
        kind: "agent",
        prompt: `prompt ${index}`,
        state: "active",
        nextRunAt: "2026-10-22T13:00:00.000Z",
        cadenceSeconds: 3_600,
        recurrence: null,
        missedRunPolicy: "skip",
        overlapPolicy: "skip",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1.1",
        profileId: "engineering",
        actorUserId: "U1",
        timeZone: null,
        humanReadable: null,
        notifyUserId: null,
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
        endedReason: null,
        endedAt: null,
        createdAt: "2026-10-21T10:00:00.000Z",
      } satisfies ScheduleSummary,
      creatorLabel: "Ursula",
    }));
    const payload = outboxPayloadSchema.parse(listReply({ conversationType: "channel", botName: "agent-tag", active: rows, disabled: [] }));
    expect(buttons(payload)).toHaveLength(ROUTINE_LIST_LIMIT);
    expect(payload.blocks!.length).toBeLessThanOrEqual(50);
    expect(blockTexts(payload)).toContain("…and 3 more.");
    expect(blockTexts(payload)).toContain("(23 active)");
  });
});

describe("Slack routines: cancel by text", () => {
  test("cancels by short id, posts one notice and settles the ledger", async () => {
    await withHarness({}, async ({ send, active, outbox, ledger, store }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      const [schedule] = active() as [ScheduleSummary];
      const ts = nextTs();
      const body = mention({ text: `cancel routine ${shortScheduleId(schedule.scheduleId)}`, ts });
      await send(body);
      await send(body);
      expect(active()).toEqual([]);
      expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ state: "cancelled", endedReason: "user-cancelled" });
      const notices = outbox().filter((row) => row.clientMessageId.endsWith(":cancel"));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.payload.text).toStartWith(
        `:wastebasket: <@U1> cancelled routine \`${shortScheduleId(schedule.scheduleId)}\` (every weekday at 9:00 AM (America/New_York): *summarize open PRs*)`,
      );
      expect(ledger().at(-1)).toEqual({ command_kind: "routine-cancel", outcome: "succeeded", reason: null });
    });
  });

  test("cancels by list number and by prompt text", async () => {
    await withHarness({}, async ({ send, active }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      await send(mention({ text: "every day at 5pm post the build report" }));
      await send(mention({ text: "remind me tomorrow at 3pm to deploy" }));
      await send(mention({ text: "cancel routine 2" }));
      expect(active().map((schedule) => schedule.prompt)).toEqual(["summarize open PRs", "deploy"]);
      await send(mention({ text: "cancel the reminder about DEPLOY" }));
      expect(active().map((schedule) => schedule.prompt)).toEqual(["summarize open PRs"]);
    });
  });

  test("'cancel this routine' in the routine's thread cancels that one", async () => {
    await withHarness({}, async ({ send, active }) => {
      const first = nextTs();
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts: first }));
      await send(mention({ text: "every day at 5pm post the build report" }));
      await send(mention({ text: "cancel this routine", threadTs: first }));
      expect(active().map((schedule) => schedule.prompt)).toEqual(["post the build report"]);
    });
  });

  test("several matches list just those under their list numbers; no match says so", async () => {
    await withHarness({}, async ({ send, active, outbox, ledger }) => {
      await send(mention({ text: "every weekday at 9am check CI" }));
      await send(mention({ text: "every day at 5pm post the build report" }));
      await send(mention({ text: "every day at 6pm post the build summary" }));
      await send(mention({ text: "cancel the routine about build" }));
      const ambiguous = outbox().at(-1)!;
      expect(ambiguous.payload.text).toBe("2 routines match. Which one should I cancel?");
      expect(buttons(ambiguous.payload)).toHaveLength(2);
      const rows = JSON.stringify(ambiguous.payload.blocks);
      expect(rows).toContain("2. :repeat:");
      expect(rows).toContain("3. :repeat:");
      expect(rows).not.toContain("1. :repeat:");
      await send(mention({ text: "cancel routine 9" }));
      expect(outbox().at(-1)!.payload.text).toBe("No active routine matches `#9`. Say `list routines` to see them.");
      expect(active()).toHaveLength(3);
      expect(ledger().slice(-2).map((row) => row.reason)).toEqual(["ambiguous", "no-match"]);
      await send(mention({ text: "cancel routine 2" }));
      expect(active().map((schedule) => schedule.prompt)).toEqual(["check CI", "post the build summary"]);
    });
  });

  test("'cancel this routine' never reaches routines of other threads", async () => {
    await withHarness({}, async ({ send, active, outbox, ledger }) => {
      const first = nextTs();
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts: first }));
      await send(mention({ text: "every day at 5pm post the build report" }));
      await send(mention({ text: "cancel this routine", threadTs: first }));
      await send(mention({ text: "cancel this routine", threadTs: first }));
      await send(mention({ text: "cancel this routine" }));
      expect(active().map((schedule) => schedule.prompt)).toEqual(["post the build report"]);
      expect(outbox().at(-1)!.payload.text).toBe("There's no active routine here to cancel. Say `list routines` to see them.");
      expect(ledger().slice(-2).map((row) => row.reason)).toEqual(["no-match", "no-match"]);
    });
  });

  test("a DM routine is the owner's: other channels cannot see or cancel it", async () => {
    await withHarness({}, async ({ send, active }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs", channel: "D1", type: "message", mention: false }));
      const [schedule] = active("D1") as [ScheduleSummary];
      await send(mention({ text: `cancel routine ${shortScheduleId(schedule.scheduleId)}`, user: "U2" }));
      expect(active("D1")).toHaveLength(1);
    });
  });
});

describe("Slack routines: Cancel button", () => {
  test("cancels once; a second click gets an only-you note and no second notice", async () => {
    await withHarness({}, async ({ send, active, outbox, routines, store }) => {
      const ts = nextTs();
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts }));
      const [schedule] = active() as [ScheduleSummary];
      const notes: string[] = [];
      const respond = async (text: string) => {
        notes.push(text);
      };
      expect(await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId, user: "U2", threadTs: ts }), respond)).toBe("accepted");
      expect(await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId, user: "U2", threadTs: ts }), respond)).toBe("denied");
      expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ state: "cancelled", endedReason: "user-cancelled" });
      const notices = outbox().filter((row) => row.clientMessageId === `${schedule.scheduleId}:cancelled`);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ taskId: schedule.taskId, threadTs: ts });
      expect(notices[0]!.payload.text).toStartWith(`:wastebasket: <@U2> cancelled routine \`${shortScheduleId(schedule.scheduleId)}\``);
      expect(notes).toEqual(["That routine is no longer active, so there was nothing to cancel."]);
    });
  });

  test("a click on a list card posts the notice in the list's thread", async () => {
    await withHarness({}, async ({ send, active, outbox, routines }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      const listTs = nextTs();
      await send(mention({ text: "list routines", ts: listTs }));
      const [schedule] = active() as [ScheduleSummary];
      expect(await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId, messageTs: "2999.000009", threadTs: listTs }))).toBe(
        "accepted",
      );
      expect(outbox().at(-1)).toMatchObject({ clientMessageId: `${schedule.scheduleId}:cancelled`, threadTs: listTs });
    });
  });

  test("ignores clicks from another team, a non-allowed user or a mismatched channel", async () => {
    await withHarness({}, async ({ send, active, routines }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      const [schedule] = active() as [ScheduleSummary];
      const { scheduleId } = schedule;
      expect(await routines.cancelFromAction(click({ scheduleId, team: "T9" }))).toBe("ignored");
      expect(await routines.cancelFromAction(click({ scheduleId, user: "U9" }))).toBe("ignored");
      expect(await routines.cancelFromAction(click({ scheduleId, channel: "C2" }))).toBe("ignored");
      expect(await routines.cancelFromAction(click({ scheduleId, channel: "C9" }))).toBe("ignored");
      expect(await routines.cancelFromAction({ actions: [] })).toBe("ignored");
      expect(await routines.cancelFromAction(click({ scheduleId: "not-a-uuid" }))).toBe("ignored");
      expect(active()).toHaveLength(1);
    });
  });

  test("another allowed user cannot cancel a DM routine", async () => {
    await withHarness({}, async ({ send, active, routines }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs", channel: "D1", type: "message", mention: false }));
      const [schedule] = active("D1") as [ScheduleSummary];
      const notes: string[] = [];
      expect(
        await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId, user: "U2", channel: "D1" }), async (text) => {
          notes.push(text);
        }),
      ).toBe("denied");
      expect(notes).toEqual(["You can't cancel that routine with the current configuration."]);
      expect(active("D1")).toHaveLength(1);
      expect(await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId, channel: "D1" }))).toBe("accepted");
    });
  });

  test("text cancel then a button click posts one notice", async () => {
    await withHarness({}, async ({ send, active, outbox, routines }) => {
      await send(mention({ text: "every weekday at 9am summarize open PRs" }));
      const [schedule] = active() as [ScheduleSummary];
      await send(mention({ text: `cancel routine ${shortScheduleId(schedule.scheduleId)}` }));
      expect(await routines.cancelFromAction(click({ scheduleId: schedule.scheduleId }))).toBe("denied");
      expect(outbox().filter((row) => row.payload.text.startsWith(":wastebasket:"))).toHaveLength(1);
    });
  });
});

describe("Slack routines: routing", () => {
  test("only a mention or a DM is a routine request", async () => {
    await withHarness({}, async ({ route, send }) => {
      expect(route(mention({ text: "list routines" }))).toMatchObject({ kind: "routine", intent: { kind: "list" } });
      expect(route(mention({ text: "list routines", channel: "D1", type: "message", mention: false }))).toMatchObject({
        kind: "routine",
      });
      // An unmentioned channel message is ambient at most, never a routine.
      expect(route(mention({ text: "every weekday at 9am summarize open PRs", type: "message", mention: false }))).toEqual({
        kind: "ignored",
        reason: "ambient-disabled",
      });
      // An unmentioned reply in a bound thread steers the agent.
      const root = nextTs();
      await send(mention({ text: "every weekday at 9am summarize open PRs", ts: root }));
      expect(
        route(mention({ text: "every day at 5pm post the build report", type: "message", mention: false, threadTs: root })),
      ).toMatchObject({ kind: "accepted" });
    });
  });

  test("denied users never reach routine detection", async () => {
    await withHarness({}, async ({ route }) => {
      expect(route(mention({ text: "list routines", user: "U9" }))).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(route(mention({ text: "list routines", user: "U2", channel: "D1", type: "message", mention: false }))).toEqual({
        kind: "ignored",
        reason: "dm-owner-denied",
      });
    });
  });

  test("a free-text cancel that matches no routine stays a prompt", async () => {
    await withHarness({}, async ({ route, send }) => {
      expect(route(mention({ text: "remove the schedule field from the API" }))).toMatchObject({ kind: "accepted" });
      await send(mention({ text: "every day at 5pm post the build report" }));
      expect(route(mention({ text: "cancel the routine about build report" }))).toMatchObject({
        kind: "routine",
        intent: { kind: "cancel", ref: { kind: "text", text: "build report" } },
      });
    });
  });

  test("routines.enabled false makes every request a prompt", async () => {
    await withHarness({ config: makeConfig({ routines: { enabled: false } }) }, async ({ route }) => {
      expect(route(mention({ text: "every weekday at 9am summarize open PRs" }))).toMatchObject({ kind: "accepted" });
    });
  });
});

describe("matchCancelTargets", () => {
  const schedule = (scheduleId: string, prompt: string, threadTs: string) =>
    ({ scheduleId, prompt, threadTs, state: "active" }) as ScheduleSummary;
  const active = [
    schedule("a1b2c3d4-0000-4000-8000-000000000000", "Summarize open PRs", "1.1"),
    schedule("a1b2ffff-0000-4000-8000-000000000000", "post build report", "2.2"),
  ];

  test("resolves each reference kind", () => {
    expect(matchCancelTargets(active, { kind: "only" }, "2.2")).toEqual([active[1]!]);
    expect(matchCancelTargets(active, { kind: "only" }, "9.9")).toEqual([]);
    expect(matchCancelTargets(active, { kind: "index", index: 1 }, "9.9")).toEqual([active[0]!]);
    expect(matchCancelTargets(active, { kind: "index", index: 3 }, "9.9")).toEqual([]);
    expect(matchCancelTargets(active, { kind: "id", prefix: "a1b2" }, "9.9")).toEqual(active);
    expect(matchCancelTargets(active, { kind: "id", prefix: "a1b2c3" }, "9.9")).toEqual([active[0]!]);
    expect(matchCancelTargets(active, { kind: "text", text: "open prs" }, "9.9")).toEqual([active[0]!]);
  });
});
