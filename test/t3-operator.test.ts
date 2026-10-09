import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRunner } from "../src/command.ts";
import type { ResolvedT3Config } from "../src/config.ts";
import { PINNED_T3 } from "../src/t3/lock.ts";
import {
  inspectManagedT3Runtime,
  type ManagedT3Config,
  requireManagedT3,
  runManagedT3Pair,
} from "../src/t3/operator.ts";
import type { EnvironmentFetch } from "../src/t3/protocol.ts";

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
    managed: {
      port: 37841,
      homeDir,
      runtimeDir: join(root, "runtime"),
      autoInstall: true,
    },
  };
}

const rejectingFetch: EnvironmentFetch = () => Promise.reject(new TypeError("fetch failed"));

function descriptorFetch(body: { serverVersion: string; orchestrationProtocolVersion: number }): EnvironmentFetch {
  return async () => Response.json(body);
}

describe("requireManagedT3", () => {
  test("rejects an external config and names the managed mode", () => {
    const external: ResolvedT3Config = { mode: "external", baseUrl: "http://127.0.0.1:37841", tokenFile: "/x" };
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
