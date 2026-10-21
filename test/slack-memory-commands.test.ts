// K2: memory phrases from Slack (PR-K §2-A, §3.5-3.7). Parser table, then router + handler against a
// real store with a fake clock and fake Slack.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagCommands, type CommandReplySender } from "../src/commands/handler.ts";
import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import type { ConversationVisibility } from "../src/memory.ts";
import { handleSlackEvent } from "../src/slack/bridge.ts";
import { SlackEventRouter } from "../src/slack/events.ts";
import { type MemoryCommand, parseMemoryCommand } from "../src/slack/memory-grammar.ts";
import { SlackMemoryCommands } from "../src/slack/memory-commands.ts";
import { listReplies } from "../src/slack/memory-replies.ts";
import { ConversationVisibilityResolver } from "../src/slack/visibility.ts";
import { outboxPayloadSchema } from "../src/store/schema.ts";
import type { MemoryRecord, SlackOutboxPayload, StoreFaultPoint } from "../src/store/store.ts";
import { AgentTagStore } from "../src/store/store.ts";

describe("parseMemoryCommand", () => {
  const cases: ReadonlyArray<readonly [string, MemoryCommand | null]> = [
    // remember, here
    ["remember: reports go out as tables", { kind: "remember", target: "here", content: "reports go out as tables" }],
    ["Remember: Deploys on Tuesday", { kind: "remember", target: "here", content: "Deploys on Tuesday" }],
    ["remember for this channel: changes go to acme/data", { kind: "remember", target: "here", content: "changes go to acme/data" }],
    ["remember this for this channel: x", { kind: "remember", target: "here", content: "x" }],
    ["please remember: use pnpm", { kind: "remember", target: "here", content: "use pnpm" }],
    ["remember for here: y", { kind: "remember", target: "here", content: "y" }],
    ["remember for me: I prefer terse replies", { kind: "remember", target: "here", content: "I prefer terse replies" }],
    ["remember for this dm: z", { kind: "remember", target: "here", content: "z" }],
    ["remember :  spaced  ", { kind: "remember", target: "here", content: "spaced" }],
    ["remember: line one\nline two", { kind: "remember", target: "here", content: "line one\nline two" }],
    ["remember: a: b: c", { kind: "remember", target: "here", content: "a: b: c" }],
    ["!remember use tabs", { kind: "remember", target: "here", content: "use tabs" }],
    ["!remember channel: use tabs", { kind: "remember", target: "here", content: "use tabs" }],
    ["!REMEMBER here: q", { kind: "remember", target: "here", content: "q" }],
    // remember, workspace
    ["remember for the workspace: our default branch is main", { kind: "remember", target: "workspace", content: "our default branch is main" }],
    ["remember for workspace: w", { kind: "remember", target: "workspace", content: "w" }],
    ["remember for everyone: e", { kind: "remember", target: "workspace", content: "e" }],
    ["Please remember for all channels: a", { kind: "remember", target: "workspace", content: "a" }],
    ["!remember --workspace main is default", { kind: "remember", target: "workspace", content: "main is default" }],
    ["!remember -w main", { kind: "remember", target: "workspace", content: "main" }],
    ["!remember -wow this works", { kind: "remember", target: "here", content: "-wow this works" }],
    ["!remember --workspaces are neat", { kind: "remember", target: "here", content: "--workspaces are neat" }],
    ["!remember workspace: main", { kind: "remember", target: "workspace", content: "main" }],
    // list
    ["what do you remember?", { kind: "list" }],
    ["What do you remember", { kind: "list" }],
    ["what do you remember about this channel?", { kind: "list" }],
    ["what do you remember about me?", { kind: "list" }],
    ["what do you remember here", { kind: "list" }],
    ["show memory", { kind: "list" }],
    ["list your memories", { kind: "list" }],
    ["!memory", { kind: "list" }],
    ["!memory list", { kind: "list" }],
    // forget
    ["forget a1b2c3d4", { kind: "forget", ref: "a1b2c3d4" }],
    ["forget `A1B2C3D4`", { kind: "forget", ref: "a1b2c3d4" }],
    ["forget #abcd", { kind: "forget", ref: "abcd" }],
    ["!forget 0f3e", { kind: "forget", ref: "0f3e" }],
    ["forget deadbeef", { kind: "forget", ref: "deadbeef" }],
    ["forget a1b2c3d4-e5f6", { kind: "forget", ref: "a1b2c3d4-e5f6" }],
    ["forget: tables", { kind: "forget-match", match: "tables" }],
    ["forget : the deploy rule", { kind: "forget-match", match: "the deploy rule" }],
    ["forget: a -&gt; b &amp; c", { kind: "forget-match", match: "a -> b & c" }],
    // edit
    ["update memory a1b2c3d4: reports go out as CSV", { kind: "edit", ref: "a1b2c3d4", content: "reports go out as CSV" }],
    ["update memory `a1b2c3d4`: x", { kind: "edit", ref: "a1b2c3d4", content: "x" }],
    ["!memory edit a1b2c3d4 new text", { kind: "edit", ref: "a1b2c3d4", content: "new text" }],
    // conversational sentences stay requests
    ["remember that outage last week?", null],
    ["do you remember the deploy?", null],
    ["remember to update the changelog", null],
    ["forget it", null],
    ["forget about the deploy", null],
    ["forget cafe", null],
    ["forget decade", null],
    ["what do you remember about the outage?", null],
    ["can you show memory usage of the service", null],
    ["remember:", null],
    ["remember:    ", null],
    ["forget:", null],
    ["!remember", null],
    ["!remember --workspace", null],
    ["!forget", null],
    ["update memory a1b2c3d4", null],
    ["update memory: x", null],
    ["summarize the remember: feature", null],
    ["", null],
    ["!memory foo", null],
  ];
  test(`has at least 40 cases (${cases.length})`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(parseMemoryCommand(input)).toEqual(expected);
    });
  }
});

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
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1", "C2", "G1", "D1"] },
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
      ambient: { enabled: true, keywords: ["remember"], cooldownSeconds: 60, maxTurnsPerHour: 10 },
    },
  ],
  routes: [
    { conversationId: "C1", profileId: "engineering", repositoryRoot: root },
    { conversationId: "C2", profileId: "engineering", repositoryRoot: root },
    { conversationId: "G1", profileId: "engineering", repositoryRoot: root },
    { conversationId: "D1", conversationType: "dm", ownerUserId: "U1", profileId: "engineering" },
  ],
  limits: { maxConcurrentTasks: 2 },
};

function makeConfig(mutate: (input: typeof baseInput) => unknown = (input) => input): AgentTagConfig {
  return agentTagConfigSchema.parse(mutate(structuredClone(baseInput)));
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
      throw new Error("memory commands never post directly");
    },
  };
}

let tsCounter = 0;
function nextTs(): string {
  tsCounter += 1;
  return `3000.${String(tsCounter).padStart(6, "0")}`;
}

function event(input: {
  readonly text: string;
  readonly ts?: string;
  readonly user?: string;
  readonly channel?: string;
  readonly threadTs?: string;
  readonly type?: "app_mention" | "message";
  readonly mention?: boolean;
}): unknown {
  const ts = input.ts ?? nextTs();
  return {
    type: "event_callback",
    event_id: `Ev${ts.replace(".", "")}${input.type ?? "app_mention"}`,
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
  readonly conversationId: string;
  readonly threadTs: string;
  readonly payload: SlackOutboxPayload;
}

interface Harness {
  readonly store: AgentTagStore;
  readonly db: Database;
  readonly sender: ReturnType<typeof fakeSender>;
  readonly send: (body: unknown) => Promise<void>;
  readonly route: (body: unknown) => ReturnType<SlackEventRouter["ingest"]>;
  readonly outbox: () => ReadonlyArray<OutboxRow>;
  readonly texts: () => ReadonlyArray<string>;
  readonly notes: () => ReadonlyArray<MemoryRecord>;
  readonly count: (table: string) => number;
  readonly ledger: () => ReadonlyArray<{ command_kind: string; outcome: string; reason: string | null; memory_id: string | null }>;
  readonly audit: () => string;
}

const VISIBILITY: Record<string, ConversationVisibility> = { C1: "public", C2: "public", G1: "private" };

async function withHarness(
  options: {
    readonly config?: AgentTagConfig;
    readonly faultInjector?: (point: StoreFaultPoint) => void;
    readonly visibility?: Record<string, ConversationVisibility>;
  },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const config = options.config ?? makeConfig();
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-memory-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path, options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector });
  const db = new Database(path);
  const sender = fakeSender();
  let clock = start;
  const now = () => new Date(clock);
  const visibility = options.visibility ?? VISIBILITY;
  const memory = new SlackMemoryCommands({
    config: () => config,
    store,
    replies: sender,
    visibility: { resolve: async ({ conversationId }) => visibility[conversationId] ?? "unknown" },
    users: { label: async (userId) => ({ label: userId === "U1" ? "Ursula" : `name-${userId}` }) },
    now,
  });
  const commands = new AgentTagCommands({ config: () => config, store, replies: sender, now });
  const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => now().toISOString() });
  try {
    const outbox = () =>
      (
        db
          .query("SELECT client_message_id, conversation_id, thread_ts, payload_json FROM slack_outbox ORDER BY created_at, rowid")
          .all() as { client_message_id: string; conversation_id: string; thread_ts: string; payload_json: string }[]
      ).map((row) => ({
        clientMessageId: row.client_message_id,
        conversationId: row.conversation_id,
        threadTs: row.thread_ts,
        payload: outboxPayloadSchema.parse(JSON.parse(row.payload_json)),
      }));
    await run({
      store,
      db,
      sender,
      send: (body) => {
        clock += 1_000;
        return handleSlackEvent({ router, commands, memory }, body);
      },
      route: (body) => router.ingest(body),
      outbox,
      texts: () => outbox().map((row) => row.payload.text),
      notes: () =>
        (db.query("SELECT memory_id FROM memory_entries WHERE state = 'active' ORDER BY created_at, rowid").all() as { memory_id: string }[]).map(
          (row) => {
            const record = store.getMemory(row.memory_id);
            if (record === null) throw new Error("note vanished");
            return record;
          },
        ),
      count: (table) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ledger: () =>
        db.query("SELECT command_kind, outcome, reason, memory_id FROM slack_command_events ORDER BY rowid").all() as {
          command_kind: string;
          outcome: string;
          reason: string | null;
          memory_id: string | null;
        }[],
      audit: () => JSON.stringify(store.listAuditRecords({ limit: 1_000 })),
    });
  } finally {
    db.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-slack-memory-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function refOf(text: string): string {
  const match = /`([0-9a-f]{8})`/.exec(text);
  if (match === null) throw new Error(`no ref in ${text}`);
  return match[1]!;
}

describe("memory phrases from Slack", () => {
  test("a mention + remember for this channel saves a channel note with one thread reply and no operation", async () => {
    await withHarness({}, async (h) => {
      const ts = nextTs();
      await h.send(event({ text: "remember for this channel: reports go out as tables", ts }));
      const [note] = h.notes();
      expect(h.notes()).toHaveLength(1);
      expect(note).toMatchObject({ scope: "channel", conversationId: "C1", content: "reports go out as tables", createdBy: "U1" });
      const rows = h.outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ conversationId: "C1", threadTs: ts });
      expect(rows[0]!.payload.text).toStartWith(`Saved to this channel's memory (\`${note!.memoryId.slice(0, 8)}\`): reports go out as tables`);
      expect(h.count("operations")).toBe(0);
      expect(h.count("slack_events")).toBe(0);
      expect(h.ledger()).toEqual([{ command_kind: "memory-remember", outcome: "succeeded", reason: null, memory_id: note!.memoryId }]);
      expect(h.sender.sent).toEqual([]);
    });
  });

  test("the app_mention + message pair for one ts saves one note and sends one reply", async () => {
    await withHarness({}, async (h) => {
      const ts = nextTs();
      await h.send(event({ text: "remember: deploys on Tuesday", ts }));
      await h.send(event({ text: "remember: deploys on Tuesday", ts, type: "message" }));
      await h.send(event({ text: "remember: deploys on Tuesday", ts }));
      expect(h.notes()).toHaveLength(1);
      expect(h.outbox()).toHaveLength(1);
      expect(h.count("slack_events")).toBe(0);
    });
  });

  test("an unmentioned top-level remember: in a channel is ambient, not a command", async () => {
    await withHarness({}, async (h) => {
      const result = h.route(event({ text: "remember: x", mention: false, type: "message" }));
      expect(result.kind).toBe("accepted");
      expect(h.notes()).toHaveLength(0);
    });
  });

  test("an unmentioned remember: in a bound thread is a command", async () => {
    await withHarness({}, async (h) => {
      const rootTs = nextTs();
      await h.send(event({ text: "investigate the flaky test", ts: rootTs }));
      expect(h.count("operations")).toBe(1);
      await h.send(event({ text: "remember: the flaky test is in CI only", threadTs: rootTs, mention: false, type: "message" }));
      expect(h.notes()).toHaveLength(1);
      expect(h.count("operations")).toBe(1);
      expect(h.outbox().at(-1)).toMatchObject({ threadTs: rootTs });
    });
  });

  test("an unmentioned remember: in an unbound thread is ignored", async () => {
    await withHarness({}, async (h) => {
      const result = h.route(event({ text: "remember: x", threadTs: "2000.000001", mention: false, type: "message" }));
      expect(result).toEqual({ kind: "ignored", reason: "unbound-thread" });
    });
  });

  test("in a DM, remember: is private to the route owner and invisible from the channel", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember: I prefer terse replies", channel: "D1", mention: false, type: "message" }));
      await h.send(event({ text: "remember for this channel: reports go out as tables" }));
      const [dmNote, channelNote] = h.notes();
      expect(dmNote).toMatchObject({ scope: "private", ownerUserId: "U1", profileId: "engineering", conversationId: null });
      expect(h.texts()[0]).toStartWith("Saved to your DM memory (");
      await h.send(event({ text: "what do you remember?", channel: "D1", mention: false, type: "message" }));
      await h.send(event({ text: "what do you remember?" }));
      const [, , dmList, channelList] = h.texts();
      expect(dmList).toContain(dmNote!.content);
      expect(dmList).not.toContain(channelNote!.content);
      expect(channelList).toContain(channelNote!.content);
      expect(channelList).not.toContain(dmNote!.content);
    });
  });

  test("a DM from a non-owner is denied before parsing", async () => {
    await withHarness({}, async (h) => {
      const result = h.route(event({ text: "remember: x", channel: "D1", user: "U2", mention: false, type: "message" }));
      expect(result).toEqual({ kind: "ignored", reason: "dm-owner-denied" });
    });
  });

  test("a non-allowed user gets nothing", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember: x", user: "U9" }));
      expect(h.notes()).toHaveLength(0);
      expect(h.outbox()).toHaveLength(0);
    });
  });

  test("what do you remember? lists channel and workspace notes with author and date, and pings nobody", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember for this channel: ping <!channel> and <@U2> about <#C2|ops> &lt;b&gt;" }));
      await h.send(event({ text: "remember for the workspace: our default branch is main", user: "U2" }));
      await h.send(event({ text: "what do you remember?" }));
      const list = h.texts().at(-1)!;
      expect(list).toStartWith("*What I remember here*");
      expect(list).toContain("*This channel* (1)");
      expect(list).toContain("*Workspace* (1)");
      expect(list).toContain("our default branch is main — name-U2 · 2026-10-21");
      expect(list).toContain("— Ursula · 2026-10-21");
      expect(list).not.toMatch(/<[@!#]/);
      expect(list).toContain("&lt;b&gt;");
    });
  });

  test("the list marks workspace notes read-only in a private channel", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember for the workspace: main" }));
      await h.send(event({ text: "what do you remember?", channel: "G1" }));
      expect(h.texts().at(-1)).toContain("*Workspace* _(read-only here)_ (1)");
    });
  });

  test("an empty list says how to add a note", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "what do you remember?" }));
      expect(h.texts()).toEqual([
        'I don\'t have any notes for this channel yet. Say "remember for this channel: …" to add one.',
      ]);
    });
  });

  test("workspace notes save from a public channel, are refused from a private or unknown one, and show in other channels", async () => {
    await withHarness({ visibility: { C1: "public", G1: "private" } }, async (h) => {
      await h.send(event({ text: "remember for the workspace: our default branch is main" }));
      expect(h.texts()[0]).toStartWith("Saved to workspace memory (");
      await h.send(event({ text: "remember for the workspace: secret plan", channel: "G1" }));
      expect(h.texts()[1]).toBe('Workspace notes can only be saved from a public channel. Use "remember for this channel: …" here.');
      await h.send(event({ text: "remember for the workspace: unknown", channel: "C2" }));
      expect(h.texts()[2]).toStartWith("Workspace notes can only be saved from a public channel.");
      await h.send(event({ text: "remember for this channel: private note", channel: "G1" }));
      expect(h.texts()[3]).toStartWith("Saved to this channel's memory (");
      await h.send(event({ text: "what do you remember?", channel: "C2" }));
      expect(h.texts()[4]).toContain("our default branch is main");
      expect(h.texts()[4]).not.toContain("private note");
      expect(h.notes().map((note) => note.scope)).toEqual(["shared", "channel"]);
      expect(h.ledger().map((row) => row.reason)).toEqual([null, "workspace-write-requires-public-channel", "workspace-write-requires-public-channel", null, null]);
    });
  });

  test("forget <ref> removes the note; a ref from another channel answers not-here and is audited as denied", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember for this channel: reports go out as tables" }));
      await h.send(event({ text: "remember for this channel: other channel note", channel: "C2" }));
      const ref = refOf(h.texts()[0]!);
      const otherRef = refOf(h.texts()[1]!);
      await h.send(event({ text: `forget ${otherRef}` }));
      expect(h.texts()[2]).toBe(`I don't have a note \`${otherRef}\` here.`);
      expect(h.audit()).toContain("memory.denied");
      await h.send(event({ text: `forget ${ref}` }));
      expect(h.texts()[3]).toBe(`Forgot \`${ref}\`: reports go out as tables`);
      await h.send(event({ text: "what do you remember?" }));
      expect(h.texts()[4]).not.toContain("reports go out as tables");
      expect(h.notes().map((note) => note.content)).toEqual(["other channel note"]);
    });
  });

  test("forget: <text> forgets the one matching note, or lists candidates", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember: deploys on Tuesday" }));
      await h.send(event({ text: "remember: deploys need a review" }));
      await h.send(event({ text: "remember: tables for reports" }));
      await h.send(event({ text: "forget: deploys" }));
      expect(h.texts()[3]).toStartWith('More than one note matches "deploys".');
      await h.send(event({ text: "forget: TABLES" }));
      expect(h.texts()[4]).toStartWith("Forgot `");
      await h.send(event({ text: "forget: nothing like this" }));
      expect(h.texts()[5]).toBe('I don\'t have a note matching "nothing like this" here that I can forget.');
      expect(h.notes()).toHaveLength(2);
      // Slack entity-encodes & < >: the note is stored decoded and the match decodes too.
      await h.send(event({ text: "remember: a -&gt; b &amp; c" }));
      expect(h.texts()[6]).toContain(": a -&gt; b &amp; c\n");
      await h.send(event({ text: "forget: -&gt; b &amp;" }));
      expect(h.texts()[7]).toStartWith("Forgot `");
      expect(h.texts()[7]).toEndWith(": a -&gt; b &amp; c");
      expect(h.notes()).toHaveLength(2);
    });
  });

  test("update memory <ref>: changes the note and bumps its version", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember: reports go out as tables" }));
      const ref = refOf(h.texts()[0]!);
      await h.send(event({ text: `update memory ${ref}: reports go out as CSV` }));
      expect(h.texts()[1]).toBe(`Updated \`${ref}\` (version 2): reports go out as CSV`);
      expect(h.notes()[0]).toMatchObject({ content: "reports go out as CSV", version: 2, updatedBy: "U1" });
    });
  });

  test("workspace notes are read-only from a private channel", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember for the workspace: main" }));
      const ref = refOf(h.texts()[0]!);
      await h.send(event({ text: `forget ${ref}`, channel: "G1" }));
      expect(h.texts()[1]).toStartWith("That note can't be changed from here.");
      expect(h.notes()).toHaveLength(1);
      await h.send(event({ text: `forget ${ref}`, channel: "C2" }));
      expect(h.notes()).toHaveLength(0);
    });
  });

  test("a duplicate, a too-long note and a credential are refused with stable copy", async () => {
    const config = makeConfig((input) => {
      input.profiles[0]!.memory = { ...input.profiles[0]!.memory, maxEntryChars: 50 } as typeof input.profiles[0]["memory"];
      return input;
    });
    await withHarness({ config }, async (h) => {
      await h.send(event({ text: "remember: use tabs" }));
      const ref = refOf(h.texts()[0]!);
      await h.send(event({ text: "remember:  USE TABS " }));
      expect(h.texts()[1]).toBe(`Already in memory as \`${ref}\`.`);
      await h.send(event({ text: `remember: ${"x".repeat(51)}` }));
      expect(h.texts()[2]).toBe("That note is longer than 50 characters. Keep notes short, and put playbooks in the repository.");
      const secret = `ghp_${"a".repeat(36)}`;
      await h.send(event({ text: `remember: token ${secret}` }));
      expect(h.texts()[3]).toBe("That looks like a credential, so I didn't save it. Store secrets with the operator instead.");
      expect(h.notes()).toHaveLength(1);
      expect(h.audit()).not.toContain(secret);
    });
  });

  test("the audit log never holds note content", async () => {
    await withHarness({}, async (h) => {
      await h.send(event({ text: "remember: zebra-unique-content" }));
      const ref = refOf(h.texts()[0]!);
      await h.send(event({ text: `update memory ${ref}: yak-unique-content` }));
      await h.send(event({ text: "what do you remember?" }));
      await h.send(event({ text: `forget ${ref}` }));
      const audit = h.audit();
      expect(audit).toContain("memory.created");
      expect(audit).toContain("memory.forgotten");
      expect(audit).toContain("slack.command.executed");
      expect(audit).not.toContain("zebra-unique-content");
      expect(audit).not.toContain("yak-unique-content");
    });
  });

  test("slackCommands=false sends every phrase to the agent as a normal turn", async () => {
    const config = makeConfig((input) => {
      input.profiles[0]!.memory = { ...input.profiles[0]!.memory, slackCommands: false } as typeof input.profiles[0]["memory"];
      return input;
    });
    await withHarness({ config }, async (h) => {
      for (const text of ["remember: x", "what do you remember?", "forget a1b2c3d4", "update memory a1b2c3d4: y"]) {
        expect(h.route(event({ text })).kind).toBe("accepted");
      }
      expect(h.notes()).toHaveLength(0);
    });
  });

  test("a crash after the memory change rolls everything back, and the redelivery saves the note once", async () => {
    let crash = true;
    await withHarness(
      {
        faultInjector: (point) => {
          if (point === "command.after-execute" && crash) {
            crash = false;
            throw new Error("injected crash");
          }
        },
      },
      async (h) => {
        const ts = nextTs();
        await h.send(event({ text: "remember: survive the crash", ts }));
        expect(h.notes()).toHaveLength(0);
        expect(h.outbox()).toHaveLength(0);
        expect(h.ledger()).toHaveLength(0);
        expect(h.sender.sent.map((sent) => sent.text)).toEqual([
          "Something went wrong while changing memory, so nothing was changed. Try again in a moment.",
        ]);
        await h.send(event({ text: "remember: survive the crash", ts, type: "message" }));
        expect(h.notes()).toHaveLength(1);
        expect(h.outbox()).toHaveLength(1);
        expect(h.ledger()).toHaveLength(1);
      },
    );
  });

  test("an actor who lost access after routing gets an only-you denial and nothing changes", async () => {
    let config = makeConfig();
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-memory-"));
    const path = join(directory, "agent-tag.sqlite");
    const store = await AgentTagStore.open(path);
    const sender = fakeSender();
    try {
      const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: () => new Date(start).toISOString() });
      const routed = router.ingest(event({ text: "remember: x" }));
      if (routed.kind !== "memory") throw new Error(`expected memory, got ${routed.kind}`);
      config = makeConfig((input) => {
        input.access.allowedUserIds = ["U2"];
        input.routes[3]!.ownerUserId = "U2";
        return input;
      });
      const memory = new SlackMemoryCommands({ config: () => config, store, replies: sender });
      expect(await memory.handle(routed)).toEqual({ kind: "executed", outcome: "denied", reason: "execution-denied" });
      expect(sender.sent.map((sent) => sent.text)).toEqual(["You can't change memory in this thread."]);
      const db = new Database(path);
      try {
        expect(db.query("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
        expect(db.query("SELECT COUNT(*) AS n FROM slack_outbox").get()).toEqual({ n: 0 });
        expect(db.query("SELECT outcome, reason FROM slack_command_events").all()).toEqual([{ outcome: "denied", reason: "execution-denied" }]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      await rm(directory, { recursive: true });
    }
  });

  test("a long list splits into several outbox rows in order", () => {
    const notes = Array.from({ length: 60 }, (_, index): MemoryRecord => ({
      memoryId: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
      workspaceId: "T1",
      scope: "channel",
      profileId: null,
      taskId: null,
      ownerUserId: null,
      conversationId: "C1",
      content: `note ${index} ${"x".repeat(80)}`,
      sourceType: "slack-message",
      sourceId: "C1:1.1",
      version: 1,
      expiresAt: "2027-01-01T00:00:00.000Z",
      createdBy: "U1",
      updatedBy: null,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
    }));
    const replies = listReplies({
      groups: { channel: notes, dm: [], operator: [], task: [], workspace: [] },
      conversationType: "channel",
      workspaceWritable: true,
      labels: new Map(),
    });
    expect(replies.length).toBeGreaterThan(1);
    expect(replies.every((reply) => reply.text.length <= 3_500)).toBe(true);
    expect(replies.map((reply) => reply.text).join("\n")).toContain("note 59 ");
  });
});

describe("ConversationVisibilityResolver", () => {
  test("DMs, route overrides, cached lookups, and fail-closed errors", async () => {
    const calls: string[] = [];
    let clock = 0;
    const logs: string[] = [];
    const config = makeConfig((input) => {
      (input.routes[1] as Record<string, unknown>)["visibility"] = "private";
      return input;
    });
    const resolver = new ConversationVisibilityResolver({
      config: () => config,
      conversationsInfo: async (channel) => {
        calls.push(channel);
        if (channel === "G1") throw Object.assign(new Error("missing"), { data: { error: "missing_scope" } });
        return { ok: true, channel: { is_private: false } };
      },
      logger: (record) => logs.push(`${record.event}:${record.errorCode}`),
      now: () => clock,
      ttlMs: 1_000,
    });
    expect(await resolver.resolve({ conversationId: "D1", conversationType: "dm" })).toBe("dm");
    expect(await resolver.resolve({ conversationId: "C2", conversationType: "channel" })).toBe("private");
    expect(await resolver.resolve({ conversationId: "C1", conversationType: "channel" })).toBe("public");
    expect(await resolver.resolve({ conversationId: "C1", conversationType: "channel" })).toBe("public");
    expect(calls).toEqual(["C1"]);
    clock = 2_000;
    expect(await resolver.resolve({ conversationId: "C1", conversationType: "channel" })).toBe("public");
    expect(calls).toEqual(["C1", "C1"]);
    expect(await resolver.resolve({ conversationId: "G1", conversationType: "channel" })).toBe("unknown");
    expect(await resolver.resolve({ conversationId: "G1", conversationType: "channel" })).toBe("unknown");
    expect(logs).toEqual(["slack.visibility.lookup_failed:missing_scope"]);
  });
});
