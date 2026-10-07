import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, classifyT3TurnFailure, type T3CoordinatorGateway } from "../src/coordinator.ts";
import { InteractionWorker } from "../src/interaction-worker.ts";
import { AgentTagMemory } from "../src/memory.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";

const now = "2026-09-21T00:00:00.000Z";
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
  limits: { maxConcurrentTasks: 2 },
});

function completedSnapshot(threadId: string, text: string, userMessageId?: string): T3ThreadSnapshot {
  return {
    snapshotSequence: 9,
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "agent-tag/task-1",
      worktreePath: "/tmp/worktree",
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: "assistant-1",
      },
      messages: [
        ...(userMessageId === undefined ? [] : [{
          id: userMessageId,
          role: "user" as const,
          text: "fixture request",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        }]),
        {
          id: "assistant-1",
          role: "assistant",
          text,
          turnId: "turn-1",
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [],
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

function waitingSnapshot(threadId: string): T3ThreadSnapshot {
  const base = completedSnapshot(threadId, "");
  return {
    ...base,
    thread: {
      ...base.thread,
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      messages: [],
      activities: [
        {
          id: "activity-approval",
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "run tests" },
          turnId: "turn-1",
          createdAt: now,
        },
        {
          id: "activity-question",
          tone: "approval",
          kind: "user-input.requested",
          summary: "Input requested",
          payload: {
            requestId: "question-1",
            responseMode: "message",
            questions: [
              {
                id: "package",
                header: "Package",
                question: "Which package?",
                options: [{ label: "core" }, { label: "web" }],
                multiSelect: false,
              },
            ],
          },
          turnId: "turn-1",
          createdAt: now,
        },
      ],
    },
  };
}

function runningSnapshot(threadId: string, userMessageId: string): T3ThreadSnapshot {
  const base = completedSnapshot(threadId, "", userMessageId);
  return {
    ...base,
    thread: {
      ...base.thread,
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      messages: base.thread.messages.filter((message) => message.role === "user"),
    },
  };
}

function interruptedSnapshot(threadId: string): T3ThreadSnapshot {
  const base = completedSnapshot(threadId, "");
  return {
    ...base,
    thread: {
      ...base.thread,
      latestTurn: {
        turnId: "turn-1",
        state: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
      messages: [],
    },
  };
}

describe("Agent Tag coordinator", () => {
  test("applies the configured stalled-turn retry and terminal policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-stall-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const stalledConfig = agentTagConfigSchema.parse({
      ...config,
      limits: {
        ...config.limits,
        stalledTurn: { timeoutSeconds: 2, retryDelaySeconds: 10, maxAttempts: 2 },
      },
    });
    let currentTime = new Date(now).getTime();
    let threadId = "not-dispatched";
    let messageId = "not-dispatched";
    const turnCommandIds: string[] = [];
    const coordinator = new AgentTagCoordinator({
      config: stalledConfig,
      store,
      t3: {
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") {
            threadId = command.threadId;
            messageId = command.message.messageId;
            turnCommandIds.push(command.commandId);
          }
          return { sequence: 1 };
        },
        fetchThread: async () => runningSnapshot(threadId, messageId),
      },
      workerId: "worker-a",
      now: () => new Date(currentTime),
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    });
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
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });

      expect(await coordinator.processNext()).toMatchObject({
        kind: "retry-scheduled",
        errorCode: "T3TurnStalled",
      });
      expect(store.operationalStatus(new Date(currentTime).toISOString()).operations).toMatchObject({
        deferred: 1,
        stalledRetry: 1,
        stalledFailed: 0,
      });

      currentTime += stalledConfig.limits.stalledTurn.retryDelaySeconds * 1_000;
      expect(await coordinator.processNext()).toMatchObject({
        kind: "failed",
        errorCode: "T3TurnStalled",
      });
      expect(store.operationalStatus(new Date(currentTime).toISOString()).operations).toMatchObject({
        stalledRetry: 0,
        stalledFailed: 1,
      });
      expect(turnCommandIds).toHaveLength(2);
      expect(turnCommandIds[1]).toBe(turnCommandIds[0]);
      expect(store.diagnostics().outbox).toBe(2);
      const outboxNow = new Date(currentTime).toISOString();
      const progress = store.claimNextOutbox({ workerId: "slack-a", now: outboxNow, leaseMs: 10_000 });
      expect(progress?.payload.text).toBe("Agent Tag is working on this request.");
      if (progress === null) throw new Error("stalled-turn progress reply was not queued");
      store.markOutboxDelivered({
        outboxId: progress.outboxId,
        workerId: "slack-a",
        slackMessageTs: "1000.000010",
        now: outboxNow,
      });
      const failure = store.claimNextOutbox({ workerId: "slack-a", now: outboxNow, leaseMs: 10_000 });
      expect(failure?.payload.text).toContain("configured T3 turn deadline");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-stall-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("settles a provider limit with one durable Slack error and no retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-limit-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let threadId = "not-dispatched";
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") threadId = command.threadId;
          return { sequence: 1 };
        },
        fetchThread: async () => {
          const snapshot = completedSnapshot(threadId, "");
          return {
            ...snapshot,
            thread: {
              ...snapshot.thread,
              latestTurn: snapshot.thread.latestTurn === null
                ? null
                : { ...snapshot.thread.latestTurn, state: "error" },
              session: snapshot.thread.session === null
                ? null
                : { ...snapshot.thread.session, status: "error", lastError: "usage limit reached" },
            },
          };
        },
      },
      workerId: "worker-a",
      now: () => new Date(now),
    });
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
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "T3ProviderLimit" });
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });
      expect(store.diagnostics().outbox).toBe(2);
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-limit-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("projects private memory only when the durable task is a bound DM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-dm-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const profile = config.profiles[0];
    if (profile === undefined) throw new Error("coordinator fixture profile is missing");
    const dmConfig = agentTagConfigSchema.parse({
      ...config,
      access: { ...config.access, allowedChannelIds: ["D1"] },
      profiles: [{ ...profile, memory: { ...profile.memory, privateDm: true } }],
      routes: [
        {
          conversationId: "D1",
          conversationType: "dm",
          ownerUserId: "U1",
          profileId: profile.id,
        },
      ],
    });
    const commands: T3Command[] = [];
    let threadId = "not-dispatched";
    const t3: T3CoordinatorGateway = {
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.turn.start") threadId = command.threadId;
        return { sequence: commands.length };
      },
      fetchThread: async () => completedSnapshot(threadId, "done"),
    };
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "dm-delivery-1",
        eventKey: "D1:1000.000001",
        workspaceId: "T1",
        conversationId: "D1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "dm",
        profileId: profile.id,
        repositoryRoot: "/srv/repos/example",
        text: "private request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      const memory = new AgentTagMemory({ config: dmConfig, store });
      expect(
        memory.create({
          context: {
            workspaceId: "T1",
            actorUserId: "U1",
            profileId: profile.id,
            taskId: receipt.taskId,
            conversationType: "dm",
          },
          scope: "private",
          content: "private owner context",
          sourceType: "slack-dm",
          sourceId: "D1:999.000001",
          now,
        }).kind,
      ).toBe("accepted");
      const coordinator = new AgentTagCoordinator({
        config: dmConfig,
        store,
        t3,
        workerId: "dm-worker",
        now: () => new Date(now),
        sleep: async () => {},
      });
      expect((await coordinator.processNext()).kind).toBe("completed");
      const turn = commands.find((command) => command.type === "thread.turn.start");
      if (turn?.type !== "thread.turn.start") throw new Error("DM turn was not dispatched");
      expect(turn.message.text).toContain("private owner context");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-dm-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("maps durable operations to T3 and atomically queues final Slack replies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const commands: T3Command[] = [];
    let finalText = "first-result";
    let threadId = "not-dispatched";
    let currentMessageId: string | undefined;
    let previousMessageId: string | undefined;
    let staleSnapshotsRemaining = 0;
    let staleReads = 0;
    const t3: T3CoordinatorGateway = {
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.turn.start") {
          threadId = command.threadId;
          previousMessageId = currentMessageId;
          currentMessageId = command.message.messageId;
        }
        return { sequence: commands.length };
      },
      fetchThread: async () => {
        if (staleSnapshotsRemaining > 0) {
          staleSnapshotsRemaining -= 1;
          staleReads += 1;
          if (staleSnapshotsRemaining === 1) {
            return completedSnapshot(threadId, "first-result", previousMessageId);
          }
          const stale = completedSnapshot(threadId, "first-result", currentMessageId);
          if (stale.thread.latestTurn === null) throw new Error("fixture turn missing");
          return {
            ...stale,
            thread: {
              ...stale.thread,
              latestTurn: { ...stale.thread.latestTurn, requestedAt: "2026-09-20T23:59:59.000Z" },
            },
          };
        }
        return completedSnapshot(threadId, finalText, currentMessageId);
      },
    };
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3,
      workerId: "worker-a",
      now: () => new Date(now),
      sleep: async () => {},
    });
    try {
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
        text: "first request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      const memory = new AgentTagMemory({ config, store });
      expect(
        memory.create({
          context: {
            workspaceId: "T1",
            actorUserId: "U1",
            profileId: "engineering",
            taskId: receipt.taskId,
            conversationType: "channel",
          },
          scope: "task",
          content: "remember the durable boundary",
          sourceType: "slack-message",
          sourceId: "C1:999.000001",
          now,
        }).kind,
      ).toBe("accepted");
      const first = await coordinator.processNext();
      expect(first.kind).toBe("completed");
      expect(commands[0]).toMatchObject({
        type: "project.create",
        workspaceRoot: "/srv/repos/example",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        runtimeMode: "approval-required",
        bootstrap: {
          prepareWorktree: { projectCwd: "/srv/repos/example", baseBranch: "main" },
        },
      });
      if (commands[1]?.type !== "thread.turn.start") throw new Error("first turn was not dispatched");
      expect(commands[1].message.text).toContain("first request");
      expect(commands[1].message.text).toContain("remember the durable boundary");
      expect(commands[1].message.text).toContain("untrusted context");
      const firstProgress = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      expect(firstProgress?.payload.text).toBe("Agent Tag is working on this request.");
      expect(firstProgress?.payload.blocks?.[1]).toMatchObject({
        type: "actions",
        elements: [{ action_id: "agent-tag.turn.cancel" }],
      });
      if (firstProgress === null) throw new Error("first progress reply was not queued");
      store.markOutboxDelivered({
        outboxId: firstProgress.outboxId,
        workerId: "slack-a",
        slackMessageTs: "1000.000010",
        now,
      });
      const firstOutbox = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      expect(firstOutbox?.payload.text).toBe("first-result");
      if (firstOutbox === null) throw new Error("first final reply was not queued");
      store.markOutboxDelivered({
        outboxId: firstOutbox.outboxId,
        workerId: "slack-a",
        slackMessageTs: "1000.000011",
        now,
      });

      store.ingestSlackEvent({
        deliveryId: "delivery-2",
        eventKey: "C1:1000.000002",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "second request",
        receivedAt: now,
        sourceOrderKey: "1000.000002",
      });
      finalText = "second-result";
      staleSnapshotsRemaining = 2;
      const second = await coordinator.processNext();
      expect(second.kind).toBe("completed");
      expect(staleReads).toBe(2);
      expect(commands[2]?.type).toBe("project.create");
      expect(commands[3]).toMatchObject({ type: "thread.turn.start" });
      if (commands[3]?.type !== "thread.turn.start") throw new Error("second turn was not dispatched");
      expect(commands[3].message.text).toContain("second request");
      expect(commands[3].message.text).toContain("remember the durable boundary");
      expect(commands[3].bootstrap).toBeUndefined();
      const secondProgress = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      if (secondProgress === null) throw new Error("second progress reply was not queued");
      store.markOutboxDelivered({
        outboxId: secondProgress.outboxId,
        workerId: "slack-a",
        slackMessageTs: "1000.000012",
        now,
      });
      const secondOutbox = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      expect(secondOutbox?.payload.text).toBe("second-result");

      const nextTask = store.ingestSlackEvent({
        deliveryId: "delivery-3",
        eventKey: "C1:2000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "2000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "new task in the same repository",
        receivedAt: now,
        sourceOrderKey: "2000.000001",
      });
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(commands[4]).toMatchObject({
        type: "project.create",
        commandId: commands[0]?.commandId,
        projectId: store.getTaskExecution(receipt.taskId).projectId,
      });
      expect(commands[5]).toMatchObject({
        type: "thread.turn.start",
        threadId: store.getTaskExecution(nextTask.taskId).threadId,
        bootstrap: { createThread: { projectId: store.getTaskExecution(receipt.taskId).projectId } },
      });
      expect(store.getTaskExecution(nextTask.taskId).threadId).not.toBe(store.getTaskExecution(receipt.taskId).threadId);
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("durably defers a turn while approvals and questions wait for Slack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-waiting-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let threadId = "not-dispatched";
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") threadId = command.threadId;
          return { sequence: 1 };
        },
        fetchThread: async () => waitingSnapshot(threadId),
      },
      workerId: "worker-a",
      now: () => new Date(now),
      sleep: async () => {},
    });
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
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect(await coordinator.processNext()).toMatchObject({
        kind: "waiting-interaction",
        approvalCount: 1,
        questionCount: 1,
      });
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });
      expect(store.diagnostics().outbox).toBe(3);
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-waiting-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("settles an interrupted T3 turn as a durable cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-cancel-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let threadId = "not-dispatched";
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          if (command.type === "thread.turn.start") threadId = command.threadId;
          return { sequence: 1 };
        },
        fetchThread: async () => interruptedSnapshot(threadId),
      },
      workerId: "worker-a",
      now: () => new Date(now),
      sleep: async () => {},
    });
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
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect((await coordinator.processNext()).kind).toBe("cancelled");
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });
      expect(store.diagnostics().outbox).toBe(2);
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-cancel-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("a cancel after a lost turn.start receipt interrupts the replayed turn instead of dropping it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-lost-receipt-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let current = new Date(now);
    let threadId = "not-dispatched";
    let receiptsLost = 1;
    let interrupted = false;
    const commands: T3Command[] = [];
    const interactionOutcomes: string[] = [];
    const worker = new InteractionWorker({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.interrupt") interrupted = true;
          return { sequence: commands.length };
        },
        fetchThread: async () => {
          throw new Error("a live operation's cancel must wait for the coordinator, not read T3");
        },
      },
      workerId: "interaction-a",
      now: () => current,
    });
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start") {
            threadId = command.threadId;
            // T3 accepted the turn, but the response never reached Agent Tag.
            if (receiptsLost > 0) {
              receiptsLost -= 1;
              throw new Error("socket closed before the dispatch receipt arrived");
            }
          }
          return { sequence: commands.length };
        },
        fetchThread: async () => {
          if (!interrupted) interactionOutcomes.push((await worker.processNext()).kind);
          return interrupted ? interruptedSnapshot(threadId) : runningSnapshot(threadId, "unused");
        },
      },
      workerId: "worker-a",
      now: () => current,
      sleep: async () => {},
    });
    try {
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
        text: "request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect((await coordinator.processNext()).kind).toBe("retry-scheduled");
      expect(
        store.requestTaskCancellation({
          taskId: receipt.taskId,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "cancel-after-lost-receipt",
          now: current.toISOString(),
        }),
      ).toMatchObject({ kind: "accepted", disposition: "interrupt-requested" });
      // The turn's fate is unknown, so the interrupt waits for the replay rather than firing blindly.
      const waiting = await worker.processNext();
      expect(waiting).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnNotStarted" });
      if (waiting.kind !== "retry-scheduled") throw new Error("expected a retry");

      current = new Date(Math.max(new Date(waiting.blockedUntil).getTime(), current.getTime() + 60_000));
      expect((await coordinator.processNext()).kind).toBe("cancelled");
      expect(interactionOutcomes).toEqual(["resolved"]);
      const turnStarts = commands.filter((command) => command.type === "thread.turn.start");
      expect(turnStarts).toHaveLength(2);
      expect(turnStarts[1]?.commandId).toBe(turnStarts[0]?.commandId);
      expect(commands.filter((command) => command.type === "thread.turn.interrupt")).toHaveLength(1);
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-lost-receipt-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  async function cancelAfterEveryReceiptLost(
    prefix: string,
    snapshotFor: (threadId: string, messageId: string) => T3ThreadSnapshot,
  ): Promise<{ readonly outcome: unknown; readonly interrupts: ReadonlyArray<T3Command> }> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let current = new Date(now);
    let threadId = "not-dispatched";
    let messageId = "not-dispatched";
    const commands: T3Command[] = [];
    const worker = new InteractionWorker({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        },
        fetchThread: async () => snapshotFor(threadId, messageId),
      },
      workerId: "interaction-a",
      now: () => current,
    });
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3: {
        dispatch: async (command) => {
          commands.push(command);
          if (command.type === "thread.turn.start") {
            threadId = command.threadId;
            messageId = command.message.messageId;
            // T3 may have accepted the turn, but no receipt ever reaches Agent Tag.
            throw new Error("socket closed before the dispatch receipt arrived");
          }
          return { sequence: commands.length };
        },
        fetchThread: async () => {
          throw new Error("no turn was confirmed, so the coordinator never polls");
        },
      },
      workerId: "worker-a",
      now: () => current,
      sleep: async () => {},
    });
    try {
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
        text: "request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect((await coordinator.processNext()).kind).toBe("retry-scheduled");
      expect(
        store.requestTaskCancellation({
          taskId: receipt.taskId,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "cancel-after-every-receipt-lost",
          now: current.toISOString(),
        }),
      ).toMatchObject({ kind: "accepted", disposition: "interrupt-requested" });
      expect(await worker.processNext()).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnNotStarted" });
      let settled = false;
      for (let attempt = 2; attempt <= 5; attempt++) {
        current = new Date(current.getTime() + 60_000);
        const outcome = await coordinator.processNext();
        settled = outcome.kind === "failed";
        expect(outcome.kind).toBe(attempt === 5 ? "failed" : "retry-scheduled");
      }
      expect(settled).toBe(true);
      current = new Date(current.getTime() + 60_000);
      const outcome = await worker.processNext();
      return { outcome, interrupts: commands.filter((command) => command.type === "thread.turn.interrupt") };
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/${prefix}`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  }

  test("a cancel interrupts a turn T3 is still running after every turn.start receipt was lost", async () => {
    const { outcome, interrupts } = await cancelAfterEveryReceiptLost(
      "agent-tag-coordinator-receipts-lost-running-",
      (threadId, messageId) => runningSnapshot(threadId, messageId),
    );
    expect(outcome).toMatchObject({ kind: "resolved" });
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toMatchObject({ turnId: "turn-1" });
  });

  test("a cancel settles without interrupting when T3 never received the lost turn.start", async () => {
    const { outcome, interrupts } = await cancelAfterEveryReceiptLost(
      "agent-tag-coordinator-receipts-lost-absent-",
      (threadId) => {
        const base = runningSnapshot(threadId, "other-message");
        return { ...base, thread: { ...base.thread, latestTurn: null, messages: [] } };
      },
    );
    expect(outcome).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
    expect(interrupts).toHaveLength(0);
  });

  test("a cancel never interrupts a later message's turn when the lost turn.start is no longer current", async () => {
    const later = new Date(new Date(now).getTime() + 1_000).toISOString();
    const { outcome, interrupts } = await cancelAfterEveryReceiptLost(
      "agent-tag-coordinator-receipts-lost-superseded-",
      (threadId, messageId) => {
        const base = runningSnapshot(threadId, messageId);
        const ours = base.thread.messages[0];
        if (ours === undefined) throw new Error("fixture lacks the user message");
        return {
          ...base,
          thread: {
            ...base.thread,
            latestTurn: base.thread.latestTurn === null
              ? null
              : { ...base.thread.latestTurn, turnId: "turn-2", requestedAt: later },
            messages: [ours, { ...ours, id: "later-message", createdAt: later, updatedAt: later }],
          },
        };
      },
    );
    expect(outcome).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
    expect(interrupts).toHaveLength(0);
  });

  test("releases the lease without failing when shutdown aborts an unsettled poll", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-abort-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let threadId = "not-dispatched";
    let messageId = "not-dispatched";
    const controller = new AbortController();
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
        fetchThread: async () => runningSnapshot(threadId, messageId),
      },
      workerId: "worker-a",
      now: () => new Date(now),
      // A poll interval that never elapses on its own; only the abort can end it.
      sleep: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      },
    });
    try {
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
        text: "request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      expect(await coordinator.processNext(controller.signal)).toEqual({
        kind: "released",
        operationId: receipt.operationId,
      });
      expect(await coordinator.processNext(controller.signal)).toEqual({ kind: "idle" });
      // Only the progress reply was queued; no failure reply.
      expect(store.diagnostics().outbox).toBe(1);
      expect(
        store.claimNextOperation({ workerId: "worker-b", now, leaseMs: 10_000, maxConcurrentTasks: 1 }),
      ).toMatchObject({ operationId: receipt.operationId, commandId: receipt.commandId, attempt: 1 });
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-abort-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("classifies provider authentication failures distinctly without leaking provider text", () => {
    const orgPolicy =
      'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}';
    expect(classifyT3TurnFailure(orgPolicy).code).toBe("T3ProviderAuthPolicy");
    expect(classifyT3TurnFailure("OAuth authentication is currently not allowed for this organization.").code)
      .toBe("T3ProviderAuthPolicy");
    expect(classifyT3TurnFailure(orgPolicy).userMessage).not.toContain("oauth_not_allowed_for_organization");
    expect(
      classifyT3TurnFailure(
        "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread.",
      ).code,
    ).toBe("T3ProviderAuth");
    expect(classifyT3TurnFailure("Claude usage limit reached. Send the message again once the limit resets.").code)
      .toBe("T3ProviderLimit");
    // The generic Claude api_error text does not say why; it stays a generic turn error.
    expect(classifyT3TurnFailure("Claude gave up after repeated API errors.").code).toBe("T3TurnError");
    expect(classifyT3TurnFailure(null).code).toBe("T3TurnError");
  });
});
