import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { loadConfig } from "../src/config.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { SlackSocketBridge } from "../src/slack/bridge.ts";
import { requireExecutionAuthority } from "../src/policy/execution.ts";
import { readSecretFile } from "../src/security/secret-file.ts";

const args = z.tuple([z.string().min(1), z.string().min(1), z.string().regex(/^\d+\.\d+$/)]).safeParse(Bun.argv.slice(2));
if (!args.success) {
  throw new Error("Usage: bun run verify:slack-authority -- CONFIG CHANNEL THREAD_TS. Sends one test message to the supplied existing task thread.");
}
const [configPath, conversationId, threadTs] = args.data;
const config = await loadConfig(configPath);
const liveStore = await AgentTagStore.open(join(config.dataDir, "agent-tag.sqlite"));
const target = (() => {
try {
  const binding = liveStore.findActiveTask({ workspaceId: config.slack.workspaceId, conversationId, threadTs });
  if (binding === null || binding.conversationType !== "channel") throw new Error("An existing authorized channel task is required");
  return liveStore.getTaskExecution(binding.taskId);
} finally { liveStore.close(); }
})();
const actorUserId = z.string().parse(config.access.allowedUserIds[0]);
requireExecutionAuthority({ config, task: target, actorUserId });
const token = await readSecretFile(config.slack.botTokenFile);
async function replies() {
  const url = new URL("https://slack.com/api/conversations.replies");
  url.searchParams.set("channel", conversationId);
  url.searchParams.set("ts", threadTs);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { authorization: `Bearer ${token.exposeToBoundary()}` } });
  return z.object({ ok: z.literal(true), has_more: z.boolean().optional(), messages: z.array(z.object({ text: z.string(), ts: z.string() })) }).parse(await response.json());
}
const directory = await mkdtemp(join(tmpdir(), "agent-tag-slack-authority-"));
const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
const deniedMarker = `AGENT_TAG_REVOKED_${crypto.randomUUID()}`;
const allowedMarker = `AGENT_TAG_AUTHORITY_LIVE_${crypto.randomUUID()}`;
try {
  const now = new Date().toISOString();
  const receipt = store.ingestSlackEvent({ deliveryId: crypto.randomUUID(), eventKey: crypto.randomUUID(),
    workspaceId: config.slack.workspaceId, conversationId, threadTs,
    actorUserId, conversationType: "channel", profileId: target.profileId,
    repositoryRoot: target.repositoryRoot, text: "authorized delivery fixture", receivedAt: now,
  });
  function enqueue(marker: string) { store.enqueueOutbox({ taskId: receipt.taskId, correlationId: receipt.operationId,
    conversationId, threadTs, clientMessageId: crypto.randomUUID(),
    payload: { text: marker }, createdAt: new Date().toISOString(),
  }); }
  enqueue(deniedMarker);
  const deniedBridge = await SlackSocketBridge.create({ config: { ...config, routes: [] }, store });
  if (!await deniedBridge.deliverNextOutbox()) throw new Error("denial was not settled");
  const afterDenial = await replies();
  if (afterDenial.has_more || afterDenial.messages.some((message) => message.text.includes(deniedMarker))) throw new Error("denied delivery found or reply scan incomplete");
  const denialRows = store.listAuditRecords().filter((row) => row.action === "slack.outbox.failed" && row.metadata.errorCode === "ExecutionAuthorityDenied");
  if (denialRows.length !== 1) throw new Error("missing durable denial audit");
  enqueue(allowedMarker);
  const allowedBridge = await SlackSocketBridge.create({ config, store });
  if (!await allowedBridge.deliverNextOutbox()) throw new Error("allowed send not settled");
  const afterAllow = await replies();
  if (afterAllow.has_more || afterAllow.messages.filter((message) => message.text === allowedMarker).length !== 1) throw new Error("allowed delivery missing, duplicated, or scan incomplete");
  console.log(JSON.stringify({ actorType: "automated-real", deniedDelivery: "absent", denialAuditRows: denialRows.length, allowedDelivery: "one same-thread message", scope: "isolated fixture store; live task and approvals unchanged" }));
} finally { store.close(); await rm(directory, { recursive: true }); }
