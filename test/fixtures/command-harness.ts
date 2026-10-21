// A store, router and `!command` handler wired like the bridge, with a fake reply sender (PR-H2 tests).
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagCommands, type CommandReplySender } from "../../src/commands/handler.ts";
import { type AgentTagConfig, agentTagConfigSchema } from "../../src/config.ts";
import { handleSlackEvent } from "../../src/slack/bridge.ts";
import { SlackEventRouter } from "../../src/slack/events.ts";
import { AgentTagStore, type ClaimedOperation } from "../../src/store/store.ts";

export const ROOT = "/srv/repos/example";
export const THREAD = "1000.000001";

export function makeConfig(overrides: Record<string, unknown> = {}): AgentTagConfig {
  return agentTagConfigSchema.parse({
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
        repositoryRoots: [ROOT],
        baseBranch: "main",
        defaultProviderInstanceId: "codex",
        defaultModel: "gpt-5.6-sol",
        runtimeMode: "approval-required",
        isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
        externalWrites: { mode: "deny" },
        memory: { shared: true, privateDm: false, retentionDays: 180 },
      },
    ],
    routes: [{ conversationId: "C1", profileId: "engineering", repositoryRoot: ROOT }],
    limits: { maxConcurrentTasks: 2 },
    ...overrides,
  });
}

export interface SentReply {
  readonly kind: "ephemeral" | "post";
  readonly channel: string;
  readonly threadTs?: string;
  readonly text: string;
}

/** `<@U0BOT> text` (or plain text) at `ts`, in THREAD unless `topLevel`. */
export function message(ts: string, text: string, options: { readonly user?: string; readonly topLevel?: boolean } = {}): unknown {
  return {
    type: "event_callback",
    event_id: `Ev-${ts}`,
    team_id: "T1",
    event: {
      type: text.includes("<@U0BOT>") ? "app_mention" : "message",
      user: options.user ?? "U1",
      channel: "C1",
      ts,
      text,
      ...(options.topLevel === true || ts === THREAD ? {} : { thread_ts: THREAD }),
    },
  };
}

export interface CommandHarness {
  readonly store: AgentTagStore;
  readonly db: Database;
  readonly sent: SentReply[];
  /** The clock every component reads; tests move it. */
  readonly clock: { now: number };
  readonly send: (body: unknown) => Promise<void>;
  /** Claims the next operation as worker "w" (like a coordinator) with a 60 s lease. */
  readonly claim: () => ClaimedOperation | null;
  /** Marks a claimed operation's turn as sent to and started in T3. */
  readonly startTurn: (operation: ClaimedOperation) => void;
  readonly iso: () => string;
  readonly outboxTexts: () => string[];
  readonly operations: () => ReadonlyArray<{ status: string; last_error_code: string | null; source_order_key: string }>;
  readonly auditActions: () => string[];
}

export async function withCommandHarness(
  config: AgentTagConfig,
  run: (harness: CommandHarness) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-h2-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const db = new Database(path);
  const sent: SentReply[] = [];
  const replies: CommandReplySender = {
    async ephemeral({ channel, threadTs, payload }) {
      sent.push({ kind: "ephemeral", channel, ...(threadTs === undefined ? {} : { threadTs }), text: payload.text });
    },
    async post({ channel, threadTs, payload }) {
      sent.push({ kind: "post", channel, threadTs, text: payload.text });
      return { ts: "9999.000001" };
    },
  };
  const clock = { now: Date.parse("2026-10-21T00:00:00.000Z") };
  const iso = () => new Date(clock.now).toISOString();
  const commands = new AgentTagCommands({ config: () => config, store, replies, now: () => new Date(clock.now) });
  try {
    await run({
      store,
      db,
      sent,
      clock,
      iso,
      send: async (body) => {
        const router = new SlackEventRouter({ config, store, botUserId: "U0BOT", now: iso });
        await handleSlackEvent({ router, commands }, body);
      },
      claim: () => store.claimNextOperation({ workerId: "w", now: iso(), leaseMs: 60_000, maxConcurrentTasks: 2 }),
      startTurn: (operation) => {
        store.markOperationTurnDispatched({
          operationId: operation.operationId,
          workerId: "w",
          threadId: store.getTaskExecution(operation.taskId).threadId,
          now: iso(),
        });
        store.markOperationTurnStarted({ operationId: operation.operationId, workerId: "w", turnId: null, now: iso() });
        store.markT3ThreadStarted({
          taskId: operation.taskId,
          threadId: store.getTaskExecution(operation.taskId).threadId,
          now: iso(),
        });
      },
      outboxTexts: () =>
        (db.query("SELECT payload_json FROM slack_outbox WHERE refresh_kind IS NULL ORDER BY created_at, rowid").all() as {
          payload_json: string;
        }[]).map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
      operations: () =>
        db.query("SELECT status, last_error_code, source_order_key FROM operations ORDER BY source_order_key").all() as {
          status: string;
          last_error_code: string | null;
          source_order_key: string;
        }[],
      auditActions: () =>
        (db.query("SELECT action FROM audit_log ORDER BY created_at, audit_id").all() as { action: string }[]).map(
          (row) => row.action,
        ),
    });
  } finally {
    db.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-h2-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}
