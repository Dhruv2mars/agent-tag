import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, type T3CoordinatorGateway } from "../src/coordinator.ts";
import { InteractionWorker } from "../src/interaction-worker.ts";
import { PROGRESS_LINE_CHARS, TurnProgress } from "../src/progress.ts";
import { SlackActionRouter } from "../src/slack/actions.ts";
import { refreshRenderers } from "../src/slack/bridge.ts";
import { deliverNextSlackOutbox } from "../src/slack/outbox.ts";
import { renderStatusMessage, STOP_ACTION_ID } from "../src/slack/status.ts";
import { pruneRetainedData } from "../src/store/retention.ts";
import { AgentTagStore, type SlackOutboxPayload, type StatusMessageView } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";
import { normalizeV1Item } from "../src/t3/watcher.ts";

const now = "2026-09-21T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
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
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 2 },
});

type Block = NonNullable<SlackOutboxPayload["blocks"]>[number];
interface SlackCall {
  readonly method: "post" | "update";
  /** The posted message's ts (post) or the edited one's (update). */
  readonly ts: string;
  readonly text: string;
  readonly blocks: ReadonlyArray<Block>;
  readonly at: string;
}

interface Harness {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly calls: SlackCall[];
  /** Delivers every claimable outbox row through the real delivery path (fake Slack client). */
  readonly drain: (at: string) => Promise<void>;
}

async function withHarness(run: (harness: Harness) => Promise<void>, harnessConfig = config): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-status-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const calls: SlackCall[] = [];
  let posted = 0;
  try {
    await run({
      store,
      path,
      calls,
      drain: async (clock) => {
        for (;;) {
          const outcome = await deliverNextSlackOutbox({
            config: harnessConfig,
            store,
            workerId: "slack-a",
            now: () => clock,
            refreshRenderers: refreshRenderers(store, harnessConfig),
            postMessage: async (message) => {
              posted += 1;
              const ts = `2000.${String(posted).padStart(6, "0")}`;
              calls.push({ method: "post", ts, text: message.text, blocks: message.blocks ?? [], at: clock });
              return { ts };
            },
            updateMessage: async (message) => {
              calls.push({ method: "update", ts: message.ts, text: message.text, blocks: message.blocks, at: clock });
              return { ok: true };
            },
          });
          if (outcome.kind === "idle") return;
          if (outcome.kind !== "delivered") throw new Error(`outbox row ended ${outcome.kind}`);
        }
      },
    });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-status-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function ingest(store: AgentTagStore, index: number) {
  return store.ingestSlackEvent({
    deliveryId: `delivery-${index}`,
    eventKey: `C1:1000.00000${index}`,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text: `request ${index}`,
    receivedAt: now,
    sourceOrderKey: `1000.00000${index}`,
  });
}

function snapshot(input: {
  readonly threadId: string;
  readonly state: "running" | "completed" | "interrupted";
  readonly turnId: string;
  readonly userMessageId: string | undefined;
  readonly text?: string;
  readonly activities?: T3ThreadSnapshot["thread"]["activities"];
}): T3ThreadSnapshot {
  const running = input.state === "running";
  return {
    snapshotSequence: 9,
    thread: {
      id: input.threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId: input.turnId,
        state: input.state,
        requestedAt: now,
        startedAt: now,
        completedAt: running ? null : now,
        assistantMessageId: input.state === "completed" ? `assistant-${input.turnId}` : null,
      },
      messages: [
        ...(input.userMessageId === undefined ? [] : [{
          id: input.userMessageId,
          role: "user" as const,
          text: "fixture request",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        }]),
        ...(input.state === "completed" ? [{
          id: `assistant-${input.turnId}`,
          role: "assistant" as const,
          text: input.text ?? "",
          turnId: input.turnId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        }] : []),
      ],
      activities: input.activities ?? [],
      session: {
        threadId: input.threadId,
        status: running ? "running" : "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: running ? input.turnId : null,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

function activity(id: string, kind: string, summary: string, turnId: string, payload: unknown = {}) {
  return { id, tone: "tool" as const, kind, summary, payload, turnId, createdAt: now };
}

function hasActions(blocks: ReadonlyArray<Block>): boolean {
  return blocks.some((block) => block.type === "actions");
}

function stopValue(blocks: ReadonlyArray<Block>): string {
  for (const block of blocks) {
    if (block.type !== "actions") continue;
    for (const element of block.elements) {
      if (element.type === "button" && element.action_id === STOP_ACTION_ID && element.value !== undefined) {
        return element.value;
      }
    }
  }
  throw new Error("no Stop button");
}

function stopBody(value: string, userId = "U1", actionTs = "1000.000020"): unknown {
  return {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: userId },
    channel: { id: "C1" },
    trigger_id: "trigger-1",
    message: { ts: "2000.000001", thread_ts: "1000.000001" },
    actions: [{ action_id: STOP_ACTION_ID, action_ts: actionTs, value }],
  };
}

/** The last rendered state of each status post (first post, then its edits), in post order. */
function statusMessages(calls: ReadonlyArray<SlackCall>): Array<{ ts: string; revisions: SlackCall[] }> {
  const posts = calls.filter((call) => call.method === "post" && call.text === "Working on it…");
  return posts.map((post) => ({
    ts: post.ts,
    revisions: [post, ...calls.filter((call) => call.method === "update" && call.ts === post.ts)],
  }));
}

describe("live status message (F3)", () => {
  test("B12: a 3-turn thread posts exactly one status message per turn and none keeps a Stop button", async () => {
    await withHarness(async ({ store, calls, drain }) => {
      let threadId = "not-dispatched";
      let messageId: string | undefined;
      let turn = 0;
      const t3: T3CoordinatorGateway = {
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") {
            threadId = command.threadId;
            messageId = command.message.messageId;
            turn += 1;
          }
          return { sequence: 1 };
        },
        fetchThread: async () =>
          snapshot({ threadId, state: "completed", turnId: `turn-${turn}`, userMessageId: messageId, text: `result ${turn}` }),
      };
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        workerId: "worker-a",
        now: () => new Date(now),
        sleep: async () => {},
      });
      const operations: string[] = [];
      for (const index of [1, 2, 3]) {
        operations.push(ingest(store, index).operationId);
        expect((await coordinator.processNext()).kind).toBe("completed");
        await drain(now);
      }

      const statuses = statusMessages(calls);
      expect(statuses).toHaveLength(3);
      for (const status of statuses) {
        expect(hasActions(status.revisions[0]?.blocks ?? [])).toBe(true);
        const last = status.revisions.at(-1);
        expect(last?.text).toBe("Done in 0s");
        expect(hasActions(last?.blocks ?? [])).toBe(false);
      }
      expect(calls.filter((call) => call.method === "post").map((call) => call.text)).toEqual([
        "Working on it…", "result 1", "Working on it…", "result 2", "Working on it…", "result 3",
      ]);
      for (const operationId of operations) expect(store.getStatusMessageView(operationId)?.state).toBe("done");
    });
  });

  test("Stop interrupts the T3 turn, the status says who stopped it, and no final reply is posted", async () => {
    await withHarness(async ({ store, calls, drain }) => {
      const commands: T3Command[] = [];
      let threadId = "not-dispatched";
      let messageId: string | undefined;
      let interrupted = false;
      let stopped = false;
      const fetchThread = async () =>
        snapshot({ threadId, state: interrupted ? "interrupted" : "running", turnId: "turn-1", userMessageId: messageId });
      const dispatch = async (command: T3Command) => {
        commands.push(command);
        if (command.type === "thread.turn.start") {
          threadId = command.threadId;
          messageId = command.message.messageId;
        }
        if (command.type === "thread.turn.interrupt") interrupted = true;
        return { sequence: commands.length };
      };
      const router = new SlackActionRouter({ config, store, now: () => now });
      const worker = new InteractionWorker({ config, store, t3: { fetchThread, dispatch }, workerId: "interaction-a", now: () => new Date(now) });
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3: {
          dispatch,
          fetchThread: async () => {
            if (!stopped) {
              // The user sees the posted status message and presses its Stop button mid-turn.
              stopped = true;
              await drain(now);
              const value = stopValue(calls[0]?.blocks ?? []);
              expect(router.ingest(stopBody(value, "U2")).kind).toBe("accepted");
              await drain(now);
              expect(calls.at(-1)).toMatchObject({ method: "update", text: "Stopping… (requested by <@U2>)" });
              expect(hasActions(calls.at(-1)?.blocks ?? [])).toBe(false);
              expect((await worker.processNext()).kind).toBe("resolved");
            }
            return fetchThread();
          },
        },
        workerId: "worker-a",
        now: () => new Date(now),
        sleep: async () => {},
      });
      const receipt = ingest(store, 1);
      expect(await coordinator.processNext()).toMatchObject({ kind: "cancelled", operationId: receipt.operationId });
      await drain(now);

      expect(commands.filter((command) => command.type === "thread.turn.interrupt")).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId, turnId: "turn-1" }),
      ]);
      const [status] = statusMessages(calls);
      expect(status?.revisions.at(-1)?.text).toBe("Stopped by <@U2>");
      expect(hasActions(status?.revisions.at(-1)?.blocks ?? [])).toBe(false);
      // The status message is the whole notice: no final reply and no separate "Stopped" line.
      expect(calls.filter((call) => call.method === "post")).toHaveLength(1);
    });
  });

  test("a turn that keeps using tools shows several live revisions and then exactly one final reply", async () => {
    await withHarness(async ({ store, calls, drain }) => {
      let clock = Date.parse(now);
      let threadId = "not-dispatched";
      let messageId: string | undefined;
      let polls = 0;
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3: {
          dispatch: async (command) => {
            if (command.type === "thread.turn.start") {
              threadId = command.threadId;
              messageId = command.message.messageId;
            }
            return { sequence: 1 };
          },
          fetchThread: async () => {
            await drain(new Date(clock).toISOString());
            polls += 1;
            const activities = Array.from({ length: Math.min(polls, 8) }, (_, index) =>
              activity(`tool-${index}`, "tool.completed", `Ran step ${index}`, "turn-1"));
            return snapshot({
              threadId,
              state: polls > 8 ? "completed" : "running",
              turnId: "turn-1",
              userMessageId: messageId,
              text: "the answer",
              activities,
            });
          },
        },
        workerId: "worker-a",
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms;
        },
      });
      ingest(store, 1);
      expect((await coordinator.processNext()).kind).toBe("completed");
      await drain(new Date(clock).toISOString());

      const [status] = statusMessages(calls);
      const live = (status?.revisions ?? []).filter((call) => hasActions(call.blocks));
      expect(new Set(live.map((call) => JSON.stringify(call.blocks))).size).toBeGreaterThanOrEqual(3);
      expect(status?.revisions.at(-1)?.text).toMatch(/^Done in \d+s$/);
      expect(calls.filter((call) => call.method === "post").map((call) => call.text)).toEqual(["Working on it…", "the answer"]);
    });
  });

  test("a Stop button left on an earlier turn's message never stops a later turn", async () => {
    await withHarness(async ({ store }) => {
      const first = ingest(store, 1);
      const claimed = store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 60_000, maxConcurrentTasks: 2 });
      expect(claimed?.operationId).toBe(first.operationId);
      store.markOperationTurnDispatched({ operationId: first.operationId, workerId: "worker-a", now });
      store.markOperationTurnStarted({ operationId: first.operationId, workerId: "worker-a", turnId: "turn-1", now });
      const router = new SlackActionRouter({ config, store, now: () => now });
      const stale = JSON.stringify({ taskId: first.taskId, operationId: "an-earlier-operation" });
      expect(router.ingest(stopBody(stale))).toEqual({ kind: "ignored", reason: "interaction-denied" });
      expect(router.ingest(stopBody("not json"))).toEqual({ kind: "ignored", reason: "invalid-action" });
      const current = JSON.stringify({ taskId: first.taskId, operationId: first.operationId });
      expect(router.ingest(stopBody(current, "U1", "1000.000030")).kind).toBe("accepted");
    });
  });

  test("a burst of 50 progress events edits the message at most once per interval and always lands the last one", async () => {
    await withHarness(async ({ store, calls, drain }) => {
      const receipt = ingest(store, 1);
      store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 600_000, maxConcurrentTasks: 2 });
      const interval = config.slack.ui.statusUpdateIntervalMs;
      store.openStatusMessage({
        operationId: receipt.operationId,
        taskId: receipt.taskId,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (view) => renderStatusMessage(view, { showProgress: true }),
        now,
      });
      await drain(now);
      const progress = new TurnProgress();
      progress.setTurn("turn-1");
      // 50 tool events 100 ms apart (5 s), delivery polled every 100 ms, then 5 s of quiet.
      for (let tick = 0; tick < 100; tick += 1) {
        const clock = at(tick * 100);
        if (tick < 50) {
          progress.add({ id: `a${tick}`, tone: "tool", kind: "tool.completed", summary: `Ran step ${tick}`, turnId: "turn-1" });
          store.updateStatusProgress({
            operationId: receipt.operationId,
            progress: progress.view(),
            now: clock,
          });
        }
        await drain(clock);
      }
      const updates = calls.filter((call) => call.method === "update");
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates.length).toBeLessThanOrEqual(4);
      const times = [calls[0]?.at ?? now, ...updates.map((call) => call.at)].map((time) => Date.parse(time));
      for (let index = 1; index < times.length; index += 1) {
        expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(interval);
      }
      const last = updates.at(-1);
      const section = last?.blocks[0];
      expect(section?.type === "section" ? section.text.text : "").toContain("Ran step 49");
      expect(last?.blocks).toContainEqual({ type: "context", elements: [{ type: "mrkdwn", text: "50 tool calls" }] });
    });
  });

  test("the global edit budget holds every minute to statusUpdatesPerMinute, counted at delivery", async () => {
    const budget = { ...config, slack: { ...config.slack, ui: { ...config.slack.ui, statusUpdatesPerMinute: 2 } } };
    await withHarness(async ({ store, calls, drain }) => {
      const operations = [1, 2, 3].map((index) => {
        const receipt = store.ingestSlackEvent({
          deliveryId: `delivery-${index}`,
          eventKey: `C1:3000.00000${index}`,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: `3000.00000${index}`,
          actorUserId: "U1",
          conversationType: "channel",
          profileId: "engineering",
          repositoryRoot: "/srv/repos/example",
          text: "request",
          receivedAt: now,
          sourceOrderKey: `3000.00000${index}`,
        });
        store.openStatusMessage({
          operationId: receipt.operationId,
          taskId: receipt.taskId,
          conversationId: "C1",
          threadTs: `3000.00000${index}`,
          message: (view) => renderStatusMessage(view, { showProgress: true }),
          now,
        });
        return receipt.operationId;
      });
      await drain(now);
      for (const operationId of operations) {
        store.updateStatusProgress({ operationId, progress: { plan: [], recent: ["Ran tests"], toolCount: 1 }, now: at(5_000) });
      }
      // The outbox was held up until 90 s: two edits go out then, the third a minute after them.
      await drain(at(90_000));
      await drain(at(149_999));
      await drain(at(150_000));
      expect(calls.filter((call) => call.method === "update").map((call) => call.at)).toEqual([at(90_000), at(90_000), at(150_000)]);
    }, budget);
  });

  test("a status message is edited at most once per interval, measured from actual delivery", async () => {
    await withHarness(async ({ store, calls, drain }) => {
      const receipt = ingest(store, 1);
      store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 600_000, maxConcurrentTasks: 2 });
      store.openStatusMessage({
        operationId: receipt.operationId,
        taskId: receipt.taskId,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (view) => renderStatusMessage(view, { showProgress: true }),
        now,
      });
      await drain(now);
      const update = (recent: string, clock: string) =>
        store.updateStatusProgress({ operationId: receipt.operationId, progress: { plan: [], recent: [recent], toolCount: 1 }, now: clock });
      const updates = () => calls.filter((call) => call.method === "update").map((call) => call.at);
      // Edit due at 2 s goes out late, at 90 s: the next waits until 92 s.
      update("first", at(1_000));
      await drain(at(90_000));
      update("second", at(90_100));
      await drain(at(91_999));
      expect(updates()).toEqual([at(90_000)]);
      await drain(at(92_000));
      expect(updates()).toEqual([at(90_000), at(92_000)]);
      // Claimed at 94 s but only delivered at 96 s: the next waits until 98 s.
      update("third", at(93_000));
      const statusEdits = { intervalMs: config.slack.ui.statusUpdateIntervalMs, perMinute: config.slack.ui.statusUpdatesPerMinute };
      const inflight = store.claimNextOutbox({ workerId: "slack-b", now: at(94_000), leaseMs: 30_000, statusEdits });
      if (inflight === null) throw new Error("third edit was not claimable");
      update("fourth", at(94_100));
      store.markOutboxDelivered({ outboxId: inflight.outboxId, workerId: "slack-b", slackMessageTs: "2000.000001", now: at(96_000) });
      await drain(at(97_999));
      expect(updates()).toEqual([at(90_000), at(92_000)]);
      await drain(at(98_000));
      expect(updates()).toEqual([at(90_000), at(92_000), at(98_000)]);
    });
  });

  test("terminal renders are sticky and progress after settling is ignored", async () => {
    await withHarness(async ({ store }) => {
      const receipt = ingest(store, 1);
      store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 600_000, maxConcurrentTasks: 2 });
      store.openStatusMessage({
        operationId: receipt.operationId,
        taskId: receipt.taskId,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (view) => renderStatusMessage(view, { showProgress: true }),
        now,
      });
      store.completeOperation({ operationId: receipt.operationId, workerId: "worker-a", resultSequence: 1, now: at(3_000) });
      expect(store.getStatusMessageView(receipt.operationId)).toMatchObject({ state: "done", settledAt: at(3_000) });
      const update = {
        operationId: receipt.operationId,
        progress: { plan: [], recent: ["late"], toolCount: 1 },
        now: at(4_000),
      };
      expect(store.updateStatusProgress(update)).toBe(false);
      // Re-opening (a replayed claim) re-attaches instead of posting a second message.
      expect(
        store.openStatusMessage({
          operationId: receipt.operationId,
          taskId: receipt.taskId,
          conversationId: "C1",
          threadTs: "1000.000001",
          message: (view) => renderStatusMessage(view, { showProgress: true }),
          now: at(5_000),
        }),
      ).toEqual({ kind: "reattached" });
      expect(store.getStatusMessageView(receipt.operationId)?.state).toBe("done");
    });
  });

  test("retention clears settled status progress and keeps live ones", async () => {
    await withHarness(async ({ store, path }) => {
      const views = [1, 2].map((index) => {
        const receipt = store.ingestSlackEvent({
          deliveryId: `delivery-${index}`,
          eventKey: `C1:4000.00000${index}`,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: `4000.00000${index}`,
          actorUserId: "U1",
          conversationType: "channel",
          profileId: "engineering",
          repositoryRoot: "/srv/repos/example",
          text: "request",
          receivedAt: now,
          sourceOrderKey: `4000.00000${index}`,
        });
        store.openStatusMessage({
          operationId: receipt.operationId,
          taskId: receipt.taskId,
          conversationId: "C1",
          threadTs: `4000.00000${index}`,
          message: (view) => renderStatusMessage(view, { showProgress: true }),
          now,
        });
        store.updateStatusProgress({
          operationId: receipt.operationId,
          progress: { plan: [{ step: "Fix bug", status: "inProgress" }], recent: ["Ran `rm secrets`"], toolCount: 1 },
          now,
        });
        return receipt;
      });
      const [settled, live] = views;
      if (settled === undefined || live === undefined) throw new Error("fixture missing");
      const claimed = store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 600_000, maxConcurrentTasks: 2 });
      expect(claimed?.operationId).toBe(settled.operationId);
      store.completeOperation({ operationId: settled.operationId, workerId: "worker-a", resultSequence: 1, now });
      const database = new Database(path, { strict: true });
      try {
        const result = pruneRetainedData(database, { policy: { messageDays: 1 }, now: at(2 * 86_400_000) });
        expect(result.statusRedacted).toBe(1);
        const rows = database
          .query<{ operation_id: string; view_json: string }, []>("SELECT operation_id, view_json FROM status_messages")
          .all();
        expect(rows.find((row) => row.operation_id === settled.operationId)?.view_json).toBe("{}");
        expect(rows.find((row) => row.operation_id === live.operationId)?.view_json).toContain("rm secrets");
      } finally {
        database.close();
      }
      expect(store.getStatusMessageView(settled.operationId)?.progress).toEqual({ plan: [], recent: [], toolCount: 0 });
    });
  });
});

describe("status message rendering", () => {
  const base: StatusMessageView = {
    operationId: "op-1",
    taskId: "task-1",
    state: "running",
    progress: {
      plan: [
        { step: "Read code", status: "completed" },
        { step: "Fix <!channel>", status: "inProgress" },
        { step: "Open PR", status: "pending" },
      ],
      recent: ["Ran `bun test` <@U9>"],
      toolCount: 3,
    },
    actorUserId: null,
    startedAt: now,
    settledAt: null,
  };

  test("a running turn shows its plan, tool lines and a Stop button naming the turn", () => {
    const message = renderStatusMessage(base, { showProgress: true });
    expect(message.text).toBe("Working on it…");
    const section = message.blocks?.[0];
    const text = section?.type === "section" ? section.text.text : "";
    expect(text).toContain(":white_check_mark: Read code");
    expect(text).toContain(":arrow_right: Fix");
    expect(text).toContain(":white_circle: Open PR");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U9>");
    expect(text).toContain("`Ran 'bun test'");
    expect(JSON.parse(stopValue(message.blocks ?? []))).toEqual({ taskId: "task-1", operationId: "op-1" });
  });

  test("every settled or waiting state renders without an actions block", () => {
    const states: Array<[StatusMessageView["state"], string]> = [
      ["waiting", "Waiting for your answer above"],
      ["stopping", "Stopping…"],
      ["done", "Done in 3m 12s"],
      ["stopped", "Stopped by <@U2>"],
      ["failed", "Failed: see the message below"],
      ["expired", "Expired waiting for an answer"],
    ];
    for (const [state, headline] of states) {
      const message = renderStatusMessage(
        { ...base, state, actorUserId: state === "stopped" ? "U2" : null, settledAt: at(192_000) },
        { showProgress: true },
      );
      expect(message.text).toBe(headline);
      expect(hasActions(message.blocks ?? [])).toBe(false);
    }
  });

  test("statusProgress=false keeps only the headline and the Stop button", () => {
    const message = renderStatusMessage(base, { showProgress: false });
    expect(message.blocks?.map((block) => block.type)).toEqual(["section", "actions"]);
    const section = message.blocks?.[0];
    expect(section?.type === "section" ? section.text.text : "").toBe("*Working on it…*");
  });
});

describe("turn progress", () => {
  test("keeps the current turn's plan, recent tool lines and problems; drops other turns", () => {
    const progress = new TurnProgress();
    progress.add({ id: "early", tone: "tool", kind: "tool.started", summary: "Ran ls started", turnId: "turn-2" });
    progress.add({ id: "old", tone: "tool", kind: "tool.completed", summary: "old turn", turnId: "turn-1" });
    expect(progress.view()).toEqual({ plan: [], recent: [], toolCount: 0 });
    progress.setTurn("turn-2");
    progress.add({ id: "done", tone: "tool", kind: "tool.completed", summary: "Ran ls", turnId: "turn-2" });
    progress.add({ id: "other", tone: "tool", kind: "tool.completed", summary: "elsewhere", turnId: "turn-3" });
    progress.add({ id: "bad", tone: "error", kind: "tool.failed", summary: "Edit failed", turnId: "turn-2" });
    progress.add({
      id: "plan",
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      turnId: "turn-2",
      plan: [{ step: "Fix", status: "inProgress" }],
    });
    progress.add({ id: "long", tone: "tool", kind: "tool.completed", summary: "x".repeat(500), turnId: "turn-2" });
    const view = progress.view();
    expect(view.plan).toEqual([{ step: "Fix", status: "inProgress" }]);
    expect(view.recent.slice(0, 2)).toEqual(["Ran ls", "Problem: Edit failed"]);
    expect(view.recent.at(-1)?.length).toBe(PROGRESS_LINE_CHARS);
    expect(view.toolCount).toBe(2);
  });

  test("a long turn keeps its plan and counts every tool once, however many activities it has", () => {
    const progress = new TurnProgress();
    progress.setTurn("turn-1");
    progress.add({
      id: "plan",
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      turnId: "turn-1",
      plan: [{ step: "Fix", status: "inProgress" }],
    });
    const tool = (index: number) =>
      ({ id: `t${index}`, tone: "tool", kind: "tool.completed", summary: `Ran step ${index}`, turnId: "turn-1" }) as const;
    for (let index = 0; index < 405; index += 1) progress.add(tool(index));
    // A snapshot replays early activities that were already evicted.
    for (let index = 0; index < 10; index += 1) progress.add(tool(index));
    const view = progress.view();
    expect(view.plan).toEqual([{ step: "Fix", status: "inProgress" }]);
    expect(view.toolCount).toBe(405);
    expect(view.recent.at(-1)).toBe("Ran step 404");
  });

  test("the v1 stream adapter carries a plan update's steps but never other payloads", () => {
    const item = normalizeV1Item({
      kind: "event",
      event: {
        sequence: 5,
        type: "thread.activity-appended",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "a1",
            tone: "info",
            kind: "turn.plan.updated",
            summary: "Plan updated",
            turnId: "turn-1",
            payload: { plan: [{ step: "Ship it", status: "pending" }], secret: "nope" },
          },
        },
      },
    } as never);
    expect(item).toMatchObject({ kind: "event", activity: { plan: [{ step: "Ship it", status: "pending" }] } });
    expect(JSON.stringify(item)).not.toContain("nope");
  });
});
