import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { externalT3AdminFlags } from "../src/cli-commands.ts";
import { PINNED_T3, t3ArtifactFor } from "../src/t3/lock.ts";
import { buildFakeT3Tarball, serveFakeT3Mirror } from "./fixtures/fake-t3-tarball.ts";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function expectCleanUsageError(result: { exitCode: number; stdout: string; stderr: string }, problem: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`agent-tag: ${problem}\n`);
  expect(result.stderr).toContain("usage: agent-tag onboard");
  expect(result.stderr).toContain("agent-tag doctor [CONFIG] [--fix] [--json]");
  expect(result.stderr).toContain("agent-tag service <install|upgrade|uninstall|status|restart|logs>");
  expect(result.stderr).toContain("agent-tag t3 <install|status> [CONFIG]");
  expect(result.stderr).toContain("agent-tag <run|status|audit|backup> CONFIG");
  expect(result.stderr).toContain("agent-tag help");
  // No Bun error banner, code frame, or stack frames.
  expect(result.stderr).not.toContain("cli.ts:");
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toContain("error:");
}

// onboard, doctor, and service are real commands (doctor's CONFIG is optional), so they never reach usage().
test("an unknown command prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["onbaord"]), "unknown command: onbaord");
  expectCleanUsageError(await runCli(["bogus", "x"]), "unknown command: bogus");
});

test("a known command without its argument prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["status"]), "status requires an argument");
  expectCleanUsageError(await runCli(["run"]), "run requires an argument");
  const restore = await runCli(["restore", "/nonexistent/backup.sqlite"]);
  expect(restore.exitCode).toBe(1);
  expect(restore.stderr.startsWith("usage: agent-tag")).toBe(true);
  expect(restore.stderr).not.toContain("cli.ts:");
});

test("agent-tag help lists the onboarding, doctor, and service commands", async () => {
  const result = await runCli(["help"]);
  expect(result.exitCode).toBe(0);
  for (const command of ["onboard", "doctor", "service install|upgrade|uninstall|status|restart", "service logs", "t3 install|status", "run", "update"]) {
    expect(result.stdout).toContain(`agent-tag ${command}`);
  }
  expect(result.stdout).toContain("--fix");
  expect(result.stdout).toContain("$AGENT_TAG_CONFIG");
});

test("security and prune argument mistakes print usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["security", "audit"]), "invalid security arguments");
  expectCleanUsageError(await runCli(["security", "audit", "/x.json", "--bogus"]), "unknown option --bogus");
  expectCleanUsageError(await runCli(["prune"]), "invalid prune arguments");
});

test("security audit prints its report and exits 1 on a high finding", async () => {
  const result = await runCli(["security", "audit", "/nonexistent/agent-tag.json", "--json", "--offline"]);
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout) as { result: string; findings: Array<{ id: string }> };
  expect(report.result).toBe("fail");
  expect(report.findings.map((finding) => finding.id)).toContain("config-unreadable");
});

async function writeT3Config(): Promise<{ configPath: string; dataDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "agent-tag-cli-t3-"));
  const dataDir = join(home, "data");
  const configPath = join(home, "agent-tag.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    dataDir,
    t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: join(home, "t3-token") },
    slack: { workspaceId: "T123", appTokenFile: join(home, "app"), botTokenFile: join(home, "bot") },
    access: { allowedUserIds: ["U123"], allowedChannelIds: ["C123"] },
    profiles: [{
      id: "engineering",
      repositoryRoots: ["/repos/example"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "approval-required", allowedTools: ["github"] },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    }],
    routes: [{ conversationId: "C123", profileId: "engineering", repositoryRoot: "/repos/example" }],
    limits: { maxConcurrentTasks: 2 },
  }));
  return { configPath, dataDir };
}

test("t3 status prints the install fields as JSON without installing anything", async () => {
  const { configPath, dataDir } = await writeT3Config();
  const result = await runCli(["t3", "status", configPath]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    mode: "external",
    pinnedVersion: PINNED_T3.version,
    target: `${process.platform}-${process.arch}`,
    supported: t3ArtifactFor(PINNED_T3) !== undefined,
    runtimeDir: join(dataDir, "t3", "runtime"),
    installed: false,
    version: null,
    binary: null,
    binarySha256: null,
    binarySha256Verified: false,
    filesVerified: false,
    installedAt: null,
    problem: t3ArtifactFor(PINNED_T3) === undefined ? `t3.lock.json pins no artifact for ${process.platform}-${process.arch}` : null,
    // No T3 answers on the configured URL (and the token file does not exist), so only the problem is set.
    token: { expiresAt: null, daysRemaining: null, problem: expect.any(String) },
  });
  expect(await readdir(dataDir).catch(() => [])).toEqual([]);
});

test.skipIf(t3ArtifactFor(PINNED_T3) === undefined)("t3 install rejects an archive that does not match t3.lock.json", async () => {
  const { configPath, dataDir } = await writeT3Config();
  const artifact = t3ArtifactFor(PINNED_T3)!;
  const tarball = await buildFakeT3Tarball();
  const mirror = serveFakeT3Mirror({ [`/${PINNED_T3.tag}/${artifact.name}`]: tarball.bytes });
  try {
    const result = await runCli(["t3", "install", configPath, "--download-base-url", mirror.baseUrl]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`agent-tag t3: ${artifact.name} sha256 mismatch: expected ${artifact.sha256}`);
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(mirror.requests).toEqual([`/${PINNED_T3.tag}/${artifact.name}`]);
    const runtime = join(dataDir, "t3", "runtime");
    expect(await readdir(join(runtime, "versions"))).toEqual([]);
    expect(await readdir(join(runtime, "downloads"))).toEqual([]);
  } finally {
    await mirror.stop();
  }
});

test("t3 argument mistakes print a clean error", async () => {
  const bogus = await runCli(["t3", "bogus"]);
  expect(bogus.exitCode).toBe(1);
  expect(bogus.stderr).toContain("agent-tag t3: usage: agent-tag t3 <install|status>");
  const mirror = await runCli(["t3", "install", "/nonexistent.json", "--download-base-url", "http://mirror.example"]);
  expect(mirror.exitCode).toBe(1);
  expect(mirror.stderr).toContain("agent-tag t3: T3 download base URL must use https: http://mirror.example");
  const statusFlag = await runCli(["t3", "status", "--download-base-url", "https://mirror.example"]);
  expect(statusFlag.stderr).toContain("--download-base-url only applies to t3 install");
});

async function writeConfigWithT3(t3: Record<string, unknown>): Promise<{ configPath: string; dataDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "agent-tag-cli-t3-"));
  const dataDir = await mkdtemp(join(tmpdir(), "agent-tag-cli-t3-data-"));
  const configPath = join(home, "agent-tag.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    dataDir,
    t3,
    slack: { workspaceId: "T123", appTokenFile: join(home, "app"), botTokenFile: join(home, "bot") },
    access: { allowedUserIds: ["U123"], allowedChannelIds: ["C123"] },
    profiles: [{
      id: "engineering",
      repositoryRoots: ["/repos/example"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "approval-required", allowedTools: ["github"] },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    }],
    routes: [{ conversationId: "C123", profileId: "engineering", repositoryRoot: "/repos/example" }],
    limits: { maxConcurrentTasks: 2 },
  }));
  return { configPath, dataDir };
}

test("t3 serve and t3 pair refuse an external config and say how to enable managed mode", async () => {
  const { configPath } = await writeT3Config();
  for (const action of ["serve", "pair"]) {
    const result = await runCli(["t3", action, configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`t3.mode "managed"`);
    expect(result.stderr).not.toMatch(/^\s+at /m);
  }
});

test("t3 status reports a managed runtime that is not installed or running", async () => {
  const tokenFile = join(await mkdtemp(join(tmpdir(), "agent-tag-cli-t3-token-")), "t3-token");
  const { configPath, dataDir } = await writeConfigWithT3({ mode: "managed", port: 39871, tokenFile });
  const result = await runCli(["t3", "status", configPath]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const status = JSON.parse(result.stdout) as Record<string, unknown> & { runtime: Record<string, unknown> };
  expect(status).toMatchObject({
    mode: "managed",
    pinnedVersion: PINNED_T3.version,
    installed: false,
    binarySha256Verified: false,
    filesVerified: false,
    pid: null,
    protocol: null,
    baseUrl: "http://127.0.0.1:39871",
    homeDir: join(dataDir, "t3", "home"),
  });
  expect(status.runtime).toMatchObject({ running: false, pid: null, protocol: null });
  expect(status.runtime.problem).toContain("not reachable on http://127.0.0.1:39871");
});

test("t3 status rejects --allow-non-tty, which only applies to t3 pair", async () => {
  const result = await runCli(["t3", "status", "--allow-non-tty"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--allow-non-tty only applies to t3 pair");
});

describe("externalT3AdminFlags", () => {
  test("--admin-token-file resolves to an absolute path", () => {
    expect(externalT3AdminFlags(new Map([["admin-token-file", "secrets/t3-admin"]]))).toEqual({
      adminTokenFile: join(process.cwd(), "secrets", "t3-admin"),
    });
  });

  test("--t3-base-dir defaults the T3 binary to t3", () => {
    expect(externalT3AdminFlags(new Map([["t3-base-dir", "/srv/t3-base"]]))).toEqual({
      t3BaseDir: "/srv/t3-base",
      t3Bin: "t3",
    });
  });

  test("--t3-base-dir with --t3-bin uses the explicit binary", () => {
    expect(
      externalT3AdminFlags(new Map([
        ["t3-base-dir", "/srv/t3-base"],
        ["t3-bin", "/opt/t3/bin/t3"],
      ])),
    ).toEqual({ t3BaseDir: "/srv/t3-base", t3Bin: "/opt/t3/bin/t3" });
  });

  test("--t3-bin alone and admin-token-file combined with base-dir flags are rejected", () => {
    expect(() => externalT3AdminFlags(new Map([["t3-bin", "t3"]]))).toThrow("--t3-bin needs --t3-base-dir");
    expect(() =>
      externalT3AdminFlags(new Map([
        ["admin-token-file", "/srv/admin"],
        ["t3-base-dir", "/srv/t3-base"],
      ])),
    ).toThrow("pass --admin-token-file or --t3-base-dir/--t3-bin, not both");
    expect(() =>
      externalT3AdminFlags(new Map([
        ["admin-token-file", "/srv/admin"],
        ["t3-bin", "t3"],
      ])),
    ).toThrow("pass --admin-token-file or --t3-base-dir/--t3-bin, not both");
  });

  test("returns undefined when no admin flags are given", () => {
    expect(externalT3AdminFlags(new Map())).toBeUndefined();
  });
});

test("t3 status rejects --admin-token-file, which only applies to t3 rotate", async () => {
  const result = await runCli(["t3", "status", "--admin-token-file", "x"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "agent-tag t3: --admin-token-file, --t3-base-dir and --t3-bin only apply to t3 rotate",
  );
});
