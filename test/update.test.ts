import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDistributionCommand, type DistributionContext } from "../src/distribution.ts";
import {
  isProcessAlive,
  parseUpdateArguments,
  releaseBaseUrlFromEnv,
  runUpdate,
  temporaryUpdateName,
  type UpdateDependencies,
} from "../src/update.ts";
import type { BuildInfo } from "../src/version.ts";
import { fakeBinaryScript, writeFakeRelease } from "./fixtures/fake-release.ts";

let root: string;
let releases: string;
let binDir: string;
let latestTag: string | undefined;
let server: ReturnType<typeof Bun.serve>;
const requests: string[] = [];

beforeAll(() => {
  // A tiny stand-in for github.com/<repo>/releases: `latest` redirects to the tag page,
  // `download/<tag>/<asset>` serves files from the fake release directory.
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/releases/latest") {
        const location = latestTag === undefined ? "/releases" : `/releases/tag/${latestTag}`;
        return new Response(null, { status: 302, headers: { location } });
      }
      const match = /^\/releases\/(download\/[^/]+\/[^/]+)$/.exec(path);
      if (match?.[1] !== undefined) {
        const file = Bun.file(join(releases, match[1]));
        if (await file.exists()) return new Response(file);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  void server.stop(true);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-tag-update-test-"));
  releases = join(root, "releases");
  binDir = join(root, "bin");
  await mkdir(binDir);
  latestTag = undefined;
  requests.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const target = "linux-x64" as const;
const asset = `agent-tag-${target}`;

function binaryBuild(version: string): BuildInfo {
  return { version, target, commit: undefined, installKind: "binary" };
}

async function installCurrent(version: string): Promise<string> {
  const path = join(binDir, "agent-tag");
  await writeFile(path, fakeBinaryScript(version, target));
  await chmod(path, 0o755);
  return path;
}

function dependencies(build: BuildInfo, execPath: string, log: string[] = []): UpdateDependencies {
  return {
    build,
    execPath,
    releaseBaseUrl: `${server.url.origin}/releases`,
    fetch: (input, init) => fetch(input, init),
    log: (line) => log.push(line),
  };
}

test("replaces the running binary with the verified latest release", async () => {
  const execPath = await installCurrent("0.1.0");
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.2.0", target) } });
  latestTag = "v0.2.0";
  const log: string[] = [];
  const result = await runUpdate({ check: false, version: undefined }, dependencies(binaryBuild("0.1.0"), execPath, log));
  expect(result).toEqual({ status: "updated", previous: "0.1.0", current: "0.2.0", path: await realpath(execPath) });
  expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.2.0", target));
  expect((await stat(execPath)).mode & 0o777).toBe(0o755);
  expect(await readdir(binDir)).toEqual(["agent-tag"]);
  expect(log).toEqual([`downloading agent-tag 0.2.0 (${asset})`]);
  expect(requests).toEqual(["/releases/latest", "/releases/download/v0.2.0/SHA256SUMS", `/releases/download/v0.2.0/${asset}`]);
});

test("follows a symlinked install to the real binary", async () => {
  const realPath = await installCurrent("0.1.0");
  const link = join(root, "agent-tag-link");
  await symlink(realPath, link);
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.2.0", target) } });
  const result = await runUpdate({ check: false, version: "0.2.0" }, dependencies(binaryBuild("0.1.0"), link));
  expect(result.status).toBe("updated");
  expect(await Bun.file(realPath).text()).toBe(fakeBinaryScript("0.2.0", target));
});

test("pins an explicit version, including a downgrade", async () => {
  const execPath = await installCurrent("0.3.0");
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.2.0", target) } });
  latestTag = "v0.3.0";
  const result = await runUpdate(parseUpdateArguments(["--version", "v0.2.0"]), dependencies(binaryBuild("0.3.0"), execPath));
  expect(result.status).toBe("updated");
  expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.2.0", target));
  expect(requests).not.toContain("/releases/latest");
});

test("refuses a checksum mismatch and leaves the binary untouched", async () => {
  const execPath = await installCurrent("0.1.0");
  await writeFakeRelease({
    root: releases,
    tag: "v0.2.0",
    assets: { [asset]: fakeBinaryScript("0.2.0", target) },
    corruptChecksums: [asset],
  });
  latestTag = "v0.2.0";
  await expect(runUpdate({ check: false, version: undefined }, dependencies(binaryBuild("0.1.0"), execPath))).rejects.toThrow(
    `checksum mismatch for ${asset}`,
  );
  expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.1.0", target));
  expect(await readdir(binDir)).toEqual(["agent-tag"]);
});

test("refuses a downloaded binary that reports the wrong version", async () => {
  const execPath = await installCurrent("0.1.0");
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.1.9", target) } });
  await expect(runUpdate({ check: false, version: "0.2.0" }, dependencies(binaryBuild("0.1.0"), execPath))).rejects.toThrow(
    "reports version 0.1.9, expected 0.2.0",
  );
  expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.1.0", target));
  expect(await readdir(binDir)).toEqual(["agent-tag"]);
});

test("an overlapping update keeps another live updater's staged file and clears only dead ones", async () => {
  // Stand-in for a second `agent-tag update` that is mid-download/smoke-test.
  const concurrent = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const exited = Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await exited.exited;
  try {
    expect(isProcessAlive(concurrent.pid)).toBe(true);
    expect(isProcessAlive(exited.pid)).toBe(false);
    const execPath = await installCurrent("0.1.0");
    const live = temporaryUpdateName(concurrent.pid, "aaaaaaaaaaaa");
    const dead = temporaryUpdateName(exited.pid, "bbbbbbbbbbbb");
    const legacy = ".agent-tag-update-unknown";
    for (const name of [live, dead, legacy]) await writeFile(join(binDir, name), "staged");
    await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.2.0", target) } });
    const result = await runUpdate({ check: false, version: "0.2.0" }, dependencies(binaryBuild("0.1.0"), execPath));
    expect(result.status).toBe("updated");
    expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.2.0", target));
    expect((await readdir(binDir)).sort()).toEqual([live, "agent-tag"].sort());
    expect(await Bun.file(join(binDir, live)).text()).toBe("staged");
  } finally {
    concurrent.kill();
    await concurrent.exited;
  }
});

test("fails when the release lacks this platform or does not exist", async () => {
  const execPath = await installCurrent("0.1.0");
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { "agent-tag-darwin-arm64": "x" } });
  await expect(runUpdate({ check: false, version: "0.2.0" }, dependencies(binaryBuild("0.1.0"), execPath))).rejects.toThrow(
    `SHA256SUMS for v0.2.0 has no entry for ${asset}`,
  );
  await expect(runUpdate({ check: false, version: "0.9.0" }, dependencies(binaryBuild("0.1.0"), execPath))).rejects.toThrow(
    "download failed with HTTP 404",
  );
  await expect(runUpdate({ check: true, version: undefined }, dependencies(binaryBuild("0.1.0"), execPath))).rejects.toThrow(
    "no stable agent-tag release is published yet",
  );
});

test("a prerelease install gets actionable guidance while only prereleases exist", async () => {
  // Before GA every release is a prerelease, so `releases/latest` redirects to `/releases`.
  const execPath = await installCurrent("0.1.0-rc.1");
  await writeFakeRelease({ root: releases, tag: "v0.1.0-rc.2", assets: { [asset]: fakeBinaryScript("0.1.0-rc.2", target) } });
  const build = binaryBuild("0.1.0-rc.1");
  for (const check of [true, false]) {
    const io = context(build, execPath);
    expect(await runDistributionCommand(check ? ["update", "--check"] : ["update"], io)).toBe(1);
    const stderr = io.err.join("");
    expect(stderr).toContain("no stable agent-tag release is published yet");
    expect(stderr).toContain(`${server.url.origin}/releases`);
    expect(stderr).toContain("agent-tag update --version");
  }
  // The suggested path works.
  const io = context(build, execPath);
  expect(await runDistributionCommand(["update", "--version", "0.1.0-rc.2"], io)).toBe(0);
  expect(io.out.join("")).toContain("Updated agent-tag 0.1.0-rc.1 -> 0.1.0-rc.2");
});

test("--check reports availability without downloading or writing", async () => {
  const execPath = await installCurrent("0.1.0");
  latestTag = "v0.2.0";
  expect(await runUpdate({ check: true, version: undefined }, dependencies(binaryBuild("0.1.0"), execPath))).toEqual({
    status: "available",
    current: "0.1.0",
    latest: "0.2.0",
  });
  expect(await runUpdate({ check: true, version: undefined }, dependencies(binaryBuild("0.2.0"), execPath))).toEqual({
    status: "up-to-date",
    current: "0.2.0",
    latest: "0.2.0",
  });
  expect(requests).toEqual(["/releases/latest", "/releases/latest"]);
  expect(await Bun.file(execPath).text()).toBe(fakeBinaryScript("0.1.0", target));
});

test("does nothing when already current or newer than latest", async () => {
  const execPath = await installCurrent("0.3.0-rc.1");
  latestTag = "v0.2.0";
  const result = await runUpdate({ check: false, version: undefined }, dependencies(binaryBuild("0.3.0-rc.1"), execPath));
  expect(result.status).toBe("up-to-date");
  expect(requests).toEqual(["/releases/latest"]);
});

test("refuses to self-update a source checkout or container and explains the alternative", async () => {
  const execPath = await installCurrent("0.1.0");
  latestTag = "v0.2.0";
  const source: BuildInfo = { version: "0.1.0", target, commit: undefined, installKind: "source" };
  await expect(runUpdate({ check: false, version: undefined }, dependencies(source, execPath))).rejects.toThrow("git pull");
  const container: BuildInfo = { ...source, installKind: "container" };
  await expect(runUpdate({ check: false, version: undefined }, dependencies(container, execPath))).rejects.toThrow("pull a newer image");
  expect(requests).toEqual([]);
  expect((await runUpdate({ check: true, version: undefined }, dependencies(source, execPath))).status).toBe("available");
});

test("validates update arguments and the release base override", () => {
  expect(parseUpdateArguments([])).toEqual({ check: false, version: undefined });
  expect(parseUpdateArguments(["--check", "--version=v1.2.3"])).toEqual({ check: true, version: "1.2.3" });
  expect(() => parseUpdateArguments(["--version"])).toThrow("--version requires a value");
  expect(() => parseUpdateArguments(["--version", "../../x"])).toThrow("invalid release version");
  expect(() => parseUpdateArguments(["--force"])).toThrow("unknown update option: --force");
  expect(releaseBaseUrlFromEnv({})).toBe("https://github.com/Dhruv2mars/agent-tag/releases");
  expect(releaseBaseUrlFromEnv({ AGENT_TAG_RELEASE_BASE_URL: "https://mirror.example/releases/" })).toBe("https://mirror.example/releases");
  expect(() => releaseBaseUrlFromEnv({ AGENT_TAG_RELEASE_BASE_URL: "file:///tmp/releases" })).toThrow("http(s)");
});

function context(build: BuildInfo, execPath: string, env: Record<string, string> = {}): DistributionContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    build,
    env: { AGENT_TAG_RELEASE_BASE_URL: `${server.url.origin}/releases`, ...env },
    execPath,
    fetch: (input, init) => fetch(input, init),
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    out,
    err,
  };
}

test("the CLI dispatcher prints help, version, and update outcomes with exit codes", async () => {
  const execPath = await installCurrent("0.1.0");
  const build = binaryBuild("0.1.0");

  let io = context(build, execPath);
  expect(await runDistributionCommand(["--help"], io)).toBe(0);
  expect(io.out.join("")).toContain("agent-tag update [--check] [--version X]");

  io = context(build, execPath);
  expect(await runDistributionCommand([], io)).toBe(1);
  expect(io.err.join("")).toContain("Usage:");

  io = context(build, execPath);
  expect(await runDistributionCommand(["version"], io)).toBe(0);
  expect(io.out).toEqual(["agent-tag 0.1.0 (linux-x64, binary)\n"]);

  io = context(build, execPath);
  expect(await runDistributionCommand(["version", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.join(""))).toEqual({ version: "0.1.0", target, commit: null, installKind: "binary" });

  io = context(build, execPath);
  expect(await runDistributionCommand(["version", "--yaml"], io)).toBe(1);

  latestTag = "v0.2.0";
  await writeFakeRelease({ root: releases, tag: "v0.2.0", assets: { [asset]: fakeBinaryScript("0.2.0", target) } });
  io = context(build, execPath);
  expect(await runDistributionCommand(["update", "--check"], io)).toBe(0);
  expect(io.out.join("")).toContain("agent-tag 0.2.0 is available");

  io = context(build, execPath);
  expect(await runDistributionCommand(["update"], io)).toBe(0);
  expect(io.out.join("")).toContain("Updated agent-tag 0.1.0 -> 0.2.0");

  io = context({ ...build, installKind: "source" }, execPath);
  expect(await runDistributionCommand(["update"], io)).toBe(1);
  expect(io.err.join("")).toContain("git pull && bun install --frozen-lockfile");
});
