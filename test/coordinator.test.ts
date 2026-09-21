import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, type T3CoordinatorGateway } from "../src/coordinator.ts";
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

function completedSnapshot(threadId: string, text: string): T3ThreadSnapshot {
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

describe("Agent Tag coordinator", () => {
  test("maps durable operations to T3 and atomically queues final Slack replies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const commands: T3Command[] = [];
    let finalText = "first-result";
    let threadId = "not-dispatched";
    const t3: T3CoordinatorGateway = {
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.turn.start") threadId = command.threadId;
        return { sequence: commands.length };
      },
      fetchThread: async () => completedSnapshot(threadId, finalText),
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
      store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "first request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
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
      const firstOutbox = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      expect(firstOutbox?.payload.text).toBe("first-result");
      if (firstOutbox === null) throw new Error("first final reply was not queued");
      store.markOutboxDelivered({
        outboxId: firstOutbox.outboxId,
        workerId: "slack-a",
        slackMessageTs: "1000.000010",
        now,
      });

      store.ingestSlackEvent({
        deliveryId: "delivery-2",
        eventKey: "C1:1000.000002",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "second request",
        receivedAt: now,
        sourceOrderKey: "1000.000002",
      });
      finalText = "second-result";
      const second = await coordinator.processNext();
      expect(second.kind).toBe("completed");
      expect(commands[2]?.type).toBe("project.create");
      expect(commands[3]).toMatchObject({ type: "thread.turn.start", message: { text: "second request" } });
      if (commands[3]?.type !== "thread.turn.start") throw new Error("second turn was not dispatched");
      expect(commands[3].bootstrap).toBeUndefined();
      const secondOutbox = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      expect(secondOutbox?.payload.text).toBe("second-result");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-coordinator-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
