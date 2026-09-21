import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagMemory, type MemoryContext } from "../src/memory.ts";
import { AgentTagStore } from "../src/store/store.ts";

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
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1", "C2"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/engineering"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: true, retentionDays: 30 },
    },
    {
      id: "support",
      repositoryRoots: ["/srv/repos/support"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: true, retentionDays: 30 },
    },
  ],
  routes: [
    { conversationId: "C1", profileId: "engineering" },
    { conversationId: "C2", profileId: "support" },
  ],
  limits: { maxConcurrentTasks: 2 },
});

function acceptedMemory(result: ReturnType<AgentTagMemory["create"]>) {
  if (result.kind !== "accepted") throw new Error(`memory fixture denied: ${result.reason}`);
  return result.memory;
}

describe("scoped memory", () => {
  test("enforces scope, attribution, editing, forgetting, and retention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-memory-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/engineering",
        text: "fixture",
        receivedAt: now,
      });
      const memory = new AgentTagMemory({ config, store });
      const channelU1: MemoryContext = {
        workspaceId: "T1",
        actorUserId: "U1",
        profileId: "engineering",
        taskId: receipt.taskId,
        conversationType: "channel",
      };
      const shared = acceptedMemory(memory.create({
        context: channelU1,
        scope: "shared",
        content: "team convention",
        sourceType: "slack-message",
        sourceId: "C1:1000.000010",
        now,
      }));
      const profile = acceptedMemory(memory.create({
        context: channelU1,
        scope: "profile",
        content: "engineering convention",
        sourceType: "slack-message",
        sourceId: "C1:1000.000011",
        now,
      }));
      const task = acceptedMemory(memory.create({
        context: channelU1,
        scope: "task",
        content: "task decision",
        sourceType: "slack-message",
        sourceId: "C1:1000.000012",
        now,
      }));
      const privateEntry = acceptedMemory(memory.create({
        context: { ...channelU1, conversationType: "dm" },
        scope: "private",
        content: "private preference",
        sourceType: "slack-dm",
        sourceId: "D1:1000.000013",
        now,
      }));

      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).toEqual(
        expect.arrayContaining([shared.memoryId, profile.memoryId, task.memoryId]),
      );
      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).not.toContain(
        privateEntry.memoryId,
      );
      expect(
        memory.list({ context: { ...channelU1, conversationType: "dm" }, now }).map((entry) => entry.memoryId),
      ).toContain(privateEntry.memoryId);

      const channelU2: MemoryContext = { ...channelU1, actorUserId: "U2" };
      expect(memory.list({ context: channelU2, now }).map((entry) => entry.memoryId)).not.toContain(
        privateEntry.memoryId,
      );
      expect(
        memory.edit({ context: { ...channelU2, conversationType: "dm" }, memoryId: privateEntry.memoryId, content: "stolen", now }),
      ).toEqual({ kind: "denied", reason: "memory-denied" });

      const supportContext: MemoryContext = {
        workspaceId: "T1",
        actorUserId: "U2",
        profileId: "support",
        conversationType: "channel",
      };
      expect(memory.list({ context: supportContext, now }).map((entry) => entry.memoryId)).toEqual([
        shared.memoryId,
      ]);
      expect(memory.list({ context: { ...channelU1, taskId: "forged-task" }, now })).toEqual([]);

      const edited = memory.edit({ context: channelU1, memoryId: profile.memoryId, content: "updated convention", now });
      expect(edited.kind).toBe("accepted");
      if (edited.kind !== "accepted") throw new Error("memory edit failed");
      expect(edited.memory).toMatchObject({ content: "updated convention", version: 2 });
      expect(memory.forget({ context: channelU1, memoryId: task.memoryId, now })).toEqual({ kind: "accepted" });
      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).not.toContain(task.memoryId);

      expect(store.expireMemory("2026-10-22T00:00:00.000Z")).toBe(3);
      expect(memory.list({ context: channelU1, now: "2026-10-22T00:00:00.000Z" })).toEqual([]);
      expect(store.listAuditRecords().map((record) => record.action)).toEqual(
        expect.arrayContaining([
          "memory.created",
          "memory.updated",
          "memory.forgotten",
          "memory.expired",
          "memory.denied",
        ]),
      );
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-memory-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
