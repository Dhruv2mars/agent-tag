import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, type T3CoordinatorGateway } from "../src/coordinator.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3ThreadSnapshot } from "../src/t3/gateway.ts";
import {
  ThreadWatcher,
  type NormalizedThreadItem,
  type ThreadEventSource,
  type ThreadWakeReason,
  type ThreadWatch,
  type ThreadWatchSource,
} from "../src/t3/watcher.ts";

const start = "2026-10-09T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
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
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 2, stalledTurn: { timeoutSeconds: 120, retryDelaySeconds: 10, maxAttempts: 1 } },
});

function snapshot(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly state: "running" | "completed";
  readonly snapshotSequence?: number;
}): T3ThreadSnapshot {
  const completed = input.state === "completed";
  return {
    snapshotSequence: input.snapshotSequence ?? 9,
    thread: {
      id: input.threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "agent-tag/task-1",
      worktreePath: "/tmp/worktree",
      latestTurn: {
        turnId: "turn-1",
        state: input.state,
        requestedAt: start,
        startedAt: start,
        completedAt: completed ? start : null,
        assistantMessageId: completed ? "assistant-1" : null,
      },
      messages: [
        { id: input.messageId, role: "user", text: "request", turnId: null, streaming: false, createdAt: start, updatedAt: start },
        ...(completed
          ? [{ id: "assistant-1", role: "assistant" as const, text: "done", turnId: "turn-1", streaming: false, createdAt: start, updatedAt: start }]
          : []),
      ],
      activities: [],
      session: {
        threadId: input.threadId,
        status: completed ? "ready" : "running",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: completed ? null : "turn-1",
        lastError: null,
        updatedAt: start,
      },
    },
  };
}

/** A simulated clock and a watch whose events happen at fixed simulated times. */
class ScriptedWatch implements ThreadWatch {
  readonly timeouts: number[] = [];
  released = 0;
  lastSequence = 0;
  readonly #clock: { now: number };
  readonly #events: Array<{ at: number; sequence: number; wakes?: boolean; reason?: ThreadWakeReason }>;

  constructor(clock: { now: number }, events: Array<{ at: number; sequence: number; wakes?: boolean; reason?: ThreadWakeReason }>) {
    this.#clock = clock;
    this.#events = [...events];
  }

  async next(timeoutMs: number): Promise<ThreadWakeReason> {
    this.timeouts.push(timeoutMs);
    const deadline = this.#clock.now + timeoutMs;
    while (this.#events.length > 0 && (this.#events[0]?.at ?? Infinity) <= deadline) {
      const event = this.#events.shift();
      if (event === undefined) break;
      this.#clock.now = Math.max(this.#clock.now, event.at);
      this.lastSequence = event.sequence;
      if (event.wakes !== false) return event.reason ?? "event";
    }
    this.#clock.now = deadline;
    return "timeout";
  }

  onItem(): () => void {
    return () => undefined;
  }

  release(): void {
    this.released += 1;
  }
}

async function withStore(run: (store: AgentTagStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-watch-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    store.ingestSlackEvent({
      deliveryId: "delivery-1",
      eventKey: "C1:1000.000001",
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
      text: "request",
      receivedAt: start,
      sourceOrderKey: "1000.000001",
    });
    await run(store);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-watch-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

/** A T3 whose turn completes `turnMs` after dispatch on the simulated clock. */
function simulatedT3(clock: { now: number }, turnMs: number, snapshotSequence: (now: number) => number = () => 9) {
  const state = { threadId: "", messageId: "", dispatchedAt: 0, fetches: 0, receipt: 42 };
  const t3: T3CoordinatorGateway = {
    dispatch: async (command) => {
      if (command.type === "thread.turn.start") {
        state.threadId = command.threadId;
        state.messageId = command.message.messageId;
        state.dispatchedAt = clock.now;
        return { sequence: state.receipt };
      }
      return { sequence: 1 };
    },
    fetchThread: async () => {
      state.fetches += 1;
      const done = clock.now - state.dispatchedAt >= turnMs;
      return snapshot({
        threadId: state.threadId,
        messageId: state.messageId,
        state: done ? "completed" : "running",
        snapshotSequence: snapshotSequence(clock.now),
      });
    },
  };
  return { t3, state };
}

describe("coordinator wait loop with a thread watcher", () => {
  test("wakes on events and safety polls instead of sleeping, and cuts snapshot reads (Done 8)", async () => {
    const turnMs = 60_000;
    const events = [
      { at: 5_000, sequence: 50 },
      { at: 20_000, sequence: 60 },
      // Streamed text between: advances the sequence but does not wake.
      { at: 30_000, sequence: 70, wakes: false },
      { at: turnMs, sequence: 80 },
    ];

    let polledFetches = 0;
    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      const { t3, state } = simulatedT3(clock, turnMs);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        workerId: "worker-a",
        now: () => new Date(clock.now),
        sleep: async (milliseconds) => {
          clock.now += milliseconds;
        },
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
      polledFetches = state.fetches;
    });

    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      const watch = new ScriptedWatch(clock, events.map((event) => ({ ...event, at: clock.now + event.at })));
      // The read model is current with the stream.
      const { t3, state } = simulatedT3(clock, turnMs, () => watch.lastSequence);
      const sleeps: number[] = [];
      const acquired: Array<{ threadId: string; afterSequence: number | undefined }> = [];
      const watcher: ThreadWatchSource = {
        acquire: (threadId, options) => {
          acquired.push({ threadId, afterSequence: options?.afterSequence });
          return watch;
        },
      };
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        watcher,
        workerId: "worker-a",
        now: () => new Date(clock.now),
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock.now += milliseconds;
        },
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
      expect(clock.now - Date.parse(start)).toBe(turnMs);
      expect(acquired).toEqual([{ threadId: state.threadId, afterSequence: state.receipt }]);
      expect(sleeps).toEqual([]);
      // Fetches: the first read, then one per wake (5s, 20s, 60s) and per safety poll (35s, 50s).
      expect(state.fetches).toBe(6);
      expect(watch.timeouts.every((timeout) => timeout <= config.t3.watch.safetyPollMs)).toBe(true);
      expect(watch.released).toBe(1);
    });

    // The one-shot 500 ms poll reads the snapshot ~120 times for the same minute.
    expect(polledFetches).toBeGreaterThanOrEqual(120);
  });

  test("polls at pollMs while the snapshot lags an event the watch already saw", async () => {
    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      // The read model catches up 1.2 s after dispatch.
      const caughtUpAt = clock.now + 1_200;
      const { t3, state } = simulatedT3(clock, 5_000, (now) => (now >= caughtUpAt ? 30 : 9));
      const watch = new ScriptedWatch(clock, [{ at: clock.now + 5_000, sequence: 31 }]);
      watch.lastSequence = 20;
      const sleeps: number[] = [];
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        watcher: { acquire: () => watch },
        workerId: "worker-a",
        now: () => new Date(clock.now),
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock.now += milliseconds;
        },
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
      expect(sleeps).toEqual([500, 500, 500]);
      expect(watch.timeouts).toHaveLength(1);
      expect(state.fetches).toBe(5);
    });
  });

  test("caps each wait at half the lease and at the stall deadline", async () => {
    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      const { t3 } = simulatedT3(clock, 10 * 60_000);
      const watch = new ScriptedWatch(clock, []);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        watcher: { acquire: () => watch },
        safetyPollMs: 60_000,
        leaseMs: 20_000,
        stallMs: 25_000,
        workerId: "worker-a",
        now: () => new Date(clock.now),
        sleep: async () => {
          throw new Error("must not sleep with a watch");
        },
      });
      expect(await coordinator.processNext()).toMatchObject({ errorCode: "T3TurnStalled" });
      // 10 s (half the lease), 10 s, then the 5 s left in the stall window.
      expect(watch.timeouts).toEqual([10_000, 10_000, 5_001]);
      expect(watch.released).toBe(1);
    });
  });

  test("events the stream saw keep a turn with an unchanged snapshot from stalling", async () => {
    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      const turnMs = 5 * 60_000;
      // Only progress-only events for five minutes, every 30 s: tool output, no snapshot change.
      const events = Array.from({ length: 10 }, (_, index) => ({
        at: clock.now + (index + 1) * 30_000,
        sequence: 100 + index,
        wakes: false,
      }));
      const watch = new ScriptedWatch(clock, events);
      const { t3 } = simulatedT3(clock, turnMs, () => watch.lastSequence);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        watcher: { acquire: () => watch },
        workerId: "worker-a",
        now: () => new Date(clock.now),
        sleep: async () => {
          throw new Error("must not sleep with a current snapshot");
        },
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
      expect(clock.now - Date.parse(start)).toBeGreaterThan(config.limits.stalledTurn.timeoutSeconds * 1_000);
    });
  });

  test("a stream that dies mid-turn still settles through the safety poll (Done 11)", async () => {
    await withStore(async (store) => {
      let threadId = "";
      let messageId = "";
      let fetches = 0;
      let subscribes = 0;
      // The stream delivers one event, then every resubscribe fails: T3 stays reachable over HTTP only.
      const source: ThreadEventSource = {
        protocol: 1,
        subscribe: async (input) => {
          subscribes += 1;
          if (subscribes > 1) throw new Error("stream unavailable");
          const item: NormalizedThreadItem = { kind: "event", sequence: 43, type: "thread.turn-start-requested", turnId: null, progressOnly: false };
          input.onItem(item);
          throw new Error("socket dropped");
        },
      };
      const watcher = new ThreadWatcher({ source, coalesceMs: 1, lingerMs: 0 });
      const startedAt = Date.now();
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3: {
          dispatch: async (command) => {
            if (command.type === "thread.turn.start") {
              threadId = command.threadId;
              messageId = command.message.messageId;
              return { sequence: 42 };
            }
            return { sequence: 1 };
          },
          fetchThread: async () => {
            fetches += 1;
            // The turn finishes after the stream is gone; no event announces it.
            const state = Date.now() - startedAt >= 400 ? "completed" : "running";
            return snapshot({ threadId, messageId, state, snapshotSequence: 50 });
          },
        },
        watcher,
        safetyPollMs: 40,
        workerId: "worker-a",
      });
      try {
        expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
        expect(subscribes).toBeGreaterThan(1);
        // Safety polls every 40 ms, not the 500 ms fallback and not a busy loop.
        expect(fetches).toBeGreaterThanOrEqual(3);
        expect(fetches).toBeLessThan(25);
      } finally {
        await watcher.close();
      }
    });
  });

  test("releases the watch when the claim is aborted", async () => {
    await withStore(async (store) => {
      const clock = { now: Date.parse(start) };
      const { t3 } = simulatedT3(clock, 10 * 60_000);
      const controller = new AbortController();
      let released = 0;
      const watch: ThreadWatch = {
        lastSequence: 0,
        next: (_timeoutMs, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve("timeout"), { once: true });
            controller.abort();
          }),
        onItem: () => () => undefined,
        release: () => {
          released += 1;
        },
      };
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        watcher: { acquire: () => watch },
        workerId: "worker-a",
        now: () => new Date(clock.now),
      });
      expect(await coordinator.processNext(controller.signal)).toMatchObject({ kind: "released" });
      expect(released).toBe(1);
    });
  });
});
