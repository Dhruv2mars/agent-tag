import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagCommands, type CommandReplySender } from "../src/commands/handler.ts";
import * as replies from "../src/commands/replies.ts";
import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { COMMAND_REPLY_RETRY_CAP_MS, createCommandReplySender, handleSlackEvent } from "../src/slack/bridge.ts";
import { SlackEventRouter } from "../src/slack/events.ts";
import type { SlackOutboxPayload } from "../src/store/store.ts";
import { AgentTagStore } from "../src/store/store.ts";

const receivedAt = "2026-09-21T00:00:00.000Z";
const nowMs = Date.parse("2026-09-21T00:10:00.000Z");
const root = "/srv/repos/example";
const thread = "1000.000001";

const baseInput = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1", "D1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: [root, "/srv/repos/other"],
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
    { conversationId: "D1", conversationType: "dm", ownerUserId: "U1", profileId: "engineering" },
  ],
  limits: { maxConcurrentTasks: 2 },
};

function makeConfig(overrides: Record<string, unknown> = {}): AgentTagConfig {
  return agentTagConfigSchema.parse({ ...baseInput, ...overrides });
}

interface SentReply {
  readonly kind: "ephemeral" | "post";
  readonly channel: string;
  readonly user?: string;
  readonly threadTs?: string;
  readonly text: string;
}

function fakeSender(): CommandReplySender & { readonly sent: SentReply[] } {
  const sent: SentReply[] = [];
  return {
    sent,
    async ephemeral({ channel, user, threadTs, payload }) {
      sent.push({ kind: "ephemeral", channel, user, ...(threadTs === undefined ? {} : { threadTs }), text: payload.text });
    },
    async post({ channel, threadTs, payload }) {
      sent.push({ kind: "post", channel, threadTs, text: payload.text });
      return { ts: "9999.000001" };
    },
  };
}

function eventBody(input: {
  readonly eventId: string;
  readonly type?: "app_mention" | "message";
  readonly user?: string;
  readonly channel?: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly text: string;
}): unknown {
  return {
    type: "event_callback",
    event_id: input.eventId,
    team_id: "T1",
    event: {
      type: input.type ?? "app_mention",
      user: input.user ?? "U1",
      channel: input.channel ?? "C1",
      ts: input.ts,
      text: input.text,
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    },
  };
}

interface Harness {
  readonly store: AgentTagStore;
  readonly db: Database;
  readonly sender: ReturnType<typeof fakeSender>;
  readonly send: (body: unknown, config?: AgentTagConfig) => Promise<void>;
  readonly route: (body: unknown, config?: AgentTagConfig) => ReturnType<SlackEventRouter["ingest"]>;
  readonly commandRows: () => ReadonlyArray<Record<string, unknown>>;
  readonly auditActions: () => ReadonlyArray<string>;
}

async function withHarness(config: AgentTagConfig, run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-commands-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const db = new Database(path);
  const sender = fakeSender();
  const commandsFor = (current: AgentTagConfig) =>
    new AgentTagCommands({ config: () => current, store, replies: sender, now: () => new Date(nowMs) });
  const routerFor = (current: AgentTagConfig) =>
    new SlackEventRouter({ config: current, store, botUserId: "U0BOT", now: () => receivedAt });
  try {
    await run({
      store,
      db,
      sender,
      send: (body, current = config) =>
        handleSlackEvent({ router: routerFor(current), commands: commandsFor(current) }, body),
      route: (body, current = config) => routerFor(current).ingest(body),
      commandRows: () =>
        db.query("SELECT * FROM slack_command_events ORDER BY received_at, event_key").all() as Record<string, unknown>[],
      auditActions: () =>
        (db.query("SELECT action FROM audit_log ORDER BY created_at, audit_id").all() as { action: string }[]).map(
          (row) => row.action,
        ),
    });
  } finally {
    db.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-commands-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

/** Binds thread `1000.000001` in C1 to a task with one queued operation. */
async function bindThread(harness: Harness): Promise<void> {
  await harness.send(eventBody({ eventId: "EvBind", ts: thread, text: "<@U0BOT> investigate this" }));
  expect(harness.store.diagnostics()).toMatchObject({ tasks: 1, operations: 1 });
}

function inThread(eventId: string, ts: string, text: string, extra: { user?: string; type?: "message" } = {}): unknown {
  return eventBody({ eventId, ts, threadTs: thread, text, ...extra });
}

describe("!commands", () => {
  test("!help answers only-you, writes the ledger and creates no operation or slack event", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await harness.send(eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !help" }));
      expect(harness.sender.sent).toHaveLength(1);
      const reply = harness.sender.sent[0]!;
      expect(reply).toMatchObject({ kind: "ephemeral", channel: "C1", user: "U1" });
      expect(reply.threadTs).toBeUndefined();
      for (const name of ["!help", "!status", "!mute", "!unmute"]) expect(reply.text).toContain(name);
      expect(reply.text).not.toContain("!model");
      expect(harness.store.diagnostics()).toMatchObject({ events: 0, tasks: 0, operations: 0, outbox: 0 });
      expect(harness.commandRows()).toEqual([
        expect.objectContaining({ event_key: "C1:1000.000100", command_kind: "help", outcome: "succeeded", actor_user_id: "U1" }),
      ]);
      expect(harness.auditActions()).toContain("slack.command.executed");
    });
  });

  test("the app_mention + message pair and a redelivery execute once", async () => {
    await withHarness(makeConfig(), async (harness) => {
      const text = "<@U0BOT> !help";
      await harness.send(eventBody({ eventId: "Ev1", ts: "1000.000100", text }));
      await harness.send(eventBody({ eventId: "Ev2", type: "message", ts: "1000.000100", text }));
      await harness.send(eventBody({ eventId: "Ev1", ts: "1000.000100", text }));
      expect(harness.sender.sent).toHaveLength(1);
      expect(harness.commandRows()).toHaveLength(1);
      expect(harness.auditActions().filter((action) => action === "slack.command.executed")).toHaveLength(1);
    });
  });

  test("a non-command mention is still an ordinary request", async () => {
    await withHarness(makeConfig(), async (harness) => {
      for (const text of ["<@U0BOT> please !help me", "<@U0BOT> !model gpt", "<@U0BOT> !helpme"]) {
        expect(harness.route(eventBody({ eventId: `Ev-${text}`, ts: `1000.${text.length}`, text })).kind).not.toBe("command");
      }
    });
  });

  test("commands.enabled=false turns !status into a normal request", async () => {
    await withHarness(makeConfig({ commands: { enabled: false } }), async (harness) => {
      expect(harness.route(eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !status" })).kind).toBe(
        "accepted",
      );
      expect(harness.store.diagnostics()).toMatchObject({ operations: 1 });
      expect(harness.commandRows()).toHaveLength(0);
    });
  });

  test("a command redelivered after commands are turned off does not become a request", async () => {
    await withHarness(makeConfig(), async (harness) => {
      const event = eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !status" });
      await harness.send(event);
      const off = makeConfig({ commands: { enabled: false } });
      expect(harness.route(event, off)).toEqual({ kind: "ignored", reason: "command-handled" });
      expect(harness.route(eventBody({ eventId: "Ev2", type: "message", ts: "1000.000100", text: "<@U0BOT> !status" }), off))
        .toEqual({ kind: "ignored", reason: "command-handled" });
      expect(harness.store.diagnostics()).toMatchObject({ tasks: 0, operations: 0, events: 0 });
      expect(harness.sender.sent).toHaveLength(1);
    });
  });

  test("a request ingested while commands were off is not re-run as a command", async () => {
    await withHarness(makeConfig(), async (harness) => {
      const event = eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !status" });
      expect(harness.route(event, makeConfig({ commands: { enabled: false } })).kind).toBe("accepted");
      await harness.send(event);
      expect(harness.sender.sent).toHaveLength(0);
      expect(harness.commandRows()).toHaveLength(0);
      expect(harness.store.diagnostics()).toMatchObject({ operations: 1 });
    });
  });

  test("a user outside allowedUserIds and a DM non-owner are ignored silently", async () => {
    await withHarness(makeConfig(), async (harness) => {
      expect(harness.route(eventBody({ eventId: "Ev1", ts: "1000.000100", user: "U9", text: "<@U0BOT> !help" }))).toEqual({
        kind: "ignored",
        reason: "user-denied",
      });
      expect(
        harness.route(eventBody({ eventId: "Ev2", type: "message", channel: "D1", user: "U2", ts: "1000.000200", text: "!help" })),
      ).toEqual({ kind: "ignored", reason: "dm-owner-denied" });
      expect(harness.sender.sent).toHaveLength(0);
      expect(harness.commandRows()).toHaveLength(0);
    });
  });

  test("a DM owner may use the bare form", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await harness.send(eventBody({ eventId: "Ev1", type: "message", channel: "D1", ts: "1000.000100", text: "!status" }));
      expect(harness.sender.sent).toEqual([
        expect.objectContaining({ kind: "ephemeral", channel: "D1", user: "U1", text: expect.stringContaining("in this DM") }),
      ]);
      expect(harness.store.diagnostics()).toMatchObject({ operations: 0 });
    });
  });

  test("a bare !status in a channel is not a command", async () => {
    await withHarness(makeConfig(), async (harness) => {
      expect(harness.route(eventBody({ eventId: "Ev1", type: "message", ts: "1000.000100", text: "!status" })).kind).not.toBe(
        "command",
      );
    });
  });

  test("a disabled command is denied with an only-you note and audited", async () => {
    await withHarness(makeConfig({ commands: { disabled: ["mute"] } }), async (harness) => {
      await bindThread(harness);
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !mute"));
      expect(harness.sender.sent).toEqual([
        expect.objectContaining({ kind: "ephemeral", threadTs: thread, text: "`!mute` isn't enabled in this workspace." }),
      ]);
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(false);
      expect(harness.commandRows()).toEqual([expect.objectContaining({ outcome: "denied", reason: "command-disabled" })]);
      expect(harness.auditActions()).toContain("slack.command.denied");
    });
  });

  test("adminOnly commands require an admin", async () => {
    const config = makeConfig({
      access: { ...baseInput.access, adminUserIds: ["U2"] },
      commands: { adminOnly: ["mute"] },
    });
    await withHarness(config, async (harness) => {
      await bindThread(harness);
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !mute"));
      expect(harness.sender.sent.at(-1)?.text).toBe("Only Agent Tag admins can use `!mute`.");
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(false);
      await harness.send(inThread("Ev2", "1000.000200", "<@U0BOT> !mute", { user: "U2" }));
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(true);
      expect(harness.commandRows().map((row) => row.outcome)).toEqual(["denied", "succeeded"]);
    });
  });

  test("a thread whose task no longer has execution authority is denied", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await bindThread(harness);
      const moved = makeConfig({
        routes: [{ conversationId: "C1", profileId: "engineering", repositoryRoot: "/srv/repos/other" }, baseInput.routes[1]],
      });
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !mute"), moved);
      expect(harness.sender.sent.at(-1)?.text).toBe("I can't run `!mute` in this thread with the current configuration.");
      expect(harness.commandRows().at(-1)).toMatchObject({ outcome: "denied", reason: "task-authority" });
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(false);
    });
  });

  test("!status in a bound thread reports queued work and the model; top-level reports the channel", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await bindThread(harness);
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !status"));
      const threadReply = harness.sender.sent.at(-1)!;
      expect(threadReply).toMatchObject({ kind: "ephemeral", threadTs: thread });
      expect(threadReply.text).toContain("I have 1 request queued here.");
      expect(threadReply.text).toContain("• Muted: no");
      expect(threadReply.text).toContain("• Model: codex / gpt-5.6-sol");
      expect(threadReply.text).not.toContain("investigate");

      await harness.send(eventBody({ eventId: "Ev2", ts: "1000.000200", text: "<@U0BOT> !status" }));
      expect(harness.sender.sent.at(-1)?.text).toContain("I'm working in 0 threads here, 0 waiting on people, 1 queued.");
      expect(harness.store.diagnostics()).toMatchObject({ operations: 1, events: 1 });
    });
  });

  test("!status reports working and waiting durations", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await bindThread(harness);
      const operation = harness.db.query("SELECT operation_id, task_id FROM operations").get() as {
        operation_id: string;
        task_id: string;
      };
      harness.db
        .query("UPDATE operations SET status = 'inflight', t3_turn_started_at = ? WHERE operation_id = ?")
        .run("2026-09-21T00:04:00.000Z", operation.operation_id);
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !status"));
      expect(harness.sender.sent.at(-1)?.text).toContain("I'm working in this thread (started 6m ago).");

      harness.db
        .query(
          `INSERT INTO interactions (interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json, state,
             response_command_id, created_at, updated_at)
           VALUES ('i1', ?, ?, 'thread-1', 'req-1', 'approval', '{}', 'pending', 'resp-1', ?, ?)`,
        )
        .run(operation.task_id, operation.operation_id, "2026-09-21T00:08:00.000Z", "2026-09-21T00:08:00.000Z");
      await harness.send(inThread("Ev2", "1000.000200", "<@U0BOT> !status"));
      expect(harness.sender.sent.at(-1)?.text).toContain("waiting for an answer to an approval or question here (since 2m ago)");

      await harness.send(eventBody({ eventId: "Ev3", ts: "1000.000300", text: "<@U0BOT> !status" }));
      expect(harness.sender.sent.at(-1)?.text).toContain("I'm working in 0 threads here, 1 waiting on people, 0 queued.");
    });
  });

  test("!status in an unbound thread says so", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !status"));
      expect(harness.sender.sent.at(-1)?.text).toContain("I'm not part of this thread yet.");
      expect(harness.store.diagnostics()).toMatchObject({ tasks: 0, operations: 0 });
    });
  });

  test("!mute and !unmute post a public notice through the outbox and are idempotent", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await bindThread(harness);
      const outboxBefore = harness.store.diagnostics().outbox;
      await harness.send(inThread("Ev1", "1000.000100", "<@U0BOT> !mute"));
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(true);
      expect(harness.store.diagnostics().outbox).toBe(outboxBefore + 1);
      const notice = harness.db
        .query("SELECT payload_json FROM slack_outbox WHERE client_message_id = ?")
        .get("cmd:C1:1000.000100") as { payload_json: string } | null;
      expect(JSON.parse(notice!.payload_json).text).toBe(replies.mutedReply("Agent Tag").text);
      expect(harness.sender.sent.filter((reply) => reply.text.startsWith(":mute:"))).toHaveLength(0);

      await harness.send(inThread("Ev2", "1000.000200", "<@U0BOT> !mute"));
      expect(harness.sender.sent.at(-1)?.text).toBe(replies.ALREADY_MUTED.text);
      expect(harness.store.diagnostics().outbox).toBe(outboxBefore + 1);

      await harness.send(inThread("Ev3", "1000.000300", "<@U0BOT> !unmute"));
      expect(harness.store.isThreadMuted({ workspaceId: "T1", conversationId: "C1", threadTs: thread })).toBe(false);
      await harness.send(inThread("Ev4", "1000.000400", "<@U0BOT> !unmute"));
      expect(harness.sender.sent.at(-1)?.text).toBe(replies.NOT_MUTED.text);

      expect(harness.commandRows().map((row) => [row.command_kind, row.outcome, row.reason])).toEqual([
        ["mute", "succeeded", null],
        ["mute", "rejected", "already-muted"],
        ["unmute", "succeeded", null],
        ["unmute", "rejected", "not-muted"],
      ]);
      const actions = harness.auditActions();
      expect(actions.filter((action) => action === "thread.muted")).toHaveLength(1);
      expect(actions.filter((action) => action === "thread.unmuted")).toHaveLength(1);
      expect(harness.store.diagnostics()).toMatchObject({ operations: 1 });
    });
  });

  test("!mute at top level or in an unbound thread is rejected with a hint", async () => {
    await withHarness(makeConfig(), async (harness) => {
      await harness.send(eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !mute" }));
      expect(harness.sender.sent.at(-1)?.text).toBe(replies.muteTopLevelReply("Agent Tag").text);
      await harness.send(inThread("Ev2", "1000.000200", "<@U0BOT> !unmute"));
      expect(harness.sender.sent.at(-1)?.text).toBe(replies.UNMUTE_UNBOUND.text);
      expect(harness.commandRows().map((row) => row.reason)).toEqual(["top-level", "unbound-thread"]);
      expect(harness.store.diagnostics()).toMatchObject({ tasks: 0, outbox: 0 });
    });
  });

  test("a failing reply sender does not fail the command", async () => {
    await withHarness(makeConfig(), async (harness) => {
      const store = harness.store;
      const commands = new AgentTagCommands({
        config: () => makeConfig(),
        store,
        replies: {
          ephemeral: async () => {
            throw new Error("boom");
          },
          post: async () => ({ ts: "1" }),
        },
      });
      const router = new SlackEventRouter({ config: makeConfig(), store, botUserId: "U0BOT", now: () => receivedAt });
      const ingress = router.ingest(eventBody({ eventId: "Ev1", ts: "1000.000100", text: "<@U0BOT> !help" }));
      if (ingress.kind !== "command") throw new Error("expected a command");
      expect(await commands.execute(ingress)).toEqual({ kind: "executed", outcome: "succeeded" });
      expect(harness.commandRows()).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
    });
  });
});

describe("command reply sender", () => {
  function rateLimited(retryAfterSeconds: number): Error {
    return Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: retryAfterSeconds });
  }

  test("retries an only-you reply once after a rate limit, capping the wait", async () => {
    const calls: unknown[] = [];
    const sleeps: number[] = [];
    let failures = 1;
    const sender = createCommandReplySender(
      {
        chat: {
          postEphemeral: async (args) => {
            calls.push(args);
            if (failures-- > 0) throw rateLimited(60);
            return {};
          },
          postMessage: async () => ({ ts: "1" }),
        },
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    const payload: SlackOutboxPayload = { text: "hi" };
    await sender.ephemeral({ channel: "C1", user: "U1", threadTs: thread, payload });
    expect(calls).toEqual([
      { channel: "C1", user: "U1", text: "hi", thread_ts: thread },
      { channel: "C1", user: "U1", text: "hi", thread_ts: thread },
    ]);
    expect(sleeps).toEqual([COMMAND_REPLY_RETRY_CAP_MS]);
  });

  test("does not retry a permanent failure and gives up after one retry", async () => {
    let calls = 0;
    const permanent = createCommandReplySender({
      chat: {
        postEphemeral: async () => {
          calls += 1;
          throw Object.assign(new Error("x"), { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } });
        },
        postMessage: async () => ({ ts: "1" }),
      },
    });
    await expect(permanent.ephemeral({ channel: "C1", user: "U1", payload: { text: "hi" } })).rejects.toThrow();
    expect(calls).toBe(1);

    calls = 0;
    const limited = createCommandReplySender(
      {
        chat: {
          postEphemeral: async () => {
            calls += 1;
            throw rateLimited(1);
          },
          postMessage: async () => ({ ts: "1" }),
        },
      },
      async () => {},
    );
    await expect(limited.ephemeral({ channel: "C1", user: "U1", payload: { text: "hi" } })).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
