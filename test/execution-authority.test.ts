import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { agentTagConfigSchema, type AgentTagConfig } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import { InteractionWorker } from "../src/interaction-worker.ts";
import { AgentTagStore } from "../src/store/store.ts";

const now = "2026-09-30T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  ...await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json(),
  slack: { workspaceId: "T1", appTokenFile: "/secrets/app", botTokenFile: "/secrets/bot" },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"] },
  routes: [{ conversationId: "C1", profileId: "engineering" }],
});
const profile = config.profiles[0];
if (profile === undefined) throw new Error("missing example profile");
const root = z.string().parse(profile.repositoryRoots[0]);

const revocations: ReadonlyArray<{ name: string; dm?: boolean; change: (input: AgentTagConfig) => void }> = [
  { name: "workspace", change: (input) => { input.slack.workspaceId = "T2"; } },
  { name: "user", change: (input) => { input.access.allowedUserIds = ["U2"]; } },
  { name: "channel", change: (input) => { input.access.allowedChannelIds = ["C2"]; input.routes = []; } },
  { name: "route", change: (input) => { input.routes = []; } },
  { name: "profile", change: (input) => { input.profiles[0]!.id = "replacement"; input.routes[0]!.profileId = "replacement"; } },
  { name: "repository", change: (input) => { input.profiles[0]!.repositoryRoots = ["/repos/replacement"]; } },
  { name: "selected root", change: (input) => { input.profiles[0]!.repositoryRoots.push("/repos/other"); input.routes[0]!.repositoryRoot = "/repos/other"; } },
  { name: "DM owner", dm: true, change: (input) => { const route = input.routes[0]; if (route?.conversationType !== "dm") throw new Error("expected DM"); route.ownerUserId = "U2"; } },
];

for (const revocation of revocations) {
  test(`restart rejects queued turns and approvals after ${revocation.name} revocation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-authority-"));
    const path = join(directory, "agent-tag.sqlite");
    let store = await AgentTagStore.open(path);
    try {
      const conversationId = revocation.dm ? "D1" : "C1";
      const originalConfig = revocation.dm ? agentTagConfigSchema.parse({
        ...config,
        access: { ...config.access, allowedChannelIds: [conversationId] },
        profiles: [{ ...profile, memory: { ...profile.memory, privateDm: true } }],
        routes: [{ conversationId, conversationType: "dm", ownerUserId: "U1", profileId: profile.id }],
      }) : config;
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1", eventKey: "C1:1000.000001", workspaceId: "T1",
        conversationId, threadTs: "1000.000001", actorUserId: "U1",
        conversationType: revocation.dm ? "dm" : "channel", profileId: "engineering", repositoryRoot: root,
        text: "private request canary", receivedAt: now,
      });
      const task = store.getTaskExecution(receipt.taskId);
      const interaction = store.recordPendingInteraction({
        ...receipt, threadId: task.threadId, requestId: "approval-1", kind: "approval",
        prompt: { requestKind: "command" }, conversationId, threadTs: "1000.000001",
        message: () => ({ text: "Approval requested" }), now,
      });
      expect(store.submitInteractionResponse({
        interactionId: interaction.interactionId, workspaceId: "T1", conversationId,
        threadTs: "1000.000001", actorUserId: "U1", sourceActionId: "action-1",
        response: { decision: "accept" }, now,
      }).kind).toBe("accepted");
      store.close();
      store = await AgentTagStore.open(path);
      const changed = structuredClone(originalConfig);
      revocation.change(changed);
      const currentConfig = agentTagConfigSchema.parse(changed);
      let calls = 0;
      const dispatch = async () => { calls++; throw new Error("unauthorized dispatch"); };
      const coordinator = new AgentTagCoordinator({
        config: currentConfig, store, t3: { dispatch, fetchThread: dispatch }, now: () => new Date(now),
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "failed", errorCode: "ExecutionAuthorityDenied" });
      expect(await coordinator.processNext()).toEqual({ kind: "idle" });
      const worker = new InteractionWorker({ config: currentConfig, store, t3: { dispatch }, now: () => new Date(now) });
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "ExecutionAuthorityDenied" });
      expect(await worker.processNext()).toEqual({ kind: "idle" });
      expect(calls).toBe(0);
      const audit = store.listAuditRecords({ limit: 100 });
      expect(audit.filter((row) => JSON.stringify(row.metadata).includes("ExecutionAuthorityDenied"))).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("private request canary");
    } finally {
      store.close();
      await rm(directory, { recursive: true });
    }
  });
}
