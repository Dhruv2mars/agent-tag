import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import {
  AgentTagService,
  allowedModelLogRecords,
  type ServiceLogRecord,
  type ServiceSlackBridge,
  type ServiceWorker,
} from "../src/service.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { t3ServerConfigSchema } from "../src/t3/gateway.ts";

async function eventually(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition did not become true");
}

async function withStore(
  run: (store: AgentTagStore, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-service-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run(store, path);
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-service-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("Agent Tag service", () => {
  test("runs independent coordinator, interaction, and outbox loops and stops cleanly", async () => {
    await withStore(async (store) => {
      const calls = {
        coordinator: 0,
        interaction: 0,
        schedule: 0,
        maintenance: 0,
        delivery: 0,
        bridgeStart: 0,
        bridgeStop: 0,
      };
      const coordinator: ServiceWorker = {
        processNext: async () => {
          calls.coordinator += 1;
          return { kind: calls.coordinator === 1 ? "completed" : "idle" };
        },
      };
      const interaction: ServiceWorker = {
        processNext: async () => {
          calls.interaction += 1;
          return { kind: calls.interaction === 1 ? "resolved" : "idle" };
        },
      };
      const maintenance: ServiceWorker = {
        processNext: async () => {
          calls.maintenance += 1;
          return { kind: calls.maintenance === 1 ? "memory-expired" : "idle" };
        },
      };
      const schedule: ServiceWorker = {
        processNext: async () => {
          calls.schedule += 1;
          return { kind: calls.schedule === 1 ? "dispatched" : "idle" };
        },
      };
      const bridge: ServiceSlackBridge = {
        start: async () => {
          calls.bridgeStart += 1;
        },
        stop: async () => {
          calls.bridgeStop += 1;
        },
        deliverNextOutbox: async () => {
          calls.delivery += 1;
          return { kind: calls.delivery === 1 ? "delivered" : "idle" };
        },
      };
      const logs: ServiceLogRecord[] = [];
      const service = new AgentTagService({
        store,
        bridge,
        coordinators: [coordinator],
        interactionWorkers: [interaction],
        scheduleWorkers: [schedule],
        maintenanceWorkers: [maintenance],
        idleMs: 1,
        logger: (record) => logs.push(record),
      });
      await service.start();
      await eventually(
        () =>
          calls.coordinator >= 2 &&
          calls.interaction >= 2 &&
          calls.schedule >= 2 &&
          calls.maintenance >= 2 &&
          calls.delivery >= 2,
      );
      await service.stop();

      expect(calls.bridgeStart).toBe(1);
      expect(calls.bridgeStop).toBe(1);
      expect(logs.map((record) => record.event)).toContain("service.started");
      expect(logs.map((record) => record.event)).toContain("service.stopped");
      expect(logs.filter((record) => record.event === "worker.outcome")).toHaveLength(5);
    });
  });

  test("contains a worker failure and retries without logging its message", async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const worker: ServiceWorker = {
        processNext: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("secret-canary-must-not-appear");
          return { kind: "idle" };
        },
      };
      const bridge: ServiceSlackBridge = {
        start: async () => {},
        stop: async () => {},
        deliverNextOutbox: async () => ({ kind: "idle" }),
      };
      const logs: ServiceLogRecord[] = [];
      const service = new AgentTagService({
        store,
        bridge,
        coordinators: [worker],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        idleMs: 1,
        logger: (record) => logs.push(record),
      });
      await service.start();
      await eventually(() => attempts >= 2);
      await service.stop();

      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain("secret-canary-must-not-appear");
      expect(logs).toContainEqual(
        expect.objectContaining({ event: "worker.failed", worker: "coordinator-1", errorCode: "Error" }),
      );
    });
  });

  test("yields between retry-scheduled outcomes instead of spinning", async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const retrying: ServiceWorker = {
        processNext: async () => {
          attempts += 1;
          // Yield a macrotask so a non-sleeping loop fails the bound below instead of starving timers.
          await Bun.sleep(0);
          return { kind: "retry-scheduled" };
        },
      };
      const service = new AgentTagService({
        store,
        bridge: { start: async () => {}, stop: async () => {}, deliverNextOutbox: async () => ({ kind: "idle" }) },
        coordinators: [{ processNext: async () => ({ kind: "idle" }) }],
        interactionWorkers: [retrying],
        idleMs: 20,
        logger: () => {},
      });
      await service.start();
      await Bun.sleep(110);
      await service.stop();
      // About one attempt per idle interval; a loop that does not sleep would run thousands of times.
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(10);
    });
  });

  test("stop releases a coordinator lease promptly while a T3 turn is still unsettled", async () => {
    await withStore(async (store, path) => {
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
        limits: { maxConcurrentTasks: 1, stalledTurn: { timeoutSeconds: 3_600, retryDelaySeconds: 10, maxAttempts: 2 } },
      });
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
        receivedAt: new Date().toISOString(),
        sourceOrderKey: "1000.000001",
      });
      let polls = 0;
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        workerId: "coordinator-a",
        pollMs: 60_000,
        t3: {
          dispatch: async () => ({ sequence: 1 }),
          // The turn never settles: each poll hangs until the caller gives up.
          fetchThread: (_threadId, signal) => {
            polls += 1;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
            });
          },
        },
      });
      const service = new AgentTagService({
        store,
        bridge: { start: async () => {}, stop: async () => {}, deliverNextOutbox: async () => ({ kind: "idle" }) },
        coordinators: [coordinator],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        idleMs: 1,
        logger: () => {},
      });
      await service.start();
      await eventually(() => polls >= 1);

      const startedStop = Date.now();
      const stopped = await Promise.race([
        service.stop().then(() => "stopped" as const),
        Bun.sleep(2_000).then(() => "timed-out" as const),
      ]);
      expect(stopped).toBe("stopped");
      expect(Date.now() - startedStop).toBeLessThan(2_000);

      const reopened = await AgentTagStore.open(path);
      try {
        const resumed = reopened.claimNextOperation({
          workerId: "coordinator-b",
          now: new Date().toISOString(),
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        });
        expect(resumed).toMatchObject({
          operationId: receipt.operationId,
          commandId: receipt.commandId,
          attempt: 1,
        });
        expect(reopened.operationalStatus(new Date().toISOString()).operations.stalledFailed).toBe(0);
      } finally {
        reopened.close();
      }
    });
  });

  test("closes shared resources after its loops stop, before a stop that never started, and when start fails", async () => {
    const bridge = (start: () => Promise<void> = async () => {}): ServiceSlackBridge => ({
      start,
      stop: async () => {},
      deliverNextOutbox: async () => ({ kind: "idle" }),
    });
    const idle: ServiceWorker = { processNext: async () => ({ kind: "idle" }) };
    await withStore(async (store) => {
      const events: string[] = [];
      const service = new AgentTagService({
        store,
        bridge: bridge(),
        coordinators: [
          {
            processNext: async (signal) => {
              await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
              events.push("loop-stopped");
              return { kind: "idle" };
            },
          },
        ],
        interactionWorkers: [idle],
        resources: [
          { close: async () => void events.push("closed") },
          { close: async () => Promise.reject(new Error("close-canary")) },
        ],
        idleMs: 1,
        logger: () => undefined,
      });
      await service.start();
      await service.stop();
      expect(events).toEqual(["loop-stopped", "closed"]);
    });
    await withStore(async (store) => {
      let closed = 0;
      const service = new AgentTagService({
        store,
        bridge: bridge(),
        coordinators: [idle],
        interactionWorkers: [idle],
        resources: [{ close: async () => void (closed += 1) }] });
      await service.stop();
      await service.stop();
      expect(closed).toBe(1);
    });
    await withStore(async (store) => {
      let closed = 0;
      const service = new AgentTagService({
        store,
        bridge: bridge(async () => Promise.reject(new Error("slack down"))),
        coordinators: [idle],
        interactionWorkers: [idle],
        resources: [{ close: async () => void (closed += 1) }],
      });
      await expect(service.start()).rejects.toThrow("slack down");
      expect(closed).toBe(1);
    });
  });
});

describe("startup model report", () => {
  test("logs one warning per allowed model T3 cannot run, and nothing when all are available", async () => {
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
          defaultProviderInstanceId: "codex",
          defaultModel: "gpt-5.6-sol",
          runtimeMode: "approval-required",
          isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
          externalWrites: { mode: "deny" },
          memory: { shared: true, privateDm: false, retentionDays: 180 },
          allowedModels: [
            { instanceId: "codex", model: "gpt-5.6-mini" },
            { instanceId: "grok", model: "grok-5" },
          ],
        },
      ],
      routes: [{ conversationId: "C1", profileId: "engineering" }],
      limits: { maxConcurrentTasks: 1 },
    });
    const server = t3ServerConfigSchema.parse(
      await Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json(),
    );
    const at = "2026-10-08T00:00:00.000Z";
    expect(allowedModelLogRecords(config, server, at)).toEqual([]);
    const withoutGrok = { ...server, providers: server.providers.filter((provider) => provider.instanceId !== "grok") };
    expect(allowedModelLogRecords(config, withoutGrok, at)).toEqual([{
      level: "warn",
      event: "provider.allowed-model",
      errorCode: "provider-missing",
      profileId: "engineering",
      instanceId: "grok",
      model: "grok-5",
      at,
    }]);
  });
});
