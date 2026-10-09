import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagService, type ServiceLogRecord, type ServiceWorker } from "../src/service.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { createT3GateWorker, T3RuntimeGate } from "../src/t3/gate.ts";
import type { EnvironmentFetch } from "../src/t3/protocol.ts";

interface FakeT3 {
  descriptor: Record<string, unknown> | "down";
  readonly fetch: EnvironmentFetch;
  requests: number;
}

function fakeT3(descriptor: FakeT3["descriptor"] = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1, environmentId: "env-1" }): FakeT3 {
  const fake: FakeT3 = {
    descriptor,
    requests: 0,
    fetch: (async () => {
      fake.requests += 1;
      if (fake.descriptor === "down") throw new TypeError("fetch failed: ECONNREFUSED");
      return Response.json(fake.descriptor);
    }) as unknown as EnvironmentFetch,
  };
  return fake;
}

function gateEvents(logs: readonly ServiceLogRecord[]): string[] {
  return logs.filter((record) => record.event.startsWith("t3.gate.")).map((record) => record.event);
}

describe("T3 runtime gate", () => {
  test("closes on a protocol change, logs each transition once, and reopens", async () => {
    const t3 = fakeT3();
    const logs: ServiceLogRecord[] = [];
    const gate = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: (record) => logs.push(record), fetch: t3.fetch });
    expect(gate.open).toBe(false);
    expect(await gate.check()).toBe(true);
    expect(gate.reason).toBeUndefined();
    expect(await gate.check()).toBe(true);

    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 2 };
    expect(await gate.check()).toBe(false);
    expect(await gate.check()).toBe(false);
    expect(gate.reason).toContain("2");

    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1 };
    expect(await gate.check()).toBe(true);
    expect(gateEvents(logs)).toEqual(["t3.gate.opened", "t3.gate.closed", "t3.gate.opened"]);
  });

  test("an unreachable T3 closes the gate as unreachable", async () => {
    const t3 = fakeT3("down");
    const logs: ServiceLogRecord[] = [];
    const gate = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: (record) => logs.push(record), fetch: t3.fetch });
    expect(await gate.check()).toBe(false);
    expect(gate.reason).toStartWith("unreachable:");
    expect(gateEvents(logs)).toEqual(["t3.gate.closed"]);
  });

  test("external mode ignores serverVersion; managed mode requires the pin", async () => {
    const t3 = fakeT3({ serverVersion: "0.0.44", orchestrationProtocolVersion: 1 });
    const external = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: () => {}, fetch: t3.fetch });
    expect(await external.check()).toBe(true);
    const managed = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", pinnedVersion: "0.0.45", logger: () => {}, fetch: t3.fetch });
    expect(await managed.check()).toBe(false);
    expect(managed.reason).toContain("0.0.44");
  });

  test("managed mode closes when the environment id changes (base dir swapped)", async () => {
    const t3 = fakeT3();
    const gate = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", pinnedVersion: "0.0.45", logger: () => {}, fetch: t3.fetch });
    expect(await gate.check()).toBe(true);
    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1, environmentId: "env-2" };
    expect(await gate.check()).toBe(false);
    expect(gate.reason).toContain("environment id changed");
    // Dropping the id (or sending a malformed one) must not reopen the gate.
    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1 };
    expect(await gate.check()).toBe(false);
    expect(gate.reason).toContain("no environment id");
    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1, environmentId: 42 };
    expect(await gate.check()).toBe(false);
    t3.descriptor = { serverVersion: "0.0.45", orchestrationProtocolVersion: 1, environmentId: "env-1" };
    expect(await gate.check()).toBe(true);
  });

  test("managed mode never opens for a runtime without an environment id; external mode does not need one", async () => {
    const t3 = fakeT3({ serverVersion: "0.0.45", orchestrationProtocolVersion: 1 });
    const managed = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", pinnedVersion: "0.0.45", logger: () => {}, fetch: t3.fetch });
    expect(await managed.check()).toBe(false);
    const external = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: () => {}, fetch: t3.fetch });
    expect(await external.check()).toBe(true);
  });

  test("concurrent checks share one probe", async () => {
    const t3 = fakeT3();
    const gate = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: () => {}, fetch: t3.fetch });
    await Promise.all([gate.check(), gate.check(), gate.check()]);
    expect(t3.requests).toBe(1);
  });

  test("the gate worker probes every minute while open and every 10 s while closed", async () => {
    const t3 = fakeT3();
    let now = 0;
    const gate = new T3RuntimeGate({ baseUrl: "http://127.0.0.1:1", logger: () => {}, fetch: t3.fetch });
    const worker = createT3GateWorker({ gate, now: () => new Date(now) });
    const signal = new AbortController().signal;
    expect(worker.requiresT3).toBe(false);
    expect(await worker.processNext(signal)).toEqual({ kind: "t3-gate-opened" });
    now = 59_000;
    expect(await worker.processNext(signal)).toEqual({ kind: "idle" });
    expect(t3.requests).toBe(1);
    t3.descriptor = { orchestrationProtocolVersion: 2 };
    now = 60_000;
    expect(await worker.processNext(signal)).toEqual({ kind: "t3-gate-closed" });
    t3.descriptor = { orchestrationProtocolVersion: 1 };
    now = 69_000;
    expect(await worker.processNext(signal)).toEqual({ kind: "idle" });
    now = 70_000;
    expect(await worker.processNext(signal)).toEqual({ kind: "t3-gate-opened" });
    expect(t3.requests).toBe(3);
  });
});

async function withStore(run: (store: AgentTagStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-gate-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition did not become true");
}

describe("service gating", () => {
  test("a closed gate pauses T3 workers while the outbox and maintenance keep running; reopening drains", async () => {
    await withStore(async (store) => {
      const gate = { open: false };
      const calls = { coordinator: 0, interaction: 0, schedule: 0, maintenance: 0, outbox: 0 };
      const counting = (key: keyof typeof calls): ServiceWorker => ({
        processNext: async () => {
          calls[key] += 1;
          return { kind: "idle" };
        },
      });
      const service = new AgentTagService({
        store,
        bridge: {
          start: async () => {},
          stop: async () => {},
          deliverNextOutbox: async () => {
            calls.outbox += 1;
            return { kind: "idle" };
          },
        },
        coordinators: [counting("coordinator")],
        interactionWorkers: [counting("interaction")],
        scheduleWorkers: [counting("schedule")],
        maintenanceWorkers: [counting("maintenance")],
        idleMs: 1,
        logger: () => {},
        gate,
      });
      await service.start();
      try {
        await eventually(() => calls.outbox >= 5 && calls.maintenance >= 5);
        expect(calls.coordinator).toBe(0);
        expect(calls.interaction).toBe(0);
        expect(calls.schedule).toBe(0);

        gate.open = true;
        await eventually(() => calls.coordinator >= 1 && calls.interaction >= 1 && calls.schedule >= 1);
      } finally {
        await service.stop();
      }
    });
  });

  test("stop() stops the workers before the managed runtime, and reports its crash loop", async () => {
    await withStore(async (store) => {
      const order: string[] = [];
      let fatalListener: ((error: Error) => void) | undefined;
      let release: (() => void) | undefined;
      const coordinator: ServiceWorker = {
        processNext: (signal) =>
          new Promise((resolve) => {
            release = () => {
              order.push("worker-finished");
              resolve({ kind: "idle" });
            };
            signal.addEventListener("abort", () => setTimeout(() => release?.(), 20), { once: true });
          }),
      };
      const service = new AgentTagService({
        store,
        bridge: { start: async () => {}, stop: async () => {}, deliverNextOutbox: async () => ({ kind: "idle" }) },
        coordinators: [coordinator],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        idleMs: 1,
        logger: () => {},
        runtime: {
          stop: async () => {
            order.push("runtime-stopped");
          },
          onFatal: (listener) => {
            fatalListener = listener;
          },
        },
      });
      const fatal: Error[] = [];
      service.onFatal((error) => fatal.push(error));
      fatalListener?.(new Error("crash loop"));
      expect(fatal.map((error) => error.message)).toEqual(["crash loop"]);

      await service.start();
      await eventually(() => release !== undefined);
      await service.stop();
      expect(order).toEqual(["worker-finished", "runtime-stopped"]);
    });
  });

  test("a bridge start failure still stops the managed runtime", async () => {
    await withStore(async (store) => {
      let stopped = 0;
      const service = new AgentTagService({
        store,
        bridge: {
          start: async () => {
            throw new Error("slack down");
          },
          stop: async () => {},
          deliverNextOutbox: async () => ({ kind: "idle" }),
        },
        coordinators: [{ processNext: async () => ({ kind: "idle" }) }],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        logger: () => {},
        runtime: { stop: async () => void (stopped += 1), onFatal: () => {} },
      });
      await expect(service.start()).rejects.toThrow("slack down");
      expect(stopped).toBe(1);
    });
  });
});
