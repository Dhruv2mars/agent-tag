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
      let sequence = 0;
      let lastProgressMs = startMs;
      const coordinator = coordinatorFor(harness, config, () => {
        if (harness.clock.ms - startMs < 30 * MINUTE) {
          sequence += 1;
          lastProgressMs = harness.clock.ms;
        }
        return snapshot({ ...harness.turn, sequence });
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
      let sequence = 0;
      const controller = new AbortController();
      const advancing = () => snapshot({ ...harness.turn, sequence: ++sequence });
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

  test("the progress marker moves with sequence, activity, message text and turn state", () => {
    const base = snapshot({ threadId: "thread-1", messageId: "message-1" });
    const marker = t3ProgressMarker(base);
    expect(t3ProgressMarker(snapshot({ threadId: "thread-1", messageId: "message-1" }))).toBe(marker);
    expect(t3ProgressMarker({ ...base, snapshotSequence: 2 })).not.toBe(marker);
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
});
