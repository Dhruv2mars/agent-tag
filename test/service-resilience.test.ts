import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { AGENT_TAG_LAUNCHD_LABEL, launchAgentLogPathsForProcess } from "../src/launchd.ts";
import { createAgentTagService, type ServiceLogRecord } from "../src/service.ts";
import { capServiceLog } from "../src/service-logs.ts";
import { readServiceState, ServiceStateRecorder } from "../src/service-state.ts";
import { T3EnvironmentRequestError } from "../src/t3/protocol.ts";
import { type T3StartupWait, waitForReachableT3 } from "../src/t3/startup.ts";

const NOW = new Date("2026-10-21T00:00:00.000Z");
const descriptor = (): Response =>
  new Response(JSON.stringify({ serverVersion: "0.0.45", orchestrationProtocolVersion: 1 }), {
    headers: { "content-type": "application/json" },
  });

/** A loopback port with nothing listening: bind, read the port, close. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("waitForReachableT3", () => {
  test("retries connection failures with doubling backoff, reporting each wait, then returns", async () => {
    const records: ServiceLogRecord[] = [];
    const waits: T3StartupWait[] = [];
    const delays: number[] = [];
    let calls = 0;
    const result = await waitForReachableT3({
      baseUrl: "http://127.0.0.1:37841",
      logger: (record) => records.push(record),
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        if (calls <= 3) throw new Error("Unable to connect");
        return descriptor();
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onWaiting: (wait) => {
        waits.push(wait);
      },
    });
    expect(result).toEqual({ attempts: 4 });
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(waits.map((wait) => [wait.attempts, wait.nextAttemptAt])).toEqual([
      [1, "2026-10-21T00:00:01.000Z"],
      [2, "2026-10-21T00:00:02.000Z"],
      [3, "2026-10-21T00:00:04.000Z"],
    ]);
    expect(waits[0]?.lastError).toBe("Unable to connect");
    expect(records.map((record) => record.event)).toEqual([
      "t3.startup.waiting",
      "t3.startup.waiting",
      "t3.startup.waiting",
      "t3.startup.reachable",
    ]);
    expect(records[0]).toMatchObject({
      level: "warn",
      errorCode: "T3EnvironmentRequestError",
      detail: "T3 is not reachable at http://127.0.0.1:37841 (Unable to connect); retrying in 1 s",
    });
  });

  test("caps the backoff at 60 s and retries 5xx answers", async () => {
    const delays: number[] = [];
    let calls = 0;
    await waitForReachableT3({
      baseUrl: "http://127.0.0.1:37841",
      logger: () => undefined,
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        return calls <= 9 ? new Response("starting", { status: 503 }) : descriptor();
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test("returns at once for a reachable but unusable server, so inspectT3 reports the precise error", async () => {
    const records: ServiceLogRecord[] = [];
    const result = await waitForReachableT3({
      baseUrl: "http://127.0.0.1:37841",
      logger: (record) => records.push(record),
      now: () => NOW,
      fetch: async () => new Response("missing", { status: 404 }),
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    expect(result).toEqual({ attempts: 1 });
    expect(records).toEqual([]);
  });

  test("waits on a real dead port and stops when the signal aborts", async () => {
    const port = await deadPort();
    const controller = new AbortController();
    const waits: T3StartupWait[] = [];
    const startedAt = Date.now();
    const waiting = waitForReachableT3({
      baseUrl: `http://127.0.0.1:${port}`,
      logger: () => undefined,
      now: () => new Date(),
      signal: controller.signal,
      onWaiting: (wait) => {
        waits.push(wait);
        // Second refusal: the 1 s backoff really slept; abort during the 2 s one.
        if (wait.attempts === 2) setTimeout(() => controller.abort(), 50);
      },
    });
    await expect(waiting).rejects.toThrow();
    expect(waits.map((wait) => wait.attempts)).toEqual([1, 2]);
    expect(waits[0]?.baseUrl).toBe(`http://127.0.0.1:${port}`);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("the error it retries is the one a refused connection produces", async () => {
    const port = await deadPort();
    const records: ServiceLogRecord[] = [];
    const controller = new AbortController();
    await expect(
      waitForReachableT3({
        baseUrl: `http://127.0.0.1:${port}`,
        logger: (record) => records.push(record),
        now: () => NOW,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          throw new Error("aborted");
        },
      }),
    ).rejects.toThrow("aborted");
    expect(records[0]?.errorCode).toBe(new T3EnvironmentRequestError("x").name);
  });
});

describe("service state", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-tag-state-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("records waiting, running and stopped, keeping since across repeated waits", async () => {
    let clock = NOW.getTime();
    const recorder = new ServiceStateRecorder({ dataDir, now: () => new Date(clock), pid: process.pid });
    expect(await readServiceState(dataDir)).toBeUndefined();
    const wait = { baseUrl: "http://127.0.0.1:37841", attempts: 1, lastError: "Unable to connect", nextAttemptAt: "x" };
    await recorder.waitingForT3(wait);
    clock += 5_000;
    await recorder.waitingForT3({ ...wait, attempts: 2 });
    expect(await readServiceState(dataDir)).toEqual({
      state: "waiting-for-t3",
      pid: process.pid,
      since: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:05.000Z",
      t3: { ...wait, attempts: 2 },
      alive: true,
    });
    expect((await stat(join(dataDir, "service-state.json"))).mode & 0o777).toBe(0o600);
    await recorder.running();
    expect(await readServiceState(dataDir)).toMatchObject({ state: "running", since: "2026-10-21T00:00:05.000Z", alive: true });
    expect((await readServiceState(dataDir))?.t3).toBeUndefined();
    await recorder.stopped();
    expect(await readServiceState(dataDir)).toMatchObject({ state: "stopped", alive: false });
  });

  test("a record left by a dead process is not alive, and junk reads as no record", async () => {
    await new ServiceStateRecorder({ dataDir, now: () => NOW, pid: 99_999 }).running();
    expect(await readServiceState(dataDir, () => false)).toMatchObject({ state: "running", alive: false });
    await writeFile(join(dataDir, "service-state.json"), "{not json");
    expect(await readServiceState(dataDir)).toBeUndefined();
  });
});

describe("service log cap", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-tag-logs-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("keeps the last whole lines in .1 and truncates in place, so an O_APPEND writer restarts at 0", async () => {
    const path = join(directory, "service.stderr.log");
    const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, "0")}`);
    await writeFile(path, `${lines.join("\n")}\n`);
    // launchd's descriptor: opened for append before the cap runs.
    const writer = await open(path, "a");
    try {
      expect(await capServiceLog(path, { maxBytes: 4_096, keepBytes: 1_000 })).toEqual({ rotated: false, bytes: 1_800 });
      await appendFile(path, `${lines.join("\n")}\n`.repeat(2));
      const result = await capServiceLog(path, { maxBytes: 4_096, keepBytes: 100 });
      expect(result).toEqual({ rotated: true, bytes: 5_400 });
      expect(await readFile(`${path}.1`, "utf8")).toBe(`${lines.slice(-11).join("\n")}\n`);
      expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
      expect((await stat(path)).size).toBe(0);
      await writer.write("after rotation\n");
      expect(await readFile(path, "utf8")).toBe("after rotation\n");
    } finally {
      await writer.close();
    }
    expect(await capServiceLog(join(directory, "missing.log"))).toEqual({ rotated: false, bytes: 0 });
  });

  test("only the LaunchAgent process caps the launchd logs", () => {
    expect(launchAgentLogPathsForProcess({})).toEqual([]);
    expect(launchAgentLogPathsForProcess({ XPC_SERVICE_NAME: "com.example.other" })).toEqual([]);
    const paths = launchAgentLogPathsForProcess({ XPC_SERVICE_NAME: AGENT_TAG_LAUNCHD_LABEL });
    expect(paths.map((path) => path.split("/").slice(-3).join("/"))).toEqual([
      "Logs/AgentTag/service.stdout.log",
      "Logs/AgentTag/service.stderr.log",
    ]);
  });
});

describe("createAgentTagService with T3 down", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-tag-down-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("waits for T3 instead of throwing, records the wait, and exits on abort", async () => {
    const port = await deadPort();
    const dataDir = join(root, "data");
    const repository = join(root, "repo");
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(repository);
    for (const name of ["t3-token", "app-token", "bot-token"]) await writeFile(join(root, name), "fixture\n", { mode: 0o600 });
    const configPath = join(root, "agent-tag.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      dataDir,
      t3: { baseUrl: `http://127.0.0.1:${port}`, tokenFile: join(root, "t3-token") },
      slack: { workspaceId: "T0FIXTURE", appTokenFile: join(root, "app-token"), botTokenFile: join(root, "bot-token") },
      access: { allowedUserIds: ["U0FIXTURE"], allowedChannelIds: ["C0FIXTURE"] },
      profiles: [{
        id: "default",
        repositoryRoots: [repository],
        defaultProviderInstanceId: "codex",
        defaultModel: "gpt-5.6-sol",
        runtimeMode: "approval-required",
        isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
        externalWrites: { mode: "deny" },
        memory: { shared: true, privateDm: false, retentionDays: 30 },
      }],
      routes: [{ conversationId: "C0FIXTURE", profileId: "default" }],
      limits: { maxConcurrentTasks: 1 },
    }));
    const config = await loadConfig(configPath);
    const controller = new AbortController();
    const records: ServiceLogRecord[] = [];
    const state = new ServiceStateRecorder({ dataDir, now: () => new Date() });
    const starting = createAgentTagService({
      config,
      signal: controller.signal,
      state,
      logger: (record) => {
        records.push(record);
        if (record.event === "t3.startup.waiting") setTimeout(() => controller.abort(), 100);
      },
    });
    await expect(starting).rejects.toThrow();
    expect(records.map((record) => record.event)).toContain("t3.startup.waiting");
    expect(await readServiceState(dataDir)).toMatchObject({
      state: "waiting-for-t3",
      t3: { baseUrl: `http://127.0.0.1:${port}`, attempts: 1 },
      alive: true,
    });
  });
});
