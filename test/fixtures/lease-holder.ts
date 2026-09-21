import { z } from "zod";

import { AgentTagStore } from "../../src/store/store.ts";

const databasePath = z.string().min(1).parse(process.argv[2]);
const claimedAt = "2026-09-21T00:00:00.000Z";
const store = await AgentTagStore.open(databasePath);
const receipt = store.ingestSlackEvent({
  deliveryId: "process-kill-delivery",
  eventKey: "C1:3000.0001",
  workspaceId: "T1",
  conversationId: "C1",
  threadTs: "3000.0001",
  actorUserId: "U1",
  profileId: "engineering",
  repositoryRoot: "/srv/repos/example",
  text: "Hold this lease until the process dies",
  receivedAt: claimedAt,
  sourceOrderKey: "3000.0001",
});
const claim = store.claimNextOperation({
  workerId: "killed-worker",
  now: claimedAt,
  leaseMs: 10_000,
  maxConcurrentTasks: 1,
});
if (claim === null) throw new Error("process-kill fixture could not claim its operation");
console.log(
  JSON.stringify({
    operationId: receipt.operationId,
    commandId: receipt.commandId,
    messageId: receipt.messageId,
    attempt: claim.attempt,
  }),
);
await new Promise<never>(() => undefined);
