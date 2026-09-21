import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentTagService,
  type ServiceLogRecord,
  type ServiceSlackBridge,
  type ServiceWorker,
} from "../src/service.ts";
import { AgentTagStore } from "../src/store/store.ts";

async function eventually(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition did not become true");
}

async function withStore(run: (store: AgentTagStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-service-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    await run(store);
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
      const bridge: ServiceSlackBridge = {
        start: async () => {
          calls.bridgeStart += 1;
        },
        stop: async () => {
          calls.bridgeStop += 1;
        },
        deliverNextOutbox: async () => {
          calls.delivery += 1;
          return calls.delivery === 1;
        },
      };
      const logs: ServiceLogRecord[] = [];
      const service = new AgentTagService({
        store,
        bridge,
        coordinators: [coordinator],
        interactionWorkers: [interaction],
        maintenanceWorkers: [maintenance],
        idleMs: 1,
        logger: (record) => logs.push(record),
      });
      await service.start();
      await eventually(
        () => calls.coordinator >= 2 && calls.interaction >= 2 && calls.maintenance >= 2 && calls.delivery >= 2,
      );
      await service.stop();

      expect(calls.bridgeStart).toBe(1);
      expect(calls.bridgeStop).toBe(1);
      expect(logs.map((record) => record.event)).toContain("service.started");
      expect(logs.map((record) => record.event)).toContain("service.stopped");
      expect(logs.filter((record) => record.event === "worker.outcome")).toHaveLength(4);
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
        deliverNextOutbox: async () => false,
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
});
