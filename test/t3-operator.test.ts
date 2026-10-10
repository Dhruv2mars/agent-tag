import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CommandRunner, runCommand } from "../src/command.ts";
import type { ResolvedT3Config } from "../src/config.ts";
import { PINNED_T3 } from "../src/t3/lock.ts";
import {
  inspectManagedT3Runtime,
  type ManagedT3Config,
  requireManagedT3,
  runManagedT3Pair,
  runManagedT3Serve,
  T3_FATAL_EXIT_CODE,
} from "../src/t3/operator.ts";
import type { EnvironmentFetch } from "../src/t3/protocol.ts";
import { T3ManagedRuntime } from "../src/t3/supervisor.ts";
import type { T3InstallStatus } from "../src/t3/install.ts";
import { FAKE_PAIRING_TOKEN, FAKE_T3_BINARY } from "./fixtures/fake-t3/index.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-tag-t3-operator-"));
  tempDirs.push(dir);
  return dir;
}

/** A managed config whose runtimeDir is never created, so it is empty (nothing installed). */
async function managedConfig(root: string): Promise<ManagedT3Config> {
  const homeDir = join(root, "home");
  await mkdir(homeDir, { recursive: true });
  return {
    mode: "managed",
    baseUrl: "http://127.0.0.1:37841",
    tokenFile: "/x",
    watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 },
    managed: {
      port: 37841,
      homeDir,
      runtimeDir: join(root, "runtime"),
      autoInstall: true,
      rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
    },
  };
}

const rejectingFetch: EnvironmentFetch = () => Promise.reject(new TypeError("fetch failed"));

function descriptorFetch(body: { serverVersion: string; orchestrationProtocolVersion: number }): EnvironmentFetch {
  return async () => Response.json(body);
}

describe("requireManagedT3", () => {
  test("rejects an external config and names the managed mode", () => {
    const external: ResolvedT3Config = { mode: "external", baseUrl: "http://127.0.0.1:37841", tokenFile: "/x", watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 } };
    expect(() => requireManagedT3(external, "serve")).toThrow('t3.mode "managed"');
  });

  test("returns a managed config unchanged", async () => {
    const config = await managedConfig(await tempDir());
    expect(requireManagedT3(config, "serve")).toBe(config);
  });
});

describe("inspectManagedT3Runtime", () => {
  test("reports not running when no server-runtime.json exists and the environment is unreachable", async () => {
    const config = await managedConfig(await tempDir());
    const runtime = await inspectManagedT3Runtime({
      t3: config,
      pinnedVersion: "0.0.45",
      fetch: rejectingFetch,
    });
    expect(runtime.running).toBe(false);
    expect(runtime.pid).toBeNull();
    expect(runtime.protocol).toBeNull();
    expect(runtime.serverVersion).toBeNull();
    expect(runtime.problem).toContain("not reachable");
  });

  test("reports the live pid, protocol, and version when the pinned server answers", async () => {
    const root = await tempDir();
    const config = await managedConfig(root);
    await mkdir(join(config.managed.homeDir, "userdata"), { recursive: true });
    await writeFile(join(config.managed.homeDir, "userdata", "server-runtime.json"), JSON.stringify({ pid: process.pid }));
    const runtime = await inspectManagedT3Runtime({
      t3: config,
      pinnedVersion: "0.0.45",
      fetch: descriptorFetch({ serverVersion: "0.0.45", orchestrationProtocolVersion: 1 }),
    });
    expect(runtime).toEqual({
      running: true,
      pid: process.pid,
      protocol: 1,
      serverVersion: "0.0.45",
      problem: null,
    });
  });

  test("reports a problem naming the server version when it is not the pinned one", async () => {
    const root = await tempDir();
    const config = await managedConfig(root);
    await mkdir(join(config.managed.homeDir, "userdata"), { recursive: true });
    await writeFile(join(config.managed.homeDir, "userdata", "server-runtime.json"), JSON.stringify({ pid: process.pid }));
    const runtime = await inspectManagedT3Runtime({
      t3: config,
      pinnedVersion: "0.0.45",
      fetch: descriptorFetch({ serverVersion: "0.0.44", orchestrationProtocolVersion: 1 }),
    });
    expect(runtime.running).toBe(true);
    expect(runtime.serverVersion).toBe("0.0.44");
    expect(runtime.problem).toContain("0.0.44");
  });
});

describe("runManagedT3Pair", () => {
  test("refuses to print a credential to a non-TTY without --allow-non-tty and never runs T3", async () => {
    const config = await managedConfig(await tempDir());
    let runs = 0;
    const run: CommandRunner = async () => {
      runs += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    await expect(runManagedT3Pair({
      t3: config,
      pin: PINNED_T3,
      run,
      stdoutIsTty: false,
      allowNonTty: false,
      print: () => {},
    })).rejects.toThrow("--allow-non-tty");
    expect(runs).toBe(0);
  });

  test("refuses when the pinned T3 install is missing and never runs T3", async () => {
    const config = await managedConfig(await tempDir());
    let runs = 0;
    const run: CommandRunner = async () => {
      runs += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    await expect(runManagedT3Pair({
      t3: config,
      pin: PINNED_T3,
      run,
      stdoutIsTty: true,
      allowNonTty: false,
      print: () => {},
    })).rejects.toThrow("t3 install");
    expect(runs).toBe(0);
  });
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

/** A managed config on a free port, driven by the fake T3 CLI. */
async function liveManagedConfig(): Promise<ManagedT3Config> {
  const root = await tempDir();
  await chmod(root, 0o700);
  const config = await managedConfig(root);
  await chmod(config.managed.homeDir, 0o700);
  const port = await freePort();
  return { ...config, baseUrl: `http://127.0.0.1:${port}`, managed: { ...config.managed, port } };
}

const FAST = { readyTimeoutMs: 10_000, readyPollMs: 25, stopTimeoutMs: 2_000, orphanTimeoutMs: 2_000 };

describe("runManagedT3Serve with the fake T3 CLI", () => {
  for (const [reason, exitCode] of [["signal", 0], ["fatal", T3_FATAL_EXIT_CODE]] as const) {
    test(`prints the ready runtime, exits ${exitCode} on ${reason}, and stops T3`, async () => {
      const config = await liveManagedConfig();
      const printed: string[] = [];
      const logs: string[] = [];
      let pidWhileWaiting = 0;
      const code = await runManagedT3Serve({
        t3: config,
        pin: PINNED_T3,
        logger: (record) => logs.push(JSON.stringify(record)),
        print: (line) => printed.push(line),
        installed: { binary: FAKE_T3_BINARY, version: PINNED_T3.version },
        runtimeOptions: { timing: FAST },
        wait: async () => {
          pidWhileWaiting = JSON.parse(printed[0] ?? "{}").pid;
          expect(alive(pidWhileWaiting)).toBe(true);
          return reason;
        },
      });
      expect(code).toBe(exitCode);
      expect(printed).toHaveLength(1);
      const ready = JSON.parse(printed[0] ?? "{}");
      expect(ready).toEqual({
        baseUrl: config.baseUrl,
        pid: pidWhileWaiting,
        version: PINNED_T3.version,
        protocol: 1,
        homeDir: config.managed.homeDir,
      });
      expect(alive(pidWhileWaiting)).toBe(false);
      // The pairing credential T3 prints at startup never reaches agent-tag's output or logs.
      expect([...printed, ...logs].join("\n")).not.toContain(FAKE_PAIRING_TOKEN);
    });
  }
});

describe("runManagedT3Pair with the fake T3 CLI", () => {
  test("prints a pairing link for the running managed runtime", async () => {
    const config = await liveManagedConfig();
    const runtime = new T3ManagedRuntime({
      settings: config.managed,
      installed: { binary: FAKE_T3_BINARY, version: PINNED_T3.version },
      logger: () => {},
      timing: FAST,
    });
    await runtime.start();
    try {
      const commands: (readonly string[])[] = [];
      const printed: string[] = [];
      const verified: T3InstallStatus = {
        pinnedVersion: PINNED_T3.version,
        target: `${process.platform}-${process.arch}`,
        supported: true,
        runtimeDir: config.managed.runtimeDir,
        installed: true,
        version: PINNED_T3.version,
        binary: FAKE_T3_BINARY,
        binarySha256: null,
        binarySha256Verified: true,
        filesVerified: true,
        installedAt: null,
        problem: null,
      };
      const code = await runManagedT3Pair({
        t3: config,
        pin: PINNED_T3,
        run: (command) => {
          commands.push(command);
          return runCommand(command);
        },
        stdoutIsTty: false,
        allowNonTty: true,
        print: (line) => printed.push(line),
        inspectInstall: async () => verified,
      });
      expect(code).toBe(0);
      expect(commands).toHaveLength(1);
      expect(commands[0]?.slice(0, 6)).toEqual([FAKE_T3_BINARY, "auth", "pairing", "create", "--base-dir", config.managed.homeDir]);
      expect(printed).toHaveLength(2);
      expect(printed[0]).toContain("expires 2026-10-09T12:05:00.000Z");
      expect(printed[1]).toBe(`${config.baseUrl}/pair#token=${FAKE_PAIRING_TOKEN}`);
    } finally {
      await runtime.stop();
    }
  });
});
