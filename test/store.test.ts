import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";

const firstAt = "2026-09-21T00:00:00.000Z";
const beforeExpiry = "2026-09-21T00:00:05.000Z";
const afterExpiry = "2026-09-21T00:00:11.000Z";

function slackEvent(overrides: Partial<SlackEventInput> = {}): SlackEventInput {
  return {
    deliveryId: "delivery-1",
    eventKey: "C1:1000.0001",
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.0001",
    actorUserId: "U1",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text: "Investigate the failure",
    receivedAt: firstAt,
    ...overrides,
  };
}

async function withStore(
  run: (input: { readonly store: AgentTagStore; readonly path: string }) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-store-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run({ store, path });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-store-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("Agent Tag durable store", () => {
  test("deduplicates Slack retries and overlapping event deliveries into one operation", async () => {
    await withStore(async ({ store, path }) => {
      const accepted = store.ingestSlackEvent(slackEvent());
      const sameDelivery = store.ingestSlackEvent(slackEvent());
      const overlappingDelivery = store.ingestSlackEvent(
        slackEvent({ deliveryId: "delivery-2", receivedAt: "2026-09-21T00:00:01.000Z" }),
      );

      expect(accepted.kind).toBe("accepted");
      expect(sameDelivery.kind).toBe("duplicate");
      expect(overlappingDelivery.kind).toBe("duplicate");
      expect(sameDelivery.operationId).toBe(accepted.operationId);
      expect(overlappingDelivery.commandId).toBe(accepted.commandId);
      expect(overlappingDelivery.messageId).toBe(accepted.messageId);
      expect(store.diagnostics()).toEqual({
        events: 1,
        deliveries: 2,
        tasks: 1,
        operations: 1,
        outbox: 0,
        auditRecords: 2,
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  test("recovers an expired lease with stable ids and serializes operations per task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-store-restart-"));
    const path = join(directory, "agent-tag.sqlite");
    let store = await AgentTagStore.open(path);
    try {
      const first = store.ingestSlackEvent(slackEvent());
      store.ingestSlackEvent(
        slackEvent({
          deliveryId: "delivery-2",
          eventKey: "C1:1000.0002",
          text: "Then run the focused tests",
          receivedAt: "2026-09-21T00:00:01.000Z",
        }),
      );
      const claimed = store.claimNextOperation({
        workerId: "worker-a",
        now: firstAt,
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      expect(claimed?.operationId).toBe(first.operationId);
      expect(claimed?.attempt).toBe(1);
      expect(
        store.claimNextOperation({
          workerId: "worker-b",
          now: beforeExpiry,
          leaseMs: 10_000,
          maxConcurrentTasks: 2,
        }),
      ).toBeNull();

      store.close();
      store = await AgentTagStore.open(path);
      const reclaimed = store.claimNextOperation({
        workerId: "worker-b",
        now: afterExpiry,
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      expect(reclaimed).toMatchObject({
        operationId: first.operationId,
        commandId: first.commandId,
        messageId: first.messageId,
        attempt: 2,
      });
      if (reclaimed === null) throw new Error("expired operation lease was not reclaimed");
      store.completeOperation({
        operationId: reclaimed.operationId,
        workerId: "worker-b",
        resultSequence: 42,
        now: "2026-09-21T00:00:12.000Z",
      });
      const second = store.claimNextOperation({
        workerId: "worker-b",
        now: "2026-09-21T00:00:13.000Z",
        leaseMs: 10_000,
        maxConcurrentTasks: 2,
      });
      expect(second?.operationId).not.toBe(first.operationId);
      expect(second?.payload.text).toBe("Then run the focused tests");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-store-restart-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("enforces the global active-task bound", async () => {
    await withStore(({ store }) => {
      store.ingestSlackEvent(slackEvent());
      store.ingestSlackEvent(
        slackEvent({
          deliveryId: "delivery-2",
          eventKey: "C2:2000.0001",
          conversationId: "C2",
          threadTs: "2000.0001",
          receivedAt: "2026-09-21T00:00:01.000Z",
        }),
      );
      const first = store.claimNextOperation({
        workerId: "worker-a",
        now: firstAt,
        leaseMs: 10_000,
        maxConcurrentTasks: 1,
      });
      expect(first).not.toBeNull();
      expect(
        store.claimNextOperation({
          workerId: "worker-b",
          now: beforeExpiry,
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        }),
      ).toBeNull();
      if (first === null) throw new Error("first operation was not claimable");
      store.completeOperation({
        operationId: first.operationId,
        workerId: "worker-a",
        resultSequence: 1,
        now: beforeExpiry,
      });
      expect(
        store.claimNextOperation({
          workerId: "worker-b",
          now: "2026-09-21T00:00:06.000Z",
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        }),
      ).not.toBeNull();
    });
  });

  test("reclaims durable Slack outbox messages without changing their client id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-store-outbox-"));
    const path = join(directory, "agent-tag.sqlite");
    let store = await AgentTagStore.open(path);
    try {
      const receipt = store.ingestSlackEvent(slackEvent());
      const enqueued = store.enqueueOutbox({
        taskId: receipt.taskId,
        correlationId: receipt.operationId,
        conversationId: "C1",
        threadTs: "1000.0001",
        clientMessageId: "agent-tag:operation-1:final",
        payload: { text: "Finished" },
        createdAt: firstAt,
      });
      const duplicate = store.enqueueOutbox({
        taskId: receipt.taskId,
        correlationId: receipt.operationId,
        conversationId: "C1",
        threadTs: "1000.0001",
        clientMessageId: "agent-tag:operation-1:final",
        payload: { text: "Finished" },
        createdAt: firstAt,
      });
      expect(duplicate).toEqual({ kind: "duplicate", outboxId: enqueued.outboxId });
      const firstClaim = store.claimNextOutbox({ workerId: "slack-a", now: firstAt, leaseMs: 10_000 });
      expect(firstClaim?.clientMessageId).toBe("agent-tag:operation-1:final");

      store.close();
      store = await AgentTagStore.open(path);
      expect(
        store.claimNextOutbox({ workerId: "slack-b", now: beforeExpiry, leaseMs: 10_000 }),
      ).toBeNull();
      const reclaimed = store.claimNextOutbox({
        workerId: "slack-b",
        now: afterExpiry,
        leaseMs: 10_000,
      });
      expect(reclaimed).toMatchObject({
        outboxId: enqueued.outboxId,
        clientMessageId: "agent-tag:operation-1:final",
        attempt: 2,
      });
      if (reclaimed === null) throw new Error("expired outbox lease was not reclaimed");
      store.markOutboxDelivered({
        outboxId: reclaimed.outboxId,
        workerId: "slack-b",
        slackMessageTs: "1000.0002",
        now: "2026-09-21T00:00:12.000Z",
      });
      expect(
        store.claimNextOutbox({
          workerId: "slack-b",
          now: "2026-09-21T00:00:13.000Z",
          leaseMs: 10_000,
        }),
      ).toBeNull();
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-store-outbox-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("rolls back partial inbox and lease transitions at deterministic crash points", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-store-fault-"));
    const path = join(directory, "agent-tag.sqlite");
    let faultPoint: string | null = "ingest.after-operation";
    let store = await AgentTagStore.open(path, {
      faultInjector: (point) => {
        if (point === faultPoint) throw new Error(`injected ${point}`);
      },
    });
    try {
      expect(() => store.ingestSlackEvent(slackEvent())).toThrow("injected ingest.after-operation");
      expect(store.diagnostics()).toMatchObject({ events: 0, deliveries: 0, tasks: 0, operations: 0 });

      faultPoint = null;
      const receipt = store.ingestSlackEvent(slackEvent());
      faultPoint = "operation-claim.after-update";
      expect(() =>
        store.claimNextOperation({
          workerId: "worker-a",
          now: firstAt,
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        }),
      ).toThrow("injected operation-claim.after-update");

      store.close();
      store = await AgentTagStore.open(path);
      const claimed = store.claimNextOperation({
        workerId: "worker-b",
        now: beforeExpiry,
        leaseMs: 10_000,
        maxConcurrentTasks: 1,
      });
      expect(claimed).toMatchObject({ operationId: receipt.operationId, attempt: 1 });
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-store-fault-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
