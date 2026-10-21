// PR-P2c live check (owner-run, real Slack + real T3): plain-language model switches. Runs Agent Tag's
// service loops (coordinator, outbox) against a private T3 and the workspace's bot token without Socket
// Mode, so a live service on the same app keeps receiving every event. The human's messages are posted
// as bot stand-ins and injected through the real SlackEventRouter + SlackModelSwitch (handleSlackEvent)
// as the given human; every reply Slack shows is posted by the real outbox. Checks read Slack back
// (conversations.replies), the store and the T3 snapshot.
//
//   AGENT_TAG_LIVE=1 bun run scripts/live/p2c.ts --config CONFIG --actor U… [--out DIR]
//
// CONFIG must be a throwaway config: external T3 mode, a fresh dataDir, one routed channel with that
// channel allowed, default `claudeAgent/claude-haiku-4-5`, and allowedModels `claude-sonnet-4-6`
// (alias sonnet) and `codex/gpt-5.6-sol` (alias sol).
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, type AgentTagConfig } from "../../src/config.ts";
import { AgentTagCoordinator } from "../../src/coordinator.ts";
import { InteractionWorker } from "../../src/interaction-worker.ts";
import { readSecretFile } from "../../src/security/secret-file.ts";
import { AgentTagService, type ServiceLogRecord } from "../../src/service.ts";
import { handleSlackEvent, refreshRenderers, SLACK_CLIENT_OPTIONS } from "../../src/slack/bridge.ts";
import { SlackEventRouter } from "../../src/slack/events.ts";
import { SlackModelSwitch } from "../../src/slack/model-switch.ts";
import { deliverNextSlackOutbox } from "../../src/slack/outbox.ts";
import { deliverNextSlackReaction } from "../../src/slack/reactions.ts";
import { AgentTagStore } from "../../src/store/store.ts";
import { T3Connection } from "../../src/t3/connection.ts";
import { inspectT3 } from "../../src/t3/gateway.ts";
import { ProviderCatalog } from "../../src/t3/provider-catalog.ts";
import { protocolV1Source, ThreadWatcher } from "../../src/t3/watcher.ts";

interface SlackMessage {
  readonly ts: string;
  readonly text?: string;
  readonly user?: string;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

if (Bun.env.AGENT_TAG_LIVE !== "1") {
  console.error("refusing to run: set AGENT_TAG_LIVE=1 (posts to a real Slack channel and runs real T3 turns)");
  process.exit(2);
}
const configPath = argument("config");
const actor = argument("actor");
if (configPath === undefined || actor === undefined) {
  console.error("usage: AGENT_TAG_LIVE=1 bun run scripts/live/p2c.ts --config CONFIG --actor U… [--out DIR]");
  process.exit(2);
}
const config: AgentTagConfig = await loadConfig(configPath);
if (config.t3.mode !== "external") throw new Error("use an external (private) T3 for the live check");
const route = config.routes[0];
if (route === undefined || !config.access.allowedChannelIds.includes(route.conversationId)) {
  throw new Error("route one allowed channel");
}
const channel = route.conversationId;
const out = argument("out") ?? join(config.dataDir, "p2c-live");
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
await mkdir(out, { recursive: true });

const { webApi } = await import("@slack/bolt");
const slack = new webApi.WebClient((await readSecretFile(config.slack.botTokenFile)).exposeToBoundary(), SLACK_CLIENT_OPTIONS);
const auth = (await slack.auth.test()) as { team_id?: string; user_id?: string; bot_id?: string };
if (auth.team_id !== config.slack.workspaceId || auth.user_id === undefined) throw new Error("bot token is for another workspace");
const botUserId = auth.user_id;

const logs: ServiceLogRecord[] = [];
const logger = (record: ServiceLogRecord) => {
  logs.push(record);
  if (record.level !== "info") console.error(JSON.stringify(record));
};
const store = await AgentTagStore.open(join(config.dataDir, "agent-tag.sqlite"));
const t3 = new T3Connection({ config: config.t3, logger });
const catalog = new ProviderCatalog({ inspect: () => inspectT3(config.t3) });
if (!(await catalog.refresh())) throw new Error("private T3 provider catalog unavailable");
const watcher = new ThreadWatcher({ source: protocolV1Source(t3), logger, lingerMs: config.t3.watch.lingerMs });
const renderers = refreshRenderers(store, config);
const workerId = `p2c-live-${crypto.randomUUID()}`;
const service = new AgentTagService({
  store,
  // The outbox half of SlackSocketBridge (same delivery functions, reactions first); no Socket Mode.
  bridge: {
    start: async () => {},
    stop: async () => {},
    deliverNextOutbox: async () => {
      const reaction = await deliverNextSlackReaction({ config, store, workerId, addReaction: (input) => slack.reactions.add(input) });
      if (reaction.kind !== "idle") return reaction;
      return deliverNextSlackOutbox({
        config,
        store,
        workerId,
        postMessage: (message) => slack.chat.postMessage(message),
        updateMessage: (message) => slack.chat.update(message),
        refreshRenderers: renderers,
      });
    },
  },
  coordinators: [new AgentTagCoordinator({ config, store, t3, watcher, catalog })],
  interactionWorkers: [new InteractionWorker({ store, config, t3 })],
  resources: [{ close: async () => { await watcher.close(); await t3.close(); } }],
  logger,
});
const router = new SlackEventRouter({ config, store, botUserId, catalog, ...(auth.bot_id === undefined ? {} : { selfBotId: auth.bot_id }) });
const ephemerals: string[] = [];
const models = new SlackModelSwitch({
  config: () => config,
  store,
  catalog,
  botName: "Agent Tag",
  logger,
  replies: {
    ephemeral: async ({ payload }) => {
      ephemerals.push(payload.text);
    },
  },
});
const commands = { execute: async () => { throw new Error("no ! commands in this check"); } };

const stamp = new Date().toISOString().slice(0, 16);

// --- helpers ------------------------------------------------------------------------------------
const standIns = new Set<string>();

async function replies(threadTs: string): Promise<SlackMessage[]> {
  for (;;) {
    try {
      const page = (await slack.conversations.replies({ channel, ts: threadTs, limit: 200 })) as { messages?: SlackMessage[] };
      return page.messages ?? [];
    } catch (error) {
      const retryAfter = (error as { retryAfter?: number }).retryAfter;
      if (retryAfter === undefined) throw error;
      await Bun.sleep(retryAfter * 1_000);
    }
  }
}

/** Agent Tag's own messages in the thread (not the root or the human stand-ins). */
async function botTexts(threadTs: string): Promise<string[]> {
  return (await replies(threadTs))
    .filter((message) => message.user === botUserId && message.ts !== threadTs && !standIns.has(message.ts))
    .map((message) => message.text ?? "");
}

/**
 * The human's message: posted in Slack as a labelled stand-in (the bot cannot post as the human),
 * then delivered to the real router and switch handler as the human's event at that ts.
 */
async function say(text: string, options: { readonly threadTs?: string; readonly mention?: boolean } = {}): Promise<string> {
  const mention = options.mention ?? true;
  const posted = (await slack.chat.postMessage({
    channel,
    text: `[p2c live ${stamp}, as <@${actor}>] ${mention ? "@Agent Tag " : ""}${text}`,
    ...(options.threadTs === undefined ? {} : { thread_ts: options.threadTs }),
  })) as { ts?: string };
  if (posted.ts === undefined) throw new Error("chat.postMessage returned no ts");
  standIns.add(posted.ts);
  await handleSlackEvent({ router, commands, models }, {
    type: "event_callback",
    event_id: `Ev${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    team_id: config.slack.workspaceId,
    event: {
      type: mention ? "app_mention" : "message",
      channel,
      user: actor,
      text: mention ? `<@${botUserId}> ${text}` : text,
      ts: posted.ts,
      ...(options.threadTs === undefined ? {} : { thread_ts: options.threadTs }),
    },
  });
  return posted.ts;
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(500);
  }
}

const reader = new Database(join(config.dataDir, "agent-tag.sqlite"), { readonly: true });
const count = (sql: string, ...params: string[]): number => (reader.query(sql).get(...params) as { n: number }).n;
const operations = (taskId: string) => count("SELECT COUNT(*) AS n FROM operations WHERE task_id = ?", taskId);
const completed = (taskId: string) => count("SELECT COUNT(*) AS n FROM operations WHERE task_id = ? AND status = 'succeeded'", taskId);
const outboxIdle = () => count("SELECT COUNT(*) AS n FROM slack_outbox WHERE status IN ('pending', 'inflight')") === 0;

/** Waits for the bot's thread messages to include one matching `match`, then returns it. */
async function botReply(threadTs: string, what: string, match: (text: string) => boolean): Promise<string> {
  return until(what, 60_000, async () => (await botTexts(threadTs)).find(match));
}

const checks: Array<{ readonly name: string; readonly pass: boolean; readonly detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

await service.start();
try {
  // 4a: a new thread picks its model before the first turn, which bootstraps T3 on it.
  const root = await say("use sonnet: Reply with exactly: p2c-one");
  const taskId = await until("the thread's task", 10_000, () =>
    store.findTaskForThread({ workspaceId: config.slack.workspaceId, conversationId: channel, threadTs: root })?.taskId,
  );
  const switched = await botReply(root, "the switched reply", (text) => text.startsWith("Switched this thread to"));
  await until("turn 1", 180_000, () => (completed(taskId) >= 1 ? true : undefined));
  const one = (await t3.fetchThread(store.getTaskExecution(taskId).threadId)).thread;
  check(
    "4a pre-start switch + request",
    switched.includes("Sonnet") && switched.includes("The first turn will use it.") && one.modelSelection.model === "claude-sonnet-4-6",
    `reply "${switched}"; T3 thread model ${one.modelSelection.instanceId}/${one.modelSelection.model}`,
  );

  // 4b + 4e: a plain reply in the bound thread switches in place with no turn; the next turn runs on it.
  const before = operations(taskId);
  await say("switch to haiku", { threadTs: root, mention: false });
  const inPlace = await botReply(root, "the in-place switched reply", (text) => text.includes("*Haiku*"));
  await until("outbox idle", 30_000, () => (outboxIdle() ? true : undefined));
  check("4e switch-only runs no turn", operations(taskId) === before, `${operations(taskId) - before} new operation(s); reply "${inPlace}"`);
  await say("Reply with exactly: p2c-two", { threadTs: root });
  await until("turn 2", 180_000, () => (completed(taskId) >= 2 ? true : undefined));
  const two = (await t3.fetchThread(store.getTaskExecution(taskId).threadId)).thread;
  check(
    "4b same-driver switch in place",
    two.modelSelection.model === "claude-haiku-4-5" && two.latestTurn?.state === "completed" && two.session?.lastError === null,
    `T3 thread model ${two.modelSelection.model}; latest turn ${two.latestTurn?.state}; lastError ${two.session?.lastError ?? null}`,
  );

  // 4c: another provider on the started thread is refused, and the request after it is not run.
  const ops = operations(taskId);
  await say("use sol: Reply with exactly: p2c-three", { threadTs: root });
  const refused = await botReply(root, "the cross-provider refusal", (text) => text.startsWith("This thread already started on"));
  check(
    "4c cross-provider refused, request not started",
    operations(taskId) === ops && refused.includes("Your request was not started.") && store.getTaskExecution(taskId).desiredModelSelection?.model === "claude-haiku-4-5",
    `reply "${refused}"; ${operations(taskId) - ops} new operation(s)`,
  );

  // 4d: a model T3 serves but the profile does not allow is refused with the allowed list.
  await say("use claude-opus-4-5", { threadTs: root });
  const notAllowed = await botReply(root, "the not-allowed reply", (text) => text.includes("isn't allowed here"));
  check("4d not allowed", notAllowed.includes("Allowed:") && notAllowed.includes("*Sonnet*"), `reply "${notAllowed}"`);

  // An ordinary request that starts with "use" stays a request.
  const switches = () => count("SELECT COUNT(*) AS n FROM slack_command_events WHERE command_kind = 'model-switch'");
  const ledgerBefore = switches();
  await say("use the README to tell me the project title, in five words or fewer", { threadTs: root });
  await until("turn 3", 180_000, () => (completed(taskId) >= 3 ? true : undefined));
  check(
    "prompt stays a prompt",
    switches() === ledgerBefore && completed(taskId) === 3,
    `${switches() - ledgerBefore} new model-switch ledger row(s); completed turns ${completed(taskId)}`,
  );
  check("no ephemeral errors", ephemerals.length === 0, `${ephemerals.length} ephemeral(s)`);
  await until("outbox idle", 30_000, () => (outboxIdle() ? true : undefined));
} catch (error) {
  check("run", false, error instanceof Error ? error.message : String(error));
} finally {
  const audits = store.listAuditRecords({ limit: 200 }).filter((record) => record.action.startsWith("task.model."));
  await service.stop();
  const report = {
    channel,
    checks,
    audits,
    logs: logs.filter((entry) => entry.event.startsWith("slack.") || entry.event.startsWith("model.") || entry.event === "worker.outcome"),
  };
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${join(out, "report.json")}`);
}
process.exit(checks.every((entry) => entry.pass) ? 0 : 1);
