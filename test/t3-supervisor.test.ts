import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServiceLogRecord } from "../src/service.ts";
import { type EnvironmentFetch, T3ProtocolMismatchError, T3ServerVersionMismatchError } from "../src/t3/protocol.ts";
import {
  defaultT3Spawn,
  isManagedServeCommand,
  managedT3Environment,
  redactT3Output,
  T3CrashLoopError,
  T3ManagedRuntime,
  type T3ManagedRuntimeOptions,
  T3PortInUseError,
  type T3RuntimeTiming,
  T3StartupError,
} from "../src/t3/supervisor.ts";
import { FAKE_PAIRING_TOKEN, FAKE_T3_BINARY } from "./fixtures/fake-t3/index.ts";

const FAST: Partial<T3RuntimeTiming> = {
  readyTimeoutMs: 10_000,
  readyPollMs: 25,
  stopTimeoutMs: 2_000,
  orphanTimeoutMs: 2_000,
};

const runtimes: T3ManagedRuntime[] = [];
const strays: number[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("no port");
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition did not become true");
}

interface Harness {
  readonly root: string;
  readonly port: number;
  readonly homeDir: string;
  readonly runtimeDir: string;
  readonly controlFile: string;
  readonly logs: ServiceLogRecord[];
  control(value: Record<string, unknown>): Promise<void>;
  runtime(overrides?: Partial<T3ManagedRuntimeOptions>): T3ManagedRuntime;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "agent-tag-t3-supervisor-"));
  await chmod(root, 0o700);
  const port = await freePort();
  const homeDir = join(root, "home");
  const runtimeDir = join(root, "runtime");
  const controlFile = join(root, "control.json");
  const logs: ServiceLogRecord[] = [];
  const control = (value: Record<string, unknown>): Promise<void> => writeFile(controlFile, JSON.stringify(value));
  await control({});
  return {
    root,
    port,
    homeDir,
    runtimeDir,
    controlFile,
    logs,
    control,
    runtime(overrides = {}) {
      const runtime = new T3ManagedRuntime({
        settings: { port, homeDir, runtimeDir },
        installed: { binary: FAKE_T3_BINARY, version: "0.0.45" },
        logger: (record) => logs.push(record),
        env: { ...process.env, FAKE_T3_CONTROL: controlFile, AGENT_TAG_CONFIG: "/secret/config.json", T3CODE_DEV_AUTH_TOKEN: "dev-token" },
        timing: FAST,
        ...overrides,
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

describe("managed T3 supervisor", () => {
  test("starts t3 serve, gates on the descriptor and server-runtime.json, and stops it", async () => {
    const h = await harness();
    const envFile = join(h.root, "env.json");
    await h.control({ envFile });
    const runtime = h.runtime();
    const descriptor = await runtime.start();
    expect(descriptor).toEqual({ serverVersion: "0.0.45", orchestrationProtocol: 1, environmentId: "env-fake-1" });
    const status = runtime.status();
    expect(status.state).toBe("ready");
    expect(status.restarts).toBe(0);
    const pid = status.pid ?? 0;
    expect(alive(pid)).toBe(true);
    const runtimeFile = JSON.parse(await readFile(join(h.homeDir, "userdata", "server-runtime.json"), "utf8"));
    expect(runtimeFile.pid).toBe(pid);
    const state = JSON.parse(await readFile(join(h.runtimeDir, "state.json"), "utf8"));
    expect(state.highestVersionStarted).toBe("0.0.45");

    const env = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(env.T3CODE_HOME).toBe(h.homeDir);
    expect(env.T3CODE_NO_BROWSER).toBe("1");
    expect(env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).toBe("0");
    expect(env.T3CODE_DEV_AUTH_TOKEN).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.startsWith("AGENT_TAG_"))).toEqual([]);
    expect(env.PATH).toBe(process.env.PATH ?? "");

    await runtime.stop();
    expect(runtime.status().state).toBe("stopped");
    expect(alive(pid)).toBe(false);
    expect(h.logs.map((record) => record.event)).toEqual(expect.arrayContaining(["t3.runtime.started", "t3.runtime.stopped"]));
  });

  test("never logs the pairing credential T3 prints on stdout and stderr", async () => {
    const h = await harness();
    const runtime = h.runtime();
    await runtime.start();
    await eventually(() => h.logs.some((record) => record.detail === "fake t3 serve starting"));
    await runtime.stop();
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain(FAKE_PAIRING_TOKEN);
    expect(serialized).not.toContain("Pair a browser");
    const stderr = h.logs.filter((record) => record.event === "t3.runtime.stderr").map((record) => record.detail);
    expect(stderr).toContain("pairing link http://127.0.0.1:" + h.port + "/pair#token=[REDACTED]");
  });

  test("refuses a runtime that reports another orchestration protocol and leaves nothing running", async () => {
    const h = await harness();
    await h.control({ protocol: 2 });
    const runtime = h.runtime();
    await expect(runtime.start()).rejects.toBeInstanceOf(T3ProtocolMismatchError);
    expect(runtime.status().state).toBe("stopped");
    const runtimeFile = JSON.parse(await readFile(join(h.homeDir, "userdata", "server-runtime.json"), "utf8"));
    expect(alive(runtimeFile.pid)).toBe(false);
  });

  test("refuses a runtime that reports a version other than the pin", async () => {
    const h = await harness();
    await h.control({ serverVersion: "0.0.44" });
    const error = await h.runtime().start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(T3ServerVersionMismatchError);
    expect((error as Error).message).toContain("0.0.44");
  });

  test("refuses to start when a foreign server already answers on the port", async () => {
    const h = await harness();
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: h.port, fetch: () => new Response("hi") });
    try {
      await expect(h.runtime().start()).rejects.toBeInstanceOf(T3PortInUseError);
    } finally {
      await foreign.stop(true);
    }
  });

  test("an early exit becomes a startup error carrying redacted stderr", async () => {
    const h = await harness();
    await h.control({ exitAtStartup: 3 });
    const error = await h.runtime().start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(T3StartupError);
    const message = (error as Error).message;
    expect(message).toContain("exit code 3");
    expect(message).toContain("fake t3 serve starting");
    expect(message).not.toContain(FAKE_PAIRING_TOKEN);
  });

  for (const detached of [false, true]) {
    test(`an early exit is reported promptly while a ${detached ? "detached" : "group"} descendant holds stderr`, async () => {
      const h = await harness();
      const descendantPidFile = join(h.root, "descendant.pid");
      await h.control({ exitAtStartup: 3, descendantPidFile, descendantDetached: detached });
      const started = Date.now();
      const error = await h.runtime().start().catch((caught: unknown) => caught);
      const descendant = Number(await readFile(descendantPidFile, "utf8"));
      strays.push(descendant);
      expect(error).toBeInstanceOf(T3StartupError);
      expect((error as Error).message).toContain("exit code 3");
      // Well inside the 10 s ready timeout and the descendant's 30 s sleep.
      expect(Date.now() - started).toBeLessThan(6_000);
      // A descendant in T3's group dies with it; one that left the group is out of reach and only bounded.
      if (!detached) await eventually(() => !alive(descendant), 2_000);
    });
  }

  test("does not report ready until server-runtime.json names the spawned pid", async () => {
    const h = await harness();
    await h.control({ runtimePid: 1 });
    const error = await h.runtime({ timing: { ...FAST, readyTimeoutMs: 600 } }).start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(T3StartupError);
    expect((error as Error).message).toContain("did not become ready");
  });

  test("reaps its own orphaned t3 serve but leaves a foreign pid alone", async () => {
    const h = await harness();
    await mkdir(h.homeDir, { recursive: true, mode: 0o700 });
    await mkdir(h.runtimeDir, { recursive: true, mode: 0o700 });
    // An orphan from an Agent Tag that was SIGKILLed: same binary, same --base-dir.
    const orphan = defaultT3Spawn(
      [FAKE_T3_BINARY, "serve", "--host", "127.0.0.1", "--port", String(h.port), "--base-dir", h.homeDir],
      { cwd: h.homeDir, env: { ...managedT3Environment(process.env, h.homeDir), FAKE_T3_CONTROL: h.controlFile } },
    );
    strays.push(orphan.pid);
    await eventually(async () => (await readFile(join(h.homeDir, "userdata", "server-runtime.json"), "utf8").catch(() => "")).includes(String(orphan.pid)));
    // A foreign process recorded in supervised.json (e.g. a recycled pid) must survive.
    const foreign = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    strays.push(foreign.pid);
    await writeFile(join(h.runtimeDir, "supervised.json"), JSON.stringify({ pid: foreign.pid }));

    // The fake CLI runs as `bun fake-t3.ts ...`; report the command line real T3 shows (`<binary> serve ...`).
    const serveArgs = `${FAKE_T3_BINARY} serve --host 127.0.0.1 --port ${h.port} --base-dir ${h.homeDir}`;
    const runtime = h.runtime({ processArgs: async (pid) => (pid === orphan.pid ? serveArgs : `sleep 30`) });
    await runtime.start();
    expect(alive(orphan.pid)).toBe(false);
    expect(alive(foreign.pid)).toBe(true);
    expect(runtime.status().pid).not.toBe(orphan.pid);
    expect(h.logs.filter((record) => record.event === "t3.runtime.orphan_reaped").map((record) => record.detail)).toEqual([
      `pid ${orphan.pid} from a previous Agent Tag run`,
    ]);
  });

  test("leaves a foreign executable alone even when it runs serve with our base dir", async () => {
    const h = await harness();
    await mkdir(h.runtimeDir, { recursive: true, mode: 0o700 });
    const foreign = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    strays.push(foreign.pid);
    await writeFile(join(h.runtimeDir, "supervised.json"), JSON.stringify({ pid: foreign.pid }));
    const runtime = h.runtime({
      processArgs: async () => `/usr/local/bin/other-server serve --host 127.0.0.1 --port ${h.port} --base-dir ${h.homeDir}`,
    });
    await runtime.start();
    expect(alive(foreign.pid)).toBe(true);
    expect(h.logs.map((record) => record.event)).not.toContain("t3.runtime.orphan_reaped");
  });

  test("a failure writing supervisor bookkeeping kills the spawned child", async () => {
    const h = await harness();
    // A non-empty directory where supervised.json goes makes the atomic rename fail after spawn.
    await mkdir(join(h.runtimeDir, "supervised.json", "blocker"), { recursive: true });
    await chmod(h.runtimeDir, 0o700);
    const spawned: number[] = [];
    const runtime = h.runtime({
      spawn: (command, options) => {
        const child = defaultT3Spawn(command, options);
        spawned.push(child.pid);
        return child;
      },
    });
    await expect(runtime.start()).rejects.toThrow();
    expect(spawned).toHaveLength(1);
    expect(alive(spawned[0] ?? 0)).toBe(false);
    expect(runtime.status().state).toBe("stopped");
  });

  test("restarts a crashed runtime with exponential backoff and gives up after the crash budget", async () => {
    const h = await harness();
    const delays: number[] = [];
    const fatal: Error[] = [];
    const states: string[] = [];
    const runtime = h.runtime({
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        await Bun.sleep(1);
      },
      timing: { ...FAST, maxRestarts: 3, backoffBaseMs: 1_000, backoffMaxMs: 3_000 },
    });
    runtime.onFatal((error) => fatal.push(error));
    runtime.onStateChange((state) => states.push(state));
    await runtime.start();

    for (let crash = 1; crash <= 3; crash += 1) {
      const pid = runtime.status().pid ?? 0;
      process.kill(pid, "SIGKILL");
      await eventually(() => runtime.status().state === "ready" && runtime.status().pid !== pid);
      expect(runtime.status().restarts).toBe(crash);
    }
    // Readiness polling sleeps too; the backoff sleeps are the 1 s, 2 s and capped 3 s ones.
    expect(delays.filter((delay) => delay >= 1_000)).toEqual([1_000, 2_000, 3_000]);
    expect(h.logs.filter((record) => record.event === "t3.runtime.restarted")).toHaveLength(3);
    expect(states).toContain("restarting");

    process.kill(runtime.status().pid ?? 0, "SIGKILL");
    await eventually(() => fatal.length === 1);
    expect(fatal[0]).toBeInstanceOf(T3CrashLoopError);
    expect(runtime.status().state).toBe("failed");
    expect(h.logs.map((record) => record.event)).toContain("t3.runtime.crashloop");
    // A listener registered after the crash loop (e.g. once slow Slack startup finishes) still hears it.
    const late: Error[] = [];
    runtime.onFatal((error) => late.push(error));
    expect(late).toEqual([fatal[0] as Error]);
  });

  /** A real descriptor fetch that, while armed, SIGKILLs T3 once its answer is in hand (dies mid-readiness). */
  function killingFetch(target: () => T3ManagedRuntime): { armed: boolean; readonly fetch: EnvironmentFetch } {
    const control = {
      armed: false,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, init);
        if (control.armed) {
          control.armed = false;
          const runtime = target();
          const pid = runtime.status().pid ?? 0;
          process.kill(pid, "SIGKILL");
          await eventually(() => runtime.status().pid === undefined);
        }
        return response;
      }) as unknown as EnvironmentFetch,
    };
    return control;
  }

  test("a child that dies while readiness is being confirmed fails start instead of reporting ready", async () => {
    const h = await harness();
    let runtime: T3ManagedRuntime | undefined;
    const killer = killingFetch(() => runtime as T3ManagedRuntime);
    killer.armed = true;
    runtime = h.runtime({ fetch: killer.fetch });
    const error = await runtime.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(T3StartupError);
    expect((error as Error).message).toContain("before becoming ready");
    expect(runtime.status().state).toBe("stopped");
  });

  test("a replacement that dies while readiness is being confirmed is retried, not left as a dead ready", async () => {
    const h = await harness();
    let runtime: T3ManagedRuntime | undefined;
    const killer = killingFetch(() => runtime as T3ManagedRuntime);
    runtime = h.runtime({ fetch: killer.fetch, sleep: async () => Bun.sleep(1) });
    await runtime.start();
    killer.armed = true;
    const first = runtime.status().pid ?? 0;
    process.kill(first, "SIGKILL");
    await eventually(() => runtime.status().state === "ready" && runtime.status().pid !== undefined && runtime.status().pid !== first);
    expect(alive(runtime.status().pid ?? 0)).toBe(true);
    expect(runtime.status().restarts).toBe(2);
    expect(h.logs.map((record) => record.event)).toContain("t3.runtime.restart_failed");
  });

  test("a restart that hits a protocol change fails instead of looping", async () => {
    const h = await harness();
    const fatal: Error[] = [];
    const runtime = h.runtime({ sleep: async () => Bun.sleep(1) });
    runtime.onFatal((error) => fatal.push(error));
    await runtime.start();
    await h.control({ protocol: 2 });
    process.kill(runtime.status().pid ?? 0, "SIGKILL");
    await eventually(() => fatal.length === 1);
    expect(fatal[0]).toBeInstanceOf(T3ProtocolMismatchError);
    expect(runtime.status().state).toBe("failed");
  });

  test("stop escalates to SIGKILL when T3 ignores SIGTERM", async () => {
    const h = await harness();
    await h.control({ ignoreSigterm: true });
    const runtime = h.runtime({ timing: { ...FAST, stopTimeoutMs: 300 } });
    await runtime.start();
    const pid = runtime.status().pid ?? 0;
    await runtime.stop();
    expect(alive(pid)).toBe(false);
    expect(h.logs.map((record) => record.event)).toContain("t3.runtime.kill");
  });

  test("refuses to start an older T3 against a home a newer one migrated", async () => {
    const h = await harness();
    await mkdir(h.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(h.runtimeDir, "state.json"), JSON.stringify({ highestVersionStarted: "0.0.46" }));
    await expect(h.runtime().start()).rejects.toThrow("migrates its database forward only");
  });
});

describe("managed T3 helpers", () => {
  test("the environment drops AGENT_TAG_* and T3CODE_* and sets the managed home", () => {
    expect(
      managedT3Environment(
        { HOME: "/h", PATH: "/bin", AGENT_TAG_X: "1", T3CODE_TAILSCALE_SERVE: "1", T3CODE_HOME: "/desktop", UNSET: undefined },
        "/data/t3/home",
      ),
    ).toEqual({
      HOME: "/h",
      PATH: "/bin",
      T3CODE_HOME: "/data/t3/home",
      T3CODE_NO_BROWSER: "1",
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    });
  });

  test("stderr redaction covers pairing links, tickets, bearer tokens and token fields", () => {
    expect(redactT3Output("open http://127.0.0.1:1/pair#token=abc123")).toBe("open http://127.0.0.1:1/pair#token=[REDACTED]");
    expect(redactT3Output("ws://x/ws?wsTicket=zzz&a=1")).toBe("ws://x/ws?wsTicket=[REDACTED]&a=1");
    expect(redactT3Output("Authorization: Bearer abc.def")).not.toContain("abc.def");
    expect(redactT3Output('{"token":"s3cr3t"}')).not.toContain("s3cr3t");
  });

  test("orphan matching requires our executable, serve, and our exact base dir", () => {
    const owner = { homeDir: "/data/home", runtimeDir: "/data/rt", binary: "/data/rt/versions/0.0.45/t3" };
    expect(isManagedServeCommand("/data/rt/versions/0.0.45/t3 serve --host 127.0.0.1 --port 1 --base-dir /data/home", owner)).toBe(true);
    // An orphan from the previous pinned version (before an upgrade) is still ours.
    expect(isManagedServeCommand("/data/rt/versions/0.0.44/t3 serve --base-dir /data/home", owner)).toBe(true);
    expect(isManagedServeCommand("/usr/local/bin/other-server serve --base-dir /data/home", owner)).toBe(false);
    expect(isManagedServeCommand("/data/rt/versions/0.0.45/t3-evil serve --base-dir /data/home", owner)).toBe(false);
    expect(isManagedServeCommand("/data/rt/versions/0.0.45/t3 serve --base-dir /data/home2", owner)).toBe(false);
    expect(isManagedServeCommand("/data/rt/versions/0.0.45/t3 auth session issue --base-dir /data/home", owner)).toBe(false);
  });
});
