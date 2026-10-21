import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema, type AgentTagConfig } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import { refreshRenderers } from "../src/slack/bridge.ts";
import { finalReplyChunks, footerText, replyFooter, turnFilesChanged } from "../src/slack/footer.ts";
import { deliverNextSlackOutbox } from "../src/slack/outbox.ts";
import { SLACK_SECTION_TEXT_LIMIT, splitForSlack } from "../src/slack/render.ts";
import { renderStatusMessage } from "../src/slack/status.ts";
import { slackBlockSchema } from "../src/store/schema.ts";
import { AgentTagStore, type SlackOutboxPayload, type StatusMessageView } from "../src/store/store.ts";
import { threadSnapshotSchema, type T3ThreadSnapshot } from "../src/t3/gateway.ts";
import type { ThreadWakeReason, ThreadWatch } from "../src/t3/watcher.ts";

const now = "2026-09-21T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const baseConfig = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      // The footer must name the model T3 ran, not this configured default.
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
};
const config = agentTagConfigSchema.parse(baseConfig);

type Block = NonNullable<SlackOutboxPayload["blocks"]>[number];
interface Post {
  readonly text: string;
  readonly blocks: ReadonlyArray<Block>;
}

function snapshot(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly userMessageId: string | undefined;
  readonly text: string;
  readonly checkpoints?: T3ThreadSnapshot["thread"]["checkpoints"];
}): T3ThreadSnapshot {
  return {
    snapshotSequence: 9,
    thread: {
      id: input.threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId: input.turnId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: `assistant-${input.turnId}`,
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
        {
          id: `assistant-${input.turnId}`,
          role: "assistant" as const,
          text: input.text,
          turnId: input.turnId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [],
      ...(input.checkpoints === undefined ? {} : { checkpoints: input.checkpoints }),
      session: {
        threadId: input.threadId,
        status: "ready",
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

/** Runs one turn that takes 3m 12s through the real coordinator, store and outbox delivery. */
async function runTurn(input: {
  readonly config: AgentTagConfig;
  readonly text: string;
  readonly checkpoints?: T3ThreadSnapshot["thread"]["checkpoints"];
  /** Checkpoints per snapshot read (1-based); overrides `checkpoints`. */
  readonly checkpointsAt?: (fetch: number) => T3ThreadSnapshot["thread"]["checkpoints"];
  readonly watch?: ThreadWatch;
}): Promise<{ posts: Post[]; status: StatusMessageView | null; fetches: number }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-footer-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    let clock = now;
    let threadId = "not-dispatched";
    let messageId: string | undefined;
    let fetches = 0;
    const coordinator = new AgentTagCoordinator({
      config: input.config,
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
          clock = at(192_000);
          fetches += 1;
          const checkpoints = input.checkpointsAt?.(fetches) ?? input.checkpoints;
          return snapshot({
            threadId,
            turnId: "turn-1",
            userMessageId: messageId,
            text: input.text,
            ...(checkpoints === undefined ? {} : { checkpoints }),
          });
        },
      },
      ...(input.watch === undefined ? {} : { watcher: { acquire: () => input.watch as ThreadWatch } }),
      workerId: "worker-a",
      // The fake clock jumps 3m 12s in one poll; the lease must outlive that jump.
      leaseMs: 600_000,
      now: () => new Date(clock),
      sleep: async () => {},
    });
    const receipt = store.ingestSlackEvent({
      deliveryId: "delivery-1",
      eventKey: "C1:1000.000001",
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
      text: "fix the bug",
      receivedAt: now,
      sourceOrderKey: "1000.000001",
    });
    expect((await coordinator.processNext()).kind).toBe("completed");
    const posts: Post[] = [];
    let posted = 0;
    for (;;) {
      const outcome = await deliverNextSlackOutbox({
        config: input.config,
        store,
        workerId: "slack-a",
        now: () => clock,
        refreshRenderers: refreshRenderers(store, input.config),
        postMessage: async (message) => {
          posted += 1;
          posts.push({ text: message.text, blocks: message.blocks ?? [] });
          return { ts: `2000.${String(posted).padStart(6, "0")}` };
        },
        updateMessage: async () => ({ ok: true }),
      });
      if (outcome.kind === "idle") break;
      expect(outcome.kind).toBe("delivered");
    }
    return {
      posts: posts.filter((post) => post.text !== "Working on it…"),
      status: store.getStatusMessageView(receipt.operationId),
      fetches,
    };
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-footer-`)) throw new Error(`unexpected fixture path ${directory}`);
    await rm(directory, { recursive: true });
  }
}

const files = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts` }));

describe("final reply footer (F4)", () => {
  test("the last chunk carries the snapshot's model, instance and elapsed time; the text keeps the answer", async () => {
    const { posts, status } = await runTurn({
      config,
      text: "Fixed the **bug**.",
      checkpoints: [{ turnId: "turn-1", status: "ready", files: files(3) }],
    });
    expect(posts).toEqual([
      {
        text: "Fixed the *bug*.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Fixed the *bug*." } },
          { type: "context", elements: [{ type: "plain_text", text: "claude-opus-5-5 · claudeAgent · 3m 12s" }] },
        ],
      },
    ]);
    // Completion collapse: the status message ends as one line with the turn's diff size.
    expect(status).toMatchObject({ state: "done", progress: { filesChanged: 3 } });
    expect(renderStatusMessage(status as StatusMessageView, { showProgress: true }).text).toBe("Done in 3m 12s · 3 files changed");
  });

  test("a long reply keeps earlier chunks text-only and footers only the last, which fits one section", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}: ${"word ".repeat(40)}`.trim());
    const { posts } = await runTurn({ config, text: paragraphs.join("\n\n") });
    expect(posts.length).toBeGreaterThan(2);
    for (const post of posts.slice(0, -1)) expect(post.blocks).toEqual([]);
    const last = posts.at(-1);
    const section = last?.blocks[0];
    expect(section?.type === "section" ? section.text.text : null).toBe(last?.text ?? "");
    expect((last?.text.length ?? 0) <= SLACK_SECTION_TEXT_LIMIT).toBe(true);
    expect(last?.blocks[1]).toEqual({ type: "context", elements: [{ type: "plain_text", text: "claude-opus-5-5 · claudeAgent · 3m 12s" }] });
    for (let index = 0; index < 40; index += 1) {
      expect(posts.some((post) => post.text.includes(`Paragraph ${index}:`))).toBe(true);
    }
  });

  test("footer none posts the reply as plain text, split as before", async () => {
    const plain = agentTagConfigSchema.parse({ ...baseConfig, slack: { ...baseConfig.slack, ui: { footer: "none" } } });
    const { posts, status } = await runTurn({ config: plain, text: "Fixed it." });
    expect(posts).toEqual([{ text: "Fixed it.", blocks: [] }]);
    // No checkpoint recorded: the status keeps the plain "Done in" line.
    expect(status?.progress.filesChanged).toBeUndefined();
    expect(renderStatusMessage(status as StatusMessageView, { showProgress: true }).text).toBe("Done in 3m 12s");
  });
});

/** A watch that answers every wait with `reason` and records the timeouts asked for. */
function fakeWatch(reason: ThreadWakeReason): ThreadWatch & { readonly timeouts: number[] } {
  const timeouts: number[] = [];
  return {
    timeouts,
    lastSequence: 0,
    next: async (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      return reason;
    },
    onItem: () => () => undefined,
    release: () => undefined,
  };
}

describe("files changed on completion (F4)", () => {
  test("waits for the diff T3 records just after the turn completes, then counts its files", async () => {
    const watch = fakeWatch("event");
    const { posts, status, fetches } = await runTurn({
      config,
      text: "Done.",
      // Live 0.0.45: the first completed snapshot has no checkpoint; it lands about 200 ms later.
      checkpointsAt: (fetch) => (fetch === 1 ? [] : [{ turnId: "turn-1", status: "ready", files: files(2) }]),
      watch,
    });
    expect(fetches).toBe(2);
    expect(watch.timeouts).toEqual([1_000]);
    expect(status?.progress.filesChanged).toBe(2);
    expect(posts).toHaveLength(1);
  });

  test("settles without a count after a bounded wait when no diff arrives", async () => {
    const watch = fakeWatch("timeout");
    const { posts, status, fetches } = await runTurn({ config, text: "Done.", watch });
    expect(fetches).toBe(4);
    expect(watch.timeouts).toEqual([1_000, 1_000, 1_000]);
    expect(status).toMatchObject({ state: "done" });
    expect(status?.progress.filesChanged).toBeUndefined();
    expect(posts.map((post) => post.text)).toEqual(["Done."]);
  });

  test("a diff of another turn is not this turn's", async () => {
    const { status } = await runTurn({
      config,
      text: "Done.",
      checkpoints: [{ turnId: "turn-0", status: "ready", files: files(5) }],
    });
    expect(status?.progress.filesChanged).toBeUndefined();
  });
});

describe("footer helpers", () => {
  const completed = snapshot({ threadId: "thread-1", turnId: "turn-2", userMessageId: undefined, text: "ok" });

  test("footer text keeps provider ids literal and drops an unknown elapsed time", () => {
    // plain_text: Slack neither formats nor resolves mentions in it, so ids need no escaping.
    expect(footerText({ model: "my_model*<@U1>", instanceId: "codex_work", elapsedMs: 45_000 })).toBe("my_model*<@U1> · codex_work · 45s");
    expect(footerText({ model: "gpt-5.6-sol", instanceId: "codex", elapsedMs: null })).toBe("gpt-5.6-sol · codex");
  });

  test("elapsed time runs from the status message, else from T3's turn start", () => {
    const end = new Date(at(65_000));
    expect(replyFooter(completed, at(5_000), end)).toEqual({ model: "claude-opus-5-5", instanceId: "claudeAgent", elapsedMs: 60_000 });
    expect(replyFooter(completed, undefined, end).elapsedMs).toBe(65_000);
  });

  test("files changed come only from a ready checkpoint of the latest turn", () => {
    const withCheckpoints = (checkpoints: T3ThreadSnapshot["thread"]["checkpoints"]) => ({
      ...completed,
      thread: { ...completed.thread, checkpoints },
    });
    expect(turnFilesChanged(completed)).toEqual({});
    expect(turnFilesChanged(withCheckpoints([{ turnId: "turn-2", status: "ready", files: files(2) }]))).toEqual({ filesChanged: 2 });
    expect(turnFilesChanged(withCheckpoints([{ turnId: "turn-2", status: "ready", files: [] }]))).toEqual({ filesChanged: 0 });
    expect(turnFilesChanged(withCheckpoints([{ turnId: "turn-1", status: "ready", files: files(4) }]))).toEqual({});
    expect(turnFilesChanged(withCheckpoints([{ turnId: "turn-2", status: "missing", files: [] }]))).toEqual({});
  });

  test("a checkpoint shape the schema does not know drops the count, not the snapshot", () => {
    const parsed = threadSnapshotSchema.parse({
      ...completed,
      thread: { ...completed.thread, checkpoints: [{ turnId: "turn-2", status: "archived", files: [{}] }] },
    });
    expect(parsed.thread.checkpoints).toBeUndefined();
    expect(parsed.thread.latestTurn?.state).toBe("completed");
  });

  test("chunks without a footer match splitForSlack; with one, every block passes the outbox schema", () => {
    const long = Array.from({ length: 30 }, (_, index) => `Line ${index} ${"x".repeat(200)}`).join("\n");
    expect(finalReplyChunks(long, null)).toEqual(splitForSlack(long));
    const chunks = finalReplyChunks(long, { model: "gpt-5.6-sol", instanceId: "codex", elapsedMs: 1_000 });
    const last = chunks.at(-1);
    expect(typeof last).toBe("object");
    for (const block of typeof last === "object" ? last.blocks ?? [] : []) expect(slackBlockSchema.safeParse(block).success).toBe(true);
    expect(finalReplyChunks(" ", { model: "m", instanceId: "i", elapsedMs: 0 })).toEqual([" "]);
  });

  test("a done status says how many files changed, singular or plural, and nothing for zero", () => {
    const view: StatusMessageView = {
      operationId: "op-1",
      taskId: "task-1",
      state: "done",
      progress: { plan: [], recent: [], toolCount: 0, filesChanged: 1 },
      actorUserId: null,
      startedAt: now,
      settledAt: at(12_000),
    };
    expect(renderStatusMessage(view, { showProgress: false }).text).toBe("Done in 12s · 1 file changed");
    expect(renderStatusMessage({ ...view, progress: { ...view.progress, filesChanged: 0 } }, { showProgress: true }).text).toBe("Done in 12s");
  });
});
