// PR-F live check (owner-run, real Slack + real T3). Runs Agent Tag's own service loops (coordinators,
// interaction worker, outbox) against a private T3 and the workspace's bot token, without Socket Mode,
// so a live service on the same app keeps receiving every event. Mentions and Stop clicks are injected
// through the real routers (SlackEventRouter, SlackActionRouter) as the given human; everything Slack
// shows is posted, reacted and edited by the real outbox. A recorder polls `conversations.replies` and
// keeps every distinct revision of every bot message, then the checks for PR-F Done 3-7 run on that.
//
//   AGENT_TAG_LIVE=1 bun run scripts/live/pr-f.ts --config CONFIG --actor U… [--out DIR]
//
// CONFIG must be a throwaway config: external T3 mode, a fresh dataDir, `limits.maxConcurrentTasks` 1
// (the ack check needs the only coordinator busy), one routed channel with that channel allowed.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, type AgentTagConfig } from "../../src/config.ts";
import { AgentTagCoordinator } from "../../src/coordinator.ts";
import { InteractionWorker } from "../../src/interaction-worker.ts";
import { readSecretFile } from "../../src/security/secret-file.ts";
import { AgentTagService, type ServiceLogRecord } from "../../src/service.ts";
import { SlackActionRouter } from "../../src/slack/actions.ts";
import { refreshRenderers, SLACK_CLIENT_OPTIONS } from "../../src/slack/bridge.ts";
import { SlackEventRouter } from "../../src/slack/events.ts";
import { deliverNextSlackOutbox } from "../../src/slack/outbox.ts";
import { deliverNextSlackReaction } from "../../src/slack/reactions.ts";
import { STOP_ACTION_ID } from "../../src/slack/status.ts";
import { AgentTagStore } from "../../src/store/store.ts";
import { T3Connection } from "../../src/t3/connection.ts";
import { protocolV1Source, ThreadWatcher } from "../../src/t3/watcher.ts";

interface Block {
  readonly type: string;
  readonly text?: { readonly text: string };
  readonly elements?: ReadonlyArray<{ readonly type: string; readonly text?: unknown; readonly action_id?: string; readonly value?: string }>;
}
interface SlackMessage {
  readonly ts: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly blocks?: ReadonlyArray<Block>;
  readonly reactions?: ReadonlyArray<{ readonly name: string; readonly users?: readonly string[] }>;
}
interface Revision {
  readonly seenAt: string;
  readonly text: string;
  readonly blocks: ReadonlyArray<Block>;
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
  console.error("usage: AGENT_TAG_LIVE=1 bun run scripts/live/pr-f.ts --config CONFIG --actor U… [--out DIR]");
  process.exit(2);
}
const config: AgentTagConfig = await loadConfig(configPath);
if (config.t3.mode !== "external") throw new Error("use an external (private) T3 for the live check");
if (config.limits.maxConcurrentTasks !== 1) throw new Error("set limits.maxConcurrentTasks to 1 (the ack check needs it busy)");
const route = config.routes[0];
if (route === undefined || !config.access.allowedChannelIds.includes(route.conversationId)) {
  throw new Error("route one allowed channel");
}
const channel = route.conversationId;
const out = argument("out") ?? join(config.dataDir, "pr-f-live");
await mkdir(out, { recursive: true });

const { webApi } = await import("@slack/bolt");
const slack = new webApi.WebClient((await readSecretFile(config.slack.botTokenFile)).exposeToBoundary(), SLACK_CLIENT_OPTIONS);
const auth = (await slack.auth.test()) as { team_id?: string; user_id?: string; bot_id?: string };
if (auth.team_id !== config.slack.workspaceId || auth.user_id === undefined) throw new Error("bot token is for another workspace");
const botUserId = auth.user_id;

const logs: ServiceLogRecord[] = [];
const logger = (record: ServiceLogRecord) => logs.push(record);
const store = await AgentTagStore.open(join(config.dataDir, "agent-tag.sqlite"));
const t3 = new T3Connection({ config: config.t3, logger });
const watcher = new ThreadWatcher({ source: protocolV1Source(t3), logger, lingerMs: config.t3.watch.lingerMs });
const renderers = refreshRenderers(store, config);
const workerId = `pr-f-live-${crypto.randomUUID()}`;
const service = new AgentTagService({
  store,
  // The outbox half of SlackSocketBridge (same delivery functions, reactions first); no Socket Mode.
  bridge: {
    start: async () => {},
    stop: async () => {},
    deliverNextOutbox: async () => {
      const reaction = await deliverNextSlackReaction({
        config,
        store,
        workerId,
        addReaction: (input) => slack.reactions.add(input),
      });
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
  coordinators: [new AgentTagCoordinator({ config, store, t3, watcher })],
  interactionWorkers: [new InteractionWorker({ store, config, t3 })],
  resources: [{ close: async () => { await watcher.close(); await t3.close(); } }],
  logger,
});
const events = new SlackEventRouter({ config, store, botUserId, ...(auth.bot_id === undefined ? {} : { selfBotId: auth.bot_id }) });
const actions = new SlackActionRouter({ config, store });

// --- recorder -----------------------------------------------------------------------------------
const threads = new Map<string, Map<string, Revision[]>>();
const standIns = new Set<string>();
const rootReactions = new Map<string, { readonly name: string; readonly seenAt: string }[]>();
async function record(threadTs: string): Promise<SlackMessage[]> {
  const page = (await slack.conversations.replies({ channel, ts: threadTs, limit: 200 })) as { messages?: SlackMessage[] };
  const messages = page.messages ?? [];
  const seenAt = new Date().toISOString();
  const byTs = threads.get(threadTs) ?? new Map<string, Revision[]>();
  threads.set(threadTs, byTs);
  for (const message of messages) {
    if (message.ts === threadTs) {
      const seen = rootReactions.get(threadTs) ?? [];
      for (const reaction of message.reactions ?? []) {
        if (!seen.some((entry) => entry.name === reaction.name)) seen.push({ name: reaction.name, seenAt });
      }
      rootReactions.set(threadTs, seen);
    }
    // The harness's own stand-in human messages are posted by the bot too; only Agent Tag's are recorded.
    if (message.user !== botUserId || message.ts === threadTs || standIns.has(message.ts)) continue;
    const revisions = byTs.get(message.ts) ?? [];
    const last = revisions.at(-1);
    const blocks = message.blocks ?? [];
    if (last === undefined || last.text !== (message.text ?? "") || JSON.stringify(last.blocks) !== JSON.stringify(blocks)) {
      revisions.push({ seenAt, text: message.text ?? "", blocks });
    }
    byTs.set(message.ts, revisions);
  }
  return messages;
}
const watched = new Set<string>();
let recording = true;
const recorder = (async () => {
  while (recording) {
    for (const threadTs of watched) {
      try {
        await record(threadTs);
      } catch (error) {
        console.error(`recorder: ${String(error)}`);
      }
    }
    await Bun.sleep(400);
  }
})();

// --- scenario helpers ---------------------------------------------------------------------------
async function postRoot(text: string): Promise<string> {
  const posted = (await slack.chat.postMessage({ channel, text })) as { ts?: string };
  if (posted.ts === undefined) throw new Error("chat.postMessage returned no ts");
  watched.add(posted.ts);
  return posted.ts;
}

/** A human's mention of the bot at `ts` (thread root, or a reply in `threadTs`), as Slack delivers it. */
function mention(ts: string, request: string, threadTs?: string): { operationId: string; ingestedAt: number } {
  const ingestedAt = Date.now();
  const result = events.ingest({
    type: "event_callback",
    event_id: `Ev${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    team_id: config.slack.workspaceId,
    event: { type: "app_mention", channel, user: actor, text: `<@${botUserId}> ${request}`, ts, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) },
  });
  if (result.kind !== "accepted") throw new Error(`mention not accepted: ${JSON.stringify(result)}`);
  return { operationId: result.receipt.operationId, ingestedAt };
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

const settled = (operationId: string) => {
  const state = store.getStatusMessageView(operationId)?.state;
  return state === "done" || state === "stopped" || state === "failed" || state === "expired" ? state : undefined;
};

function stopButton(blocks: ReadonlyArray<Block>): string | undefined {
  for (const block of blocks) {
    for (const element of block.elements ?? []) {
      if (element.action_id === STOP_ACTION_ID && element.value !== undefined) return element.value;
    }
  }
  return undefined;
}

function sectionText(revision: Revision | undefined): string {
  return (revision?.blocks ?? []).flatMap((block) => (block.type === "section" ? [block.text?.text ?? ""] : [])).join("\n");
}

/** Bot messages of one thread split into status messages (first revision has Stop) and replies. */
function classify(threadTs: string) {
  const byTs = [...(threads.get(threadTs)?.entries() ?? [])].sort(([a], [b]) => Number(a) - Number(b));
  const statuses = byTs.filter(([, revisions]) => stopButton(revisions[0]?.blocks ?? []) !== undefined);
  const replies = byTs.filter(([, revisions]) => stopButton(revisions[0]?.blocks ?? []) === undefined);
  return { statuses, replies };
}

const checks: Array<{ readonly done: string; readonly pass: boolean; readonly detail: string }> = [];
const check = (done: string, pass: boolean, detail: string) => {
  checks.push({ done, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${done}: ${detail}`);
};

await service.start();
const stamp = new Date().toISOString().slice(0, 16);
try {
  // Scenario 1 (Done 5, 7, 3): a tool-using turn holds the only coordinator; a second mention still
  // gets its ack from the outbox loop alone.
  const rootA = await postRoot(`[pr-f live ${stamp}] A: progress, footer and files changed`);
  const turnA = mention(
    rootA,
    "In this repository, read README.md, then create notes/one.md, notes/two.md and notes/three.md with one sentence each about the README, one file per edit. Then reply with a two-line summary.",
  );
  await until("A's status message", 60_000, () => store.getStatusMessageView(turnA.operationId)?.state === "running" ? true : undefined);
  const rootB = await postRoot(`[pr-f live ${stamp}] B: ack while busy`);
  const turnB = mention(rootB, "Reply with exactly: ack-ok");
  const ack = await until("B's ack reaction", 10_000, () =>
    logs.find((entry) => entry.event === "slack.reaction.added" && entry.reactionKey?.startsWith(turnB.operationId) === true),
  );
  const busy = store.getStatusMessageView(turnA.operationId)?.state;
  const ackMs = Date.parse(ack.at) - turnB.ingestedAt;
  check("3 ack while busy", ackMs <= 2_000 && busy === "running", `reactions.add ok ${ackMs} ms after ingest; A still ${busy}`);
  await until("A settles", 300_000, () => settled(turnA.operationId));
  await until("B settles", 120_000, () => settled(turnB.operationId));
  await Bun.sleep(3_000);
  await record(rootA);
  await record(rootB);
  {
    const { statuses, replies } = classify(rootA);
    const revisions = statuses[0]?.[1] ?? [];
    const distinct = new Set(revisions.map((revision) => JSON.stringify(revision))).size;
    check("5 live progress", statuses.length === 1 && distinct >= 3 && replies.length === 1, `${distinct} status revisions; ${replies.length} final reply message(s)`);
    const final = replies.at(-1)?.[1].at(-1);
    const footer = (final?.blocks ?? []).find((block) => block.type === "context");
    const footerText = JSON.stringify(footer?.elements ?? []);
    const model = (await t3.fetchThread(store.getTaskExecution(store.getStatusMessageView(turnA.operationId)?.taskId ?? "").threadId)).thread.modelSelection;
    check(
      "7 footer",
      footerText.includes(model.model) && footerText.includes(model.instanceId) && sectionText(final) === (final?.text ?? "") && (final?.text ?? "").length > 0,
      `footer ${footerText}; snapshot ${model.model} · ${model.instanceId}`,
    );
    const done = revisions.at(-1)?.text ?? "";
    check("F4 done line", /^Done in .+ · \d+ files? changed$/.test(done) && stopButton(revisions.at(-1)?.blocks ?? []) === undefined, `status ended "${done}"`);
  }

  // Scenario 2 (Done 4, B12): three turns in one thread, one status message each, none left live.
  const rootC = await postRoot(`[pr-f live ${stamp}] C: three turns, one status message each`);
  const first = mention(rootC, "Reply with exactly: turn-1");
  await until("C turn 1", 120_000, () => settled(first.operationId));
  for (const index of [2, 3]) {
    const reply = (await slack.chat.postMessage({ channel, thread_ts: rootC, text: `follow-up ${index}` })) as { ts?: string };
    standIns.add(reply.ts ?? "");
    const turn = mention(reply.ts ?? "", `Reply with exactly: turn-${index}`, rootC);
    await until(`C turn ${index}`, 120_000, () => settled(turn.operationId));
  }
  await Bun.sleep(3_000);
  await record(rootC);
  {
    const { statuses } = classify(rootC);
    const live = statuses.filter(([, revisions]) => stopButton(revisions.at(-1)?.blocks ?? []) !== undefined);
    check("4 B12", statuses.length === 3 && live.length === 0, `${statuses.length} status messages; ${live.length} still have Stop`);
  }

  // Scenario 3 (Done 6): Stop on a running turn, clicked by the actor.
  const rootD = await postRoot(`[pr-f live ${stamp}] D: Stop`);
  const turnD = mention(
    rootD,
    "Create the files count/01.md through count/20.md, one file per edit, each containing only its number. Do not batch edits. Then reply 'counted'.",
  );
  const value = await until("D's Stop button in Slack", 60_000, async () => {
    const messages = await record(rootD);
    for (const message of messages) {
      const button = message.user === botUserId ? stopButton(message.blocks ?? []) : undefined;
      if (button !== undefined) return { value: button, ts: message.ts };
    }
    return undefined;
  });
  await Bun.sleep(4_000);
  const click = actions.ingest({
    type: "block_actions",
    team: { id: config.slack.workspaceId },
    user: { id: actor },
    channel: { id: channel },
    trigger_id: "pr-f-live",
    message: { ts: value.ts, thread_ts: rootD },
    actions: [{ action_id: STOP_ACTION_ID, action_ts: `${Date.now() / 1_000}`, value: value.value }],
  });
  const stopState = await until("D settles", 120_000, () => settled(turnD.operationId));
  await Bun.sleep(3_000);
  await record(rootD);
  {
    const task = store.getTaskExecution(store.getStatusMessageView(turnD.operationId)?.taskId ?? "");
    const turn = (await t3.fetchThread(task.threadId)).thread.latestTurn;
    const { statuses, replies } = classify(rootD);
    const last = statuses[0]?.[1].at(-1);
    check(
      "6 Stop",
      click.kind === "accepted" && stopState === "stopped" && turn?.state === "interrupted" && last?.text === `Stopped by <@${actor}>` && replies.length === 0,
      `click ${click.kind}; status "${last?.text}"; T3 turn ${turn?.state}; ${replies.length} reply message(s)`,
    );
  }
} finally {
  recording = false;
  await recorder;
  await service.stop();
  const report = {
    channel,
    checks,
    reactions: Object.fromEntries(rootReactions),
    threads: Object.fromEntries([...threads].map(([ts, messages]) => [ts, Object.fromEntries(messages)])),
    logs: logs.filter((entry) => entry.event.startsWith("slack.") || entry.event === "worker.outcome" || entry.event === "t3.connection.stats"),
  };
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${join(out, "report.json")}`);
}
process.exit(checks.every((entry) => entry.pass) ? 0 : 1);
