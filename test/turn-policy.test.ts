// Progress-based stall policy, the approval wake-up race, and interaction expiry (B3, B5, B7).
// Every test drives the coordinator with a fake clock: `sleep` advances time instead of waiting.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema, type AgentTagConfig } from "../src/config.ts";
import { AgentTagCoordinator, t3ProgressMarker } from "../src/coordinator.ts";
import { InteractionWorker } from "../src/interaction-worker.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";

const start = "2026-09-21T00:00:00.000Z";
const startMs = Date.parse(start);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
};

function configWith(limits: Record<string, unknown> = {}): AgentTagConfig {
  return agentTagConfigSchema.parse({ ...baseConfig, limits: { maxConcurrentTasks: 2, ...limits } });
}

interface SnapshotInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly sequence?: number;
  readonly activityCount?: number;
  readonly state?: "running" | "completed";
  readonly text?: string;
  readonly approvals?: readonly string[];
  readonly resolved?: readonly string[];
}

function snapshot(input: SnapshotInput): T3ThreadSnapshot {
  const state = input.state ?? "running";
  const activities: T3ThreadSnapshot["thread"]["activities"] = [];
  for (let index = 0; index < (input.activityCount ?? 0); index += 1) {
    activities.push({
      id: `tool-${index}`,
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran a tool",
      payload: {},
      turnId: "turn-1",
      createdAt: start,
    });
  }
  for (const requestId of input.approvals ?? []) {
    activities.push({
      id: `requested-${requestId}`,
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: { requestId, requestKind: "command", detail: "run tests" },
      turnId: "turn-1",
      createdAt: start,
    });
  }
  for (const requestId of input.resolved ?? []) {
    activities.push({
      id: `resolved-${requestId}`,
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      payload: { requestId },
      turnId: "turn-1",
      createdAt: start,
    });
  }
  return {
    snapshotSequence: input.sequence ?? 1,
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
        state,
        requestedAt: start,
        startedAt: start,
        completedAt: state === "completed" ? start : null,
        assistantMessageId: state === "completed" ? "assistant-1" : null,
      },
      messages: [
        {
          id: input.messageId,
          role: "user",
          text: "fixture request",
          turnId: null,
          streaming: false,
          createdAt: start,
          updatedAt: start,
        },
        ...(state === "completed"
          ? [{
              id: "assistant-1",
              role: "assistant" as const,
              text: input.text ?? "done",
              turnId: "turn-1",
              streaming: false,
              createdAt: start,
              updatedAt: start,
            }]
          : []),
      ],
      activities,
      session: null,
    },
  };
}

interface Harness {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly commands: T3Command[];
  readonly clock: { ms: number };
  readonly turn: { threadId: string; messageId: string };
}

async function withHarness(prefix: string, run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `agent-tag-${prefix}-`));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run({
      store,
      path,
      commands: [],
      clock: { ms: startMs },
      turn: { threadId: "not-dispatched", messageId: "not-dispatched" },
    });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-${prefix}-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function coordinatorFor(
  harness: Harness,
  config: AgentTagConfig,
  fetchThread: () => Promise<T3ThreadSnapshot> | T3ThreadSnapshot,
  options: { readonly pollMs?: number; readonly workerId?: string; readonly onSleep?: () => void } = {},
): AgentTagCoordinator {
  return new AgentTagCoordinator({
    config,
    store: harness.store,
    t3: {
      dispatch: async (command) => {
        harness.commands.push(command);
        if (command.type === "thread.turn.start") {
          harness.turn.threadId = command.threadId;
          harness.turn.messageId = command.message.messageId;
        }
        return { sequence: harness.commands.length };
      },
      fetchThread: async () => fetchThread(),
    },
    workerId: options.workerId ?? "worker-a",
    pollMs: options.pollMs ?? 10_000,
    now: () => new Date(harness.clock.ms),
    sleep: async (milliseconds) => {
      harness.clock.ms += milliseconds;
      options.onSleep?.();
    },
  });
}

function ingest(store: AgentTagStore, index: number, text = `request ${index}`) {
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
    text,
    receivedAt: start,
    sourceOrderKey: `1000.00000${index}`,
  });
}

function drainOutboxTexts(store: AgentTagStore, at: number): string[] {
  const texts: string[] = [];
  const now = new Date(at).toISOString();
  for (;;) {
    const message = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
    if (message === null) return texts;
    texts.push(message.payload.text);
    store.markOutboxDelivered({
      outboxId: message.outboxId,
      workerId: "slack-a",
      slackMessageTs: `1000.${String(texts.length).padStart(6, "0")}`,
      now,
    });
  }
}

function readOperation(path: string, operationId: string) {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database
      .query<{
        status: string;
        attempts: number;
        blocked_until: string | null;
        last_error_code: string | null;
        turn_active_ms: number;
      }, [string]>(
        "SELECT status, attempts, blocked_until, last_error_code, turn_active_ms FROM operations WHERE operation_id = ?",
      )
      .get(operationId);
  } finally {
    database.close();
  }
}

function readInteractions(path: string) {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database
      .query<{
        interaction_id: string;
        kind: string;
        request_id: string;
        state: string;
        last_error_code: string | null;
      }, []>("SELECT interaction_id, kind, request_id, state, last_error_code FROM interactions ORDER BY created_at, kind")
      .all();
  } finally {
    database.close();
  }
}

describe("progress-based stall policy (B3)", () => {
  test("a 2-hour turn that keeps advancing completes and posts its result", async () => {
    await withHarness("turn-long", async (harness) => {
      const config = configWith();
      expect(config.limits.stalledTurn.timeoutSeconds).toBe(300);
      // Only the activity list grows (one tool call every four minutes); the sequence never moves.
      const coordinator = coordinatorFor(harness, config, () => {
        const elapsed = harness.clock.ms - startMs;
        return elapsed < 2 * HOUR
          ? snapshot({ ...harness.turn, activityCount: Math.floor(elapsed / (4 * MINUTE)) })
          : snapshot({ ...harness.turn, state: "completed", text: "long-result" });
      });
      const receipt = ingest(harness.store, 1);

      expect(await coordinator.processNext()).toMatchObject({ kind: "completed", operationId: receipt.operationId });
      expect(harness.clock.ms - startMs).toBeGreaterThanOrEqual(2 * HOUR);
      expect(drainOutboxTexts(harness.store, harness.clock.ms)).toEqual([
        "Agent Tag is working on this request.",
        "long-result",
      ]);
      const operation = readOperation(harness.path, receipt.operationId);
      expect(operation).toMatchObject({ status: "succeeded", attempts: 1 });
      // Active time was persisted on lease renewal, at most one renewal interval behind.
      expect(operation?.turn_active_ms).toBeGreaterThan(2 * HOUR - 30_000);
    });
  });

  test("a turn stalls only after N seconds without progress, measured from its last progress", async () => {
    await withHarness("turn-silent", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 120, retryDelaySeconds: 10, maxAttempts: 1 },
      });
      let activityCount = 0;
      let lastProgressMs = startMs;
      const coordinator = coordinatorFor(harness, config, () => {
        if (harness.clock.ms - startMs < 30 * MINUTE) {
          activityCount += 1;
          lastProgressMs = harness.clock.ms;
        }
        return snapshot({ ...harness.turn, activityCount });
      });
      const receipt = ingest(harness.store, 1);

      expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnStalled" });
      // 30 minutes of progress did not count; the stall fired one poll after 120 s of silence.
      expect(lastProgressMs - startMs).toBeGreaterThan(29 * MINUTE);
      const silentFor = harness.clock.ms - lastProgressMs;
      expect(silentFor).toBeGreaterThan(120_000);
      expect(silentFor).toBeLessThanOrEqual(120_000 + 10_000);
      expect(readOperation(harness.path, receipt.operationId)?.last_error_code).toBe("T3TurnStalled");
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toContain("no progress for 2 minutes");
    });
  });

  test("a stalled turn is retried, and progress on the retry lets it complete", async () => {
    await withHarness("turn-retry", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 60, retryDelaySeconds: 30, maxAttempts: 3 },
      });
      let resumeAt = Number.POSITIVE_INFINITY;
      const coordinator = coordinatorFor(harness, config, () =>
        harness.clock.ms < resumeAt
          ? snapshot({ ...harness.turn })
          : snapshot({ ...harness.turn, state: "completed", text: "after-retry" }));
      ingest(harness.store, 1);

      expect(await coordinator.processNext()).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnStalled" });
      harness.clock.ms += 30_000;
      resumeAt = harness.clock.ms + 20_000;
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toBe("after-retry");
    });
  });

  test("the absolute ceiling counts active time across restarts and interrupts the turn", async () => {
    await withHarness("turn-ceiling", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 300, retryDelaySeconds: 30, maxAttempts: 5, maxTurnSeconds: 3_600 },
      });
      let activityCount = 0;
      const controller = new AbortController();
      const advancing = () => snapshot({ ...harness.turn, activityCount: ++activityCount });
      const first = coordinatorFor(harness, config, advancing, {
        onSleep: () => {
          if (harness.clock.ms - startMs >= 40 * MINUTE) controller.abort();
        },
      });
      const receipt = ingest(harness.store, 1);

      // A service restart after 40 minutes releases the lease without counting an attempt.
      expect(await first.processNext(controller.signal)).toMatchObject({ kind: "released" });
      const restartedAt = harness.clock.ms;
      const second = coordinatorFor(harness, config, advancing, { workerId: "worker-b" });
      expect(await second.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnCeiling" });
      // Only the remaining ~20 minutes ran after the restart (renewal granularity is 15 s).
      const secondRun = harness.clock.ms - restartedAt;
      expect(secondRun).toBeGreaterThan(19 * MINUTE);
      expect(secondRun).toBeLessThan(21 * MINUTE);
      expect(readOperation(harness.path, receipt.operationId)).toMatchObject({
        status: "failed",
        last_error_code: "T3TurnCeiling",
      });
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toContain("configured limit of 1 hour");

      const interrupts: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: { dispatch: async (command) => (interrupts.push(command), { sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(interrupts).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);
    });
  });

  test("short stalled attempts that never renew their lease still add up to the ceiling", async () => {
    await withHarness("turn-ceiling-retries", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 10, retryDelaySeconds: 30, maxAttempts: 10, maxTurnSeconds: 60 },
      });
      // Each attempt stalls after ~12 s, before the first lease renewal at 15 s.
      const coordinator = coordinatorFor(harness, config, () => snapshot({ ...harness.turn }), { pollMs: 6_000 });
      const receipt = ingest(harness.store, 1);

      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const outcome = await coordinator.processNext();
        outcomes.push(outcome.kind === "failed" || outcome.kind === "retry-scheduled" ? outcome.errorCode : outcome.kind);
        if (outcome.kind !== "retry-scheduled") break;
        expect(readOperation(harness.path, receipt.operationId)?.turn_active_ms).toBe(12_000 * outcomes.length);
        harness.clock.ms += 30_000;
      }
      expect(outcomes.at(-1)).toBe("T3TurnCeiling");
      expect(outcomes.length).toBeLessThan(10);
      expect(readOperation(harness.path, receipt.operationId)).toMatchObject({
        status: "failed",
        last_error_code: "T3TurnCeiling",
      });
    });
  });

  test("released claims persist their active time, so repeated short shutdowns cannot dodge the ceiling", async () => {
    await withHarness("turn-ceiling-releases", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 60, retryDelaySeconds: 30, maxAttempts: 5, maxTurnSeconds: 60 },
      });
      let activityCount = 0;
      const advancing = () => snapshot({ ...harness.turn, activityCount: ++activityCount });
      const receipt = ingest(harness.store, 1);

      for (let restart = 1; restart <= 6; restart += 1) {
        const controller = new AbortController();
        const claimStartedAt = harness.clock.ms;
        const coordinator = coordinatorFor(harness, config, advancing, {
          workerId: `worker-${restart}`,
          onSleep: () => {
            if (harness.clock.ms - claimStartedAt >= 10_000) controller.abort();
          },
        });
        expect(await coordinator.processNext(controller.signal)).toMatchObject({ kind: "released" });
        expect(readOperation(harness.path, receipt.operationId)?.turn_active_ms).toBe(10_000 * restart);
      }
      const last = coordinatorFor(harness, config, advancing, { workerId: "worker-last" });
      expect(await last.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnCeiling" });
    });
  });

  test("another thread advancing T3's global sequence does not keep a stuck turn alive", async () => {
    await withHarness("turn-global-sequence", async (harness) => {
      const config = configWith({
        stalledTurn: { timeoutSeconds: 120, retryDelaySeconds: 10, maxAttempts: 1 },
      });
      // T3 reports its global read-model sequence; a busy neighbour thread bumps it on every poll.
      let sequence = 0;
      const coordinator = coordinatorFor(harness, config, () => snapshot({ ...harness.turn, sequence: ++sequence }));
      const receipt = ingest(harness.store, 1);

      expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnStalled" });
      expect(harness.clock.ms - startMs).toBeLessThanOrEqual(120_000 + 10_000);
      expect(readOperation(harness.path, receipt.operationId)?.last_error_code).toBe("T3TurnStalled");
    });
  });

  test("the progress marker moves with this thread's activity, message text and turn state only", () => {
    const base = snapshot({ threadId: "thread-1", messageId: "message-1" });
    const marker = t3ProgressMarker(base);
    expect(t3ProgressMarker(snapshot({ threadId: "thread-1", messageId: "message-1" }))).toBe(marker);
    expect(t3ProgressMarker({ ...base, snapshotSequence: 2 })).toBe(marker);
    expect(t3ProgressMarker(snapshot({ threadId: "thread-1", messageId: "message-1", activityCount: 1 }))).not.toBe(marker);
    expect(t3ProgressMarker(snapshot({ threadId: "thread-1", messageId: "message-1", state: "completed" }))).not.toBe(marker);
    const firstMessage = base.thread.messages[0];
    if (firstMessage === undefined) throw new Error("fixture message missing");
    expect(
      t3ProgressMarker({
        ...base,
        thread: { ...base.thread, messages: [{ ...firstMessage, text: `${firstMessage.text}…` }] },
      }),
    ).not.toBe(marker);
  });
});

describe("approval wake-up race (B5)", () => {
  test("a response committed between fetch and defer resumes within one poll", async () => {
    await withHarness("turn-race", async (harness) => {
      const config = configWith();
      const workerCommands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: { dispatch: async (command) => (workerCommands.push(command), { sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      let phase: "waiting" | "race" | "resolved" = "waiting";
      let fetches = 0;
      let sleeps = 0;
      const coordinator = coordinatorFor(harness, config, async () => {
        fetches += 1;
        if (phase === "race") {
          // The worker delivers the approval and commits `resolved` after T3 served this snapshot,
          // which still shows the request as pending: exactly the old lost-wake-up window.
          expect((await worker.processNext()).kind).toBe("resolved");
          phase = "resolved";
          return snapshot({ ...harness.turn, approvals: ["approval-1"] });
        }
        if (phase === "resolved") {
          return snapshot({ ...harness.turn, state: "completed", text: "approved-result" });
        }
        return snapshot({ ...harness.turn, approvals: ["approval-1"] });
      }, { onSleep: () => (sleeps += 1) });
      const receipt = ingest(harness.store, 1);

      expect(await coordinator.processNext()).toMatchObject({ kind: "waiting-interaction", approvalCount: 1 });
      const deferred = readOperation(harness.path, receipt.operationId);
      // Deferred until the approval expires (default 24h), and the wait did not consume an attempt.
      expect(deferred).toMatchObject({
        status: "pending",
        attempts: 0,
        blocked_until: new Date(startMs + 86_400_000).toISOString(),
      });
      const approval = readInteractions(harness.path).find((row) => row.kind === "approval");
      if (approval === undefined) throw new Error("approval interaction was not recorded");

      expect(
        harness.store.submitInteractionResponse({
          interactionId: approval.interaction_id,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "action-1",
          response: { decision: "accept" },
          expirySeconds: 86_400,
          now: new Date(harness.clock.ms).toISOString(),
        }).kind,
      ).toBe("accepted");
      expect(readOperation(harness.path, receipt.operationId)?.blocked_until).toBeNull();

      phase = "race";
      fetches = 0;
      sleeps = 0;
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed", operationId: receipt.operationId });
      expect(fetches).toBe(2);
      expect(sleeps).toBe(1);
      expect(workerCommands).toEqual([
        expect.objectContaining({ type: "thread.approval.respond", requestId: "approval-1", decision: "accept" }),
      ]);
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toBe("approved-result");
    });
  });

  test("the defer decision and a concurrent response are serialized in the store", async () => {
    await withHarness("turn-serial", async (harness) => {
      const { store } = harness;
      const receipt = ingest(store, 1);
      const task = store.getTaskExecution(receipt.taskId);
      const at = (offsetMs: number) => new Date(startMs + offsetMs).toISOString();
      const claim = () => {
        const claimed = store.claimNextOperation({ workerId: "worker-a", now: at(0), leaseMs: 30_000, maxConcurrentTasks: 1 });
        if (claimed === null) throw new Error("operation was not claimable");
        return claimed;
      };
      const record = (requestId: string) =>
        store.recordPendingInteraction({
          taskId: receipt.taskId,
          operationId: receipt.operationId,
          threadId: task.threadId,
          requestId,
          kind: "approval",
          prompt: {},
          conversationId: "C1",
          threadTs: "1000.000001",
          message: () => ({ text: "approve?" }),
          now: at(0),
        });
      const respond = (interactionId: string, action: string) =>
        store.submitInteractionResponse({
          interactionId,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: action,
          response: { decision: "accept" },
          expirySeconds: 86_400,
          now: at(0),
        });
      const decide = (requestIds: readonly string[]) =>
        store.awaitOperationInteractions({
          operationId: receipt.operationId,
          taskId: receipt.taskId,
          workerId: "worker-a",
          threadId: task.threadId,
          actorUserId: "U1",
          conversationId: "C1",
          threadTs: "1000.000001",
          requests: requestIds.map((requestId) => ({ requestId, kind: "approval" as const })),
          expirySeconds: 3_600,
          expiredText: "expired",
          turnActiveMs: 0,
          now: at(1_000),
        });

      claim();
      const first = record("approval-1");
      respond(first.interactionId, "action-1");
      // Response already committed: the coordinator keeps polling and the lease stays held.
      expect(decide(["approval-1"])).toEqual({ kind: "answered" });
      expect(readOperation(harness.path, receipt.operationId)?.status).toBe("inflight");

      // A second request is unanswered: defer until its expiry...
      const second = record("approval-2");
      expect(decide(["approval-1", "approval-2"])).toEqual({
        kind: "deferred",
        blockedUntil: at(3_600_000),
        unanswered: 1,
      });
      // ...and a response committed after the defer clears the block, so the turn wakes at once.
      respond(second.interactionId, "action-2");
      expect(claim()).toMatchObject({ operationId: receipt.operationId, attempt: 1 });
    });
  });
});

describe("approval and question expiry (B7)", () => {
  test("an expired approval posts a notice, interrupts the turn, and unblocks the next queued message", async () => {
    await withHarness("turn-expiry", async (harness) => {
      const config = configWith({ interactionExpirySeconds: 3_600 });
      let firstMessageId = "";
      const coordinator = coordinatorFor(harness, config, () =>
        harness.turn.messageId === firstMessageId
          ? snapshot({ ...harness.turn, approvals: ["approval-1"] })
          : snapshot({ ...harness.turn, state: "completed", text: "second-result" }));
      const first = ingest(harness.store, 1, "first request");
      firstMessageId = first.messageId;
      const second = ingest(harness.store, 2, "never mind, do Y instead");

      expect(await coordinator.processNext()).toMatchObject({ kind: "waiting-interaction", operationId: first.operationId });
      expect(readOperation(harness.path, first.operationId)?.blocked_until).toBe(
        new Date(startMs + 3_600_000).toISOString(),
      );
      // The waiting turn blocks the thread until the approval expires.
      harness.clock.ms += 3_600_000 - 1;
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });

      harness.clock.ms += 1;
      expect(await coordinator.processNext()).toMatchObject({ kind: "expired", operationId: first.operationId });
      expect(readOperation(harness.path, first.operationId)).toMatchObject({
        status: "failed",
        last_error_code: "InteractionExpired",
      });
      const interactions = readInteractions(harness.path);
      expect(interactions).toEqual([
        expect.objectContaining({ kind: "approval", request_id: "approval-1", state: "failed", last_error_code: "expired" }),
        expect.objectContaining({ kind: "cancel", request_id: `interrupt:${first.operationId}`, state: "response-pending" }),
      ]);
      expect(harness.store.operationalStatus(new Date(harness.clock.ms).toISOString()).interactions.awaitingHuman).toBe(0);
      const texts = drainOutboxTexts(harness.store, harness.clock.ms);
      expect(texts.at(-1)).toContain("went unanswered for 1 hour");

      // A late click on the expired card cannot revive it.
      const approval = interactions[0];
      if (approval === undefined) throw new Error("approval interaction missing");
      expect(
        harness.store.submitInteractionResponse({
          interactionId: approval.interaction_id,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "late-click",
          response: { decision: "accept" },
          expirySeconds: 3_600,
          now: new Date(harness.clock.ms).toISOString(),
        }).kind,
      ).toBe("duplicate");

      // The interrupt for the abandoned turn reaches T3 before the next turn may start.
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });
      const workerCommands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: { dispatch: async (command) => (workerCommands.push(command), { sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(workerCommands).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);

      expect(await coordinator.processNext()).toMatchObject({ kind: "completed", operationId: second.operationId });
      const secondTurn = harness.commands.filter((command) => command.type === "thread.turn.start").at(-1);
      expect(secondTurn).toMatchObject({ message: { messageId: second.messageId } });
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toBe("second-result");
    });
  });

  test("a request an earlier turn already expired does not expire the next turn", async () => {
    await withHarness("turn-carried-request", async (harness) => {
      const config = configWith({ interactionExpirySeconds: 3_600 });
      let firstMessageId = "";
      let secondPolls = 0;
      // T3 keeps the expired request pending across the interrupt and reports it on the next turn too.
      const coordinator = coordinatorFor(harness, config, () => {
        if (harness.turn.messageId === firstMessageId) return snapshot({ ...harness.turn, approvals: ["approval-1"] });
        secondPolls += 1;
        return secondPolls === 1
          ? snapshot({ ...harness.turn, approvals: ["approval-1"] })
          : snapshot({ ...harness.turn, approvals: ["approval-1"], state: "completed", text: "second-result" });
      });
      const first = ingest(harness.store, 1, "first request");
      firstMessageId = first.messageId;
      const second = ingest(harness.store, 2, "do Y instead");

      expect(await coordinator.processNext()).toMatchObject({ kind: "waiting-interaction", operationId: first.operationId });
      harness.clock.ms += 3_600_000;
      expect(await coordinator.processNext()).toMatchObject({ kind: "expired", operationId: first.operationId });
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: { dispatch: async () => ({ sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      expect((await worker.processNext()).kind).toBe("resolved");

      expect(await coordinator.processNext()).toMatchObject({ kind: "completed", operationId: second.operationId });
      expect(secondPolls).toBe(2);
      expect(readOperation(harness.path, second.operationId)?.last_error_code ?? null).toBeNull();
      expect(drainOutboxTexts(harness.store, harness.clock.ms).at(-1)).toBe("second-result");
    });
  });

  test("an earlier turn's unanswered request past its deadline does not expire the next turn", async () => {
    await withHarness("turn-carried-pending", async (harness) => {
      const { store } = harness;
      const first = ingest(store, 1, "first request");
      const second = ingest(store, 2, "do Y instead");
      const task = store.getTaskExecution(first.taskId);
      const at = (offsetMs: number) => new Date(startMs + offsetMs).toISOString();
      const firstClaim = store.claimNextOperation({ workerId: "worker-a", now: at(0), leaseMs: 30_000, maxConcurrentTasks: 1 });
      expect(firstClaim?.operationId).toBe(first.operationId);
      store.recordPendingInteraction({
        taskId: first.taskId,
        operationId: first.operationId,
        threadId: task.threadId,
        requestId: "question-1",
        kind: "user-input",
        prompt: {},
        conversationId: "C1",
        threadTs: "1000.000001",
        message: () => ({ text: "which one?" }),
        now: at(0),
      });
      // The first turn ends some other way (here: cancelled) while its question stays pending.
      store.cancelOperationWithOutbox({
        operationId: first.operationId,
        taskId: first.taskId,
        workerId: "worker-a",
        conversationId: "C1",
        threadTs: "1000.000001",
        now: at(1_000),
      });
      const later = at(2 * 3_600_000);
      const secondClaim = store.claimNextOperation({ workerId: "worker-a", now: later, leaseMs: 30_000, maxConcurrentTasks: 1 });
      expect(secondClaim?.operationId).toBe(second.operationId);
      expect(
        store.awaitOperationInteractions({
          operationId: second.operationId,
          taskId: second.taskId,
          workerId: "worker-a",
          threadId: task.threadId,
          actorUserId: "U1",
          conversationId: "C1",
          threadTs: "1000.000001",
          requests: [{ requestId: "question-1", kind: "user-input" }],
          expirySeconds: 3_600,
          expiredText: "expired",
          turnActiveMs: 0,
          now: later,
        }),
      ).toEqual({ kind: "answered" });
      expect(readOperation(harness.path, second.operationId)?.status).toBe("inflight");
    });
  });

  test("a question answered before expiry is not expired", async () => {
    await withHarness("turn-answered", async (harness) => {
      const config = configWith({ interactionExpirySeconds: 3_600 });
      const coordinator = coordinatorFor(harness, config, () => snapshot({ ...harness.turn, approvals: ["approval-1"] }));
      const receipt = ingest(harness.store, 1);
      expect((await coordinator.processNext()).kind).toBe("waiting-interaction");
      const approval = readInteractions(harness.path)[0];
      if (approval === undefined) throw new Error("approval interaction missing");
      harness.clock.ms += 3_600_000 - 1_000;
      harness.store.submitInteractionResponse({
        interactionId: approval.interaction_id,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "action-1",
        response: { decision: "decline" },
        expirySeconds: 3_600,
        now: new Date(harness.clock.ms).toISOString(),
      });
      // Past the expiry, T3 still shows the request, but a response is queued: keep polling, then stall
      // normally rather than expiring an answered request.
      harness.clock.ms += 2_000;
      expect(await coordinator.processNext()).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnStalled" });
      expect(readInteractions(harness.path)[0]).toMatchObject({ state: "response-pending" });
      expect(readOperation(harness.path, receipt.operationId)?.last_error_code).toBe("T3TurnStalled");
    });
  });
  test("a response arriving after the deadline but before the expiry poll is refused", async () => {
    await withHarness("turn-late", async (harness) => {
      const config = configWith({ interactionExpirySeconds: 3_600 });
      const coordinator = coordinatorFor(harness, config, () => snapshot({ ...harness.turn, approvals: ["approval-1"] }));
      const receipt = ingest(harness.store, 1);
      expect((await coordinator.processNext()).kind).toBe("waiting-interaction");
      const approval = readInteractions(harness.path)[0];
      if (approval === undefined) throw new Error("approval interaction missing");

      // The click lands at the deadline, before the coordinator has polled the expired wait.
      harness.clock.ms += 3_600_000;
      expect(
        harness.store.submitInteractionResponse({
          interactionId: approval.interaction_id,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "late-click",
          response: { decision: "accept" },
          expirySeconds: 3_600,
          now: new Date(harness.clock.ms).toISOString(),
        }),
      ).toEqual({ kind: "expired" });
      expect(readInteractions(harness.path)[0]).toMatchObject({ state: "pending" });

      expect(await coordinator.processNext()).toMatchObject({ kind: "expired", operationId: receipt.operationId });
      const workerCommands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: { dispatch: async (command) => (workerCommands.push(command), { sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect((await worker.processNext()).kind).toBe("idle");
      // Only the interrupt reaches T3; the late approval is never delivered.
      expect(workerCommands).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);
    });
  });
});

describe("interactions of an abandoned turn (B7)", () => {
  const question = {
    questions: [
      { id: "q1", header: "Target", question: "Which one?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
    ],
  };

  function record(
    harness: Harness,
    receipt: { readonly taskId: string; readonly operationId: string },
    requestId: string,
    kind: "approval" | "user-input",
    at: number,
  ): string {
    return harness.store.recordPendingInteraction({
      taskId: receipt.taskId,
      operationId: receipt.operationId,
      threadId: harness.store.getTaskExecution(receipt.taskId).threadId,
      requestId,
      kind,
      prompt: kind === "user-input" ? question : {},
      conversationId: "C1",
      threadTs: "1000.000001",
      message: () => ({ text: `${requestId}?` }),
      now: new Date(at).toISOString(),
    }).interactionId;
  }

  function approve(harness: Harness, interactionId: string, sourceActionId: string) {
    return harness.store.submitInteractionResponse({
      interactionId,
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      sourceActionId,
      response: { decision: "accept" },
      expirySeconds: 86_400,
      now: new Date(harness.clock.ms).toISOString(),
    });
  }

  function answer(harness: Harness, interactionId: string, sourceActionId: string) {
    return harness.store.submitUserInputAnswer({
      interactionId,
      questionId: "q1",
      selection: { optionIndexes: [0] },
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      sourceActionId,
      expirySeconds: 86_400,
      now: new Date(harness.clock.ms).toISOString(),
    });
  }

  async function abandonAtCeiling(harness: Harness, config: AgentTagConfig) {
    let activityCount = 0;
    const coordinator = coordinatorFor(harness, config, () => snapshot({ ...harness.turn, activityCount: ++activityCount }));
    expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnCeiling" });
  }

  function deliverAll(harness: Harness, config: AgentTagConfig): Promise<T3Command[]> {
    const delivered: T3Command[] = [];
    const worker = new InteractionWorker({
      config,
      store: harness.store,
      t3: { dispatch: async (command) => (delivered.push(command), { sequence: 1 }) },
      now: () => new Date(harness.clock.ms),
    });
    return (async () => {
      while ((await worker.processNext()).kind !== "idle") {
        // drain every queued response
      }
      return delivered;
    })();
  }

  const ceilingConfig = () =>
    configWith({
      interactionExpirySeconds: 86_400,
      stalledTurn: { timeoutSeconds: 300, retryDelaySeconds: 30, maxAttempts: 5, maxTurnSeconds: 3_600 },
    });

  test("abandoning a turn at its ceiling closes its open approvals and questions in the same transaction", async () => {
    await withHarness("abandon-closes", async (harness) => {
      const config = ceilingConfig();
      const receipt = ingest(harness.store, 1);
      const pendingApproval = record(harness, receipt, "approval-1", "approval", startMs);
      const answeredApproval = record(harness, receipt, "approval-2", "approval", startMs);
      const pendingQuestion = record(harness, receipt, "question-1", "user-input", startMs);
      expect(approve(harness, answeredApproval, "early-click").kind).toBe("accepted");

      await abandonAtCeiling(harness, config);
      const byRequest = new Map(readInteractions(harness.path).map((row) => [row.request_id, row]));
      for (const requestId of ["approval-1", "approval-2", "question-1"]) {
        expect(byRequest.get(requestId)).toMatchObject({ state: "failed", last_error_code: "abandoned" });
      }
      expect(byRequest.get(`interrupt:${receipt.operationId}`)).toMatchObject({ kind: "cancel", state: "response-pending" });
      expect(harness.store.operationalStatus(new Date(harness.clock.ms).toISOString()).interactions.awaitingHuman).toBe(0);

      // Late Slack clicks cannot revive the closed requests.
      expect(approve(harness, pendingApproval, "late-click").kind).toBe("duplicate");
      expect(answer(harness, pendingQuestion, "late-answer").kind).toBe("duplicate");
      expect(await deliverAll(harness, config)).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);
    });
  });

  test("a message-mode question answered after abandonment does not start a turn", async () => {
    await withHarness("abandon-question", async (harness) => {
      const config = ceilingConfig();
      const receipt = ingest(harness.store, 1);
      const pendingQuestion = record(harness, receipt, "question-1", "user-input", startMs);

      await abandonAtCeiling(harness, config);
      const turnsBefore = harness.commands.filter((command) => command.type === "thread.turn.start").length;
      expect(answer(harness, pendingQuestion, "reply-after-interrupt").kind).toBe("duplicate");

      const delivered = await deliverAll(harness, config);
      expect(delivered.map((command) => command.type)).toEqual(["thread.turn.interrupt"]);
      expect(harness.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(turnsBefore);
      expect(await coordinatorFor(harness, config, () => snapshot(harness.turn)).processNext()).toEqual({ kind: "idle" });
    });
  });

  test("responses to a pending interaction of a settled operation are refused", async () => {
    await withHarness("settled-refused", async (harness) => {
      const { store } = harness;
      const receipt = ingest(store, 1);
      const claim = store.claimNextOperation({ workerId: "worker-a", now: start, leaseMs: 30_000, maxConcurrentTasks: 1 });
      expect(claim?.operationId).toBe(receipt.operationId);
      const approval = record(harness, receipt, "approval-1", "approval", startMs);
      const pendingQuestion = record(harness, receipt, "question-1", "user-input", startMs);
      // Another terminal path (cancellation) settles the operation without closing its requests.
      store.cancelOperationWithOutbox({
        operationId: receipt.operationId,
        taskId: receipt.taskId,
        workerId: "worker-a",
        conversationId: "C1",
        threadTs: "1000.000001",
        now: start,
      });

      expect(approve(harness, approval, "late-click")).toEqual({ kind: "expired" });
      expect(answer(harness, pendingQuestion, "late-answer")).toEqual({ kind: "expired" });
      expect(readInteractions(harness.path).map((row) => row.state)).toEqual(["pending", "pending"]);
      expect(await deliverAll(harness, configWith())).toEqual([]);
    });
  });

  test("a later turn adopts an earlier turn's still-answerable request, so it can be answered", async () => {
    await withHarness("adopt-carried", async (harness) => {
      const { store } = harness;
      const first = ingest(store, 1, "first request");
      const second = ingest(store, 2, "do Y instead");
      const at = (offsetMs: number) => new Date(startMs + offsetMs).toISOString();
      store.claimNextOperation({ workerId: "worker-a", now: at(0), leaseMs: 30_000, maxConcurrentTasks: 1 });
      const carried = record(harness, first, "question-1", "user-input", startMs);
      store.cancelOperationWithOutbox({
        operationId: first.operationId,
        taskId: first.taskId,
        workerId: "worker-a",
        conversationId: "C1",
        threadTs: "1000.000001",
        now: at(1_000),
      });
      expect(
        store.claimNextOperation({ workerId: "worker-a", now: at(2_000), leaseMs: 30_000, maxConcurrentTasks: 1 })?.operationId,
      ).toBe(second.operationId);
      // T3 reports the first turn's question on the second turn, which now waits for it.
      expect(
        store.awaitOperationInteractions({
          operationId: second.operationId,
          taskId: second.taskId,
          workerId: "worker-a",
          threadId: store.getTaskExecution(second.taskId).threadId,
          actorUserId: "U1",
          conversationId: "C1",
          threadTs: "1000.000001",
          requests: [{ requestId: "question-1", kind: "user-input" }],
          expirySeconds: 86_400,
          expiredText: "expired",
          turnActiveMs: 0,
          now: at(2_000),
        }),
      ).toMatchObject({ kind: "deferred", unanswered: 1 });

      harness.clock.ms = startMs + 3_000;
      expect(answer(harness, carried, "answer-1").kind).toBe("accepted");
      expect(readOperation(harness.path, second.operationId)?.blocked_until).toBeNull();
    });
  });

  function byRequestId(harness: Harness) {
    return new Map(readInteractions(harness.path).map((row) => [row.request_id, row]));
  }

  /** Writes directly to the database, bypassing the store, to stage states its API cannot produce. */
  function rawWrite(harness: Harness, sql: string, ...params: string[]): void {
    const database = new Database(harness.path, { strict: true });
    try {
      database.query(sql).run(...params);
    } finally {
      database.close();
    }
  }

  test("an answer still queued when stall attempts exhaust is closed with the operation and never sent", async () => {
    await withHarness("stall-closes-queued", async (harness) => {
      const config = configWith({
        interactionExpirySeconds: 86_400,
        stalledTurn: { timeoutSeconds: 60, retryDelaySeconds: 30, maxAttempts: 1 },
      });
      const receipt = ingest(harness.store, 1);
      const question = record(harness, receipt, "question-1", "user-input", startMs);
      expect(answer(harness, question, "answer-1").kind).toBe("accepted");
      expect(byRequestId(harness).get("question-1")?.state).toBe("response-pending");

      // The answer is still queued (no worker has sent it) when the turn exhausts its stall attempts.
      const coordinator = coordinatorFor(harness, config, () => snapshot(harness.turn));
      expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "T3TurnStalled" });
      expect(readOperation(harness.path, receipt.operationId)?.status).toBe("failed");
      expect(byRequestId(harness).get("question-1")).toMatchObject({ state: "failed", last_error_code: "operation-settled" });
      expect(await deliverAll(harness, config)).toEqual([]);
    });
  });

  test("an expiry failure closes the operation's other queued responses, so only the interrupt is sent", async () => {
    await withHarness("expiry-closes-queued", async (harness) => {
      const config = configWith({ interactionExpirySeconds: 3_600 });
      const coordinator = coordinatorFor(harness, config, () =>
        snapshot({ ...harness.turn, approvals: ["approval-1", "approval-2"] }));
      const receipt = ingest(harness.store, 1);
      expect(await coordinator.processNext()).toMatchObject({ kind: "waiting-interaction", approvalCount: 2 });
      const approved = byRequestId(harness).get("approval-2");
      if (approved === undefined) throw new Error("approval-2 interaction missing");
      expect(approve(harness, approved.interaction_id, "click-2").kind).toBe("accepted");

      // approval-1 goes unanswered and expires while approval-2's response is still queued.
      harness.clock.ms = startMs + 3_600_000;
      expect(await coordinator.processNext()).toMatchObject({ kind: "expired", operationId: receipt.operationId });
      const rows = byRequestId(harness);
      expect(rows.get("approval-1")).toMatchObject({ state: "failed", last_error_code: "expired" });
      expect(rows.get("approval-2")).toMatchObject({ state: "failed", last_error_code: "operation-settled" });
      expect(await deliverAll(harness, config)).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);
    });
  });

  test("a crashed worker's in-flight answer is never reclaimed after its operation hits the ceiling", async () => {
    await withHarness("ceiling-inflight", async (harness) => {
      const config = ceilingConfig();
      const receipt = ingest(harness.store, 1);
      const question = record(harness, receipt, "question-1", "user-input", startMs);
      expect(answer(harness, question, "answer-1").kind).toBe("accepted");
      // A worker claims the answer and crashes before sending it; its lease outlives the turn.
      const claimed = harness.store.claimNextInteractionResponse({ workerId: "crashed", now: start, leaseMs: 3 * HOUR });
      expect(claimed?.interactionId).toBe(question);

      await abandonAtCeiling(harness, config);
      expect(byRequestId(harness).get("question-1")).toMatchObject({ state: "failed", last_error_code: "abandoned" });
      // A replacement worker delivers the interrupt; the abandoned answer is not reclaimable, then or later.
      expect(await deliverAll(harness, config)).toEqual([
        expect.objectContaining({ type: "thread.turn.interrupt", threadId: harness.turn.threadId }),
      ]);
      harness.clock.ms = startMs + 4 * HOUR;
      expect(await deliverAll(harness, config)).toEqual([]);
      expect(() =>
        harness.store.completeInteractionResponse({ interactionId: question, workerId: "crashed", now: start }),
      ).toThrow("interaction lease");
    });
  });

  test("the claim settles, and never hands out, responses whose operation has settled", async () => {
    await withHarness("claim-refuses-settled", async (harness) => {
      const receipt = ingest(harness.store, 1);
      const queued = record(harness, receipt, "question-1", "user-input", startMs);
      const held = record(harness, receipt, "approval-1", "approval", startMs);
      expect(answer(harness, queued, "answer-1").kind).toBe("accepted");
      expect(approve(harness, held, "click-1").kind).toBe("accepted");
      const claimed = harness.store.claimNextInteractionResponse({ workerId: "crashed", now: start, leaseMs: 1_000 });
      expect([queued, held]).toContain(claimed?.interactionId ?? "none");
      // Rows left behind by a settle that did not close them (e.g. written before this invariant):
      // one queued response, one in flight under an expired lease.
      rawWrite(harness, "UPDATE operations SET status = 'failed', last_error_code = 'legacy' WHERE operation_id = ?", receipt.operationId);

      const later = new Date(startMs + 5_000).toISOString();
      expect(harness.store.claimNextInteractionResponse({ workerId: "worker-b", now: later, leaseMs: 30_000 })).toBeNull();
      const rows = byRequestId(harness);
      expect(rows.get("question-1")).toMatchObject({ state: "failed", last_error_code: "operation-settled" });
      expect(rows.get("approval-1")).toMatchObject({ state: "failed", last_error_code: "operation-settled" });
    });
  });

  test("the worker refuses a claimed response whose operation settled before dispatch", async () => {
    await withHarness("worker-refuses-settled", async (harness) => {
      const config = configWith();
      const receipt = ingest(harness.store, 1);
      const approval = record(harness, receipt, "approval-1", "approval", startMs);
      expect(approve(harness, approval, "click-1").kind).toBe("accepted");
      // The operation settles between the worker's claim and its dispatch, outside a closing transition.
      const store = harness.store;
      const racingStore = new Proxy(store, {
        get(target, property) {
          if (property === "claimNextInteractionResponse") {
            return (input: Parameters<AgentTagStore["claimNextInteractionResponse"]>[0]) => {
              const claimed = target.claimNextInteractionResponse(input);
              rawWrite(harness, "UPDATE operations SET status = 'failed' WHERE operation_id = ?", receipt.operationId);
              return claimed;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const delivered: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store: racingStore,
        t3: { dispatch: async (command) => (delivered.push(command), { sequence: 1 }) },
        now: () => new Date(harness.clock.ms),
      });
      expect(await worker.processNext()).toEqual({ kind: "failed", interactionId: approval, errorCode: "operation-settled" });
      expect(delivered).toEqual([]);
      expect(byRequestId(harness).get("approval-1")).toMatchObject({ state: "failed", last_error_code: "operation-settled" });
      expect(await worker.processNext()).toEqual({ kind: "idle" });
    });
  });
});
