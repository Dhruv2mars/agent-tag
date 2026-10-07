import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { detectReleaseTarget } from "../src/release.ts";
import { fakeBinaryScript, writeFakeRelease } from "./fixtures/fake-release.ts";

const installScript = resolve(import.meta.dir, "..", "install.sh");

let root: string;
let releases: string;
let installDir: string;
let fakeBin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-tag-install-test-"));
  releases = join(root, "releases");
  installDir = join(root, "home", ".local", "bin");
  fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Shadows `uname` so the installer sees a chosen OS and CPU regardless of the host. */
async function fakeUname(system: string, machine: string): Promise<void> {
  const path = join(fakeBin, "uname");
  await writeFile(
    path,
    `#!/bin/sh\ncase "$1" in -s) echo "${system}" ;; -m) echo "${machine}" ;; *) echo "${system}" ;; esac\n`,
  );
  await chmod(path, 0o755);
}

/** Shadows a libc probe (`getconf` or `ldd`) with a script that prints and exits as given. */
async function fakeTool(name: string, output: string, exitCode: number, stream: "stdout" | "stderr" = "stdout"): Promise<void> {
  const path = join(fakeBin, name);
  const redirect = stream === "stderr" ? " >&2" : "";
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'${redirect}\nexit ${exitCode}\n`);
  await chmod(path, 0o755);
}

async function runInstaller(
  env: Record<string, string> = {},
  shell = "/bin/sh",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([shell, installScript], {
    env: {
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(root, "home"),
      AGENT_TAG_RELEASE_BASE_URL: pathToFileURL(releases).href,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("installs the latest verified release into ~/.local/bin by default", async () => {
  await fakeUname("Linux", "x86_64");
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: {
      "agent-tag-linux-x64": fakeBinaryScript("0.3.0", "linux-x64"),
      "agent-tag-linux-arm64": fakeBinaryScript("0.3.0", "linux-arm64"),
    },
  });
  const result = await runInstaller();
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const installed = join(installDir, "agent-tag");
  expect((await stat(installed)).mode & 0o777).toBe(0o755);
  expect(await Bun.file(installed).text()).toBe(fakeBinaryScript("0.3.0", "linux-x64"));
  expect(result.stdout).toContain("verified sha256");
  expect(result.stdout).toContain("agent-tag 0.3.0 (linux-x64, binary)");
  expect(result.stdout).toContain("is not on your PATH");
  expect(result.stdout).toContain("docs/slack-setup.md");
  // The hint names only commands this build ships ("install.sh only suggests commands the CLI ships").
  expect(result.stdout).toContain("run the setup wizard: agent-tag onboard");
  expect((await readdir(installDir)).sort()).toEqual(["agent-tag"]);
});

test("honors AGENT_TAG_VERSION and AGENT_TAG_INSTALL_DIR and maps aarch64 to arm64", async () => {
  await fakeUname("Linux", "aarch64");
  await writeFakeRelease({
    root: releases,
    tag: "v0.2.0",
    assets: { "agent-tag-linux-arm64": fakeBinaryScript("0.2.0", "linux-arm64") },
  });
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: { "agent-tag-linux-arm64": fakeBinaryScript("0.3.0", "linux-arm64") },
  });
  const customDir = join(root, "opt bin");
  const result = await runInstaller({
    AGENT_TAG_VERSION: "0.2.0",
    AGENT_TAG_INSTALL_DIR: customDir,
    PATH: `${fakeBin}:${customDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("downloading agent-tag-linux-arm64 (v0.2.0)");
  expect(await Bun.file(join(customDir, "agent-tag")).text()).toBe(fakeBinaryScript("0.2.0", "linux-arm64"));
  expect(result.stdout).not.toContain("is not on your PATH");
});

test("detects darwin targets", async () => {
  await fakeUname("Darwin", "arm64");
  await writeFakeRelease({
    root: releases,
    tag: "v1.0.0-rc.1",
    assets: { "agent-tag-darwin-arm64": fakeBinaryScript("1.0.0-rc.1", "darwin-arm64") },
  });
  const result = await runInstaller({ AGENT_TAG_VERSION: "v1.0.0-rc.1" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("agent-tag 1.0.0-rc.1 (darwin-arm64, binary)");
});

test("refuses a binary whose checksum does not match and leaves the old install alone", async () => {
  await fakeUname("Linux", "x86_64");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "agent-tag"), "previous");
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: { "agent-tag-linux-x64": fakeBinaryScript("0.3.0", "linux-x64") },
    corruptChecksums: ["agent-tag-linux-x64"],
  });
  const result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("checksum mismatch for agent-tag-linux-x64");
  expect(await Bun.file(join(installDir, "agent-tag")).text()).toBe("previous");
  expect(await readdir(installDir)).toEqual(["agent-tag"]);
});

test("fails clearly when the platform asset or its checksum is missing", async () => {
  await fakeUname("Linux", "x86_64");
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: { "agent-tag-linux-arm64": fakeBinaryScript("0.3.0", "linux-arm64") },
  });
  let result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("download failed");

  await writeFile(join(releases, "latest", "download", "agent-tag-linux-x64"), "unlisted");
  result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("SHA256SUMS has no entry for agent-tag-linux-x64");
  expect(await Bun.file(join(installDir, "agent-tag")).exists()).toBe(false);
});

test("rejects unsupported platforms and malformed versions before downloading", async () => {
  await fakeUname("FreeBSD", "amd64");
  let result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("unsupported operating system: FreeBSD");

  await fakeUname("Linux", "riscv64");
  result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("unsupported CPU architecture: riscv64");

  await fakeUname("MINGW64_NT-10.0", "x86_64");
  result = await runInstaller();
  expect(result.stderr).toContain("WSL2");

  await fakeUname("Linux", "x86_64");
  result = await runInstaller({ AGENT_TAG_VERSION: "1.2/../../evil" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("invalid AGENT_TAG_VERSION");
});

test("selects the same asset as the TypeScript updater on this host and runs under dash", async () => {
  const target = detectReleaseTarget(process.platform, process.arch);
  if (target === undefined) return;
  await writeFakeRelease({
    root: releases,
    tag: "v0.4.0",
    latest: true,
    assets: { [`agent-tag-${target}`]: fakeBinaryScript("0.4.0", target) },
  });
  const shell = (await Bun.file("/bin/dash").exists()) ? "/bin/dash" : "/bin/sh";
  const result = await runInstaller({}, shell);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`downloading agent-tag-${target} (latest release)`);
});

test("refuses a verified binary that cannot execute on this machine", async () => {
  await fakeUname("Linux", "x86_64");
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: { "agent-tag-linux-x64": "#!/bin/sh\nexit 126\n" },
  });
  const result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("does not run on this machine");
  expect(await readdir(installDir)).toEqual([]);
});

async function writeLinuxX64Release(): Promise<void> {
  await writeFakeRelease({
    root: releases,
    tag: "v0.3.0",
    latest: true,
    assets: { "agent-tag-linux-x64": fakeBinaryScript("0.3.0", "linux-x64") },
  });
}

test("installs on a glibc host even when ldd or a musl loader suggests musl is present", async () => {
  // Debian's `musl` package installs /lib/ld-musl-*, but getconf reports the libc in use.
  await fakeUname("Linux", "x86_64");
  await fakeTool("getconf", "glibc 2.36", 0);
  await fakeTool("ldd", "musl libc (x86_64)", 1, "stderr");
  await writeLinuxX64Release();
  const result = await runInstaller();
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(installDir, "agent-tag")).exists()).toBe(true);
});

test("falls back to ldd when getconf cannot name the libc", async () => {
  await fakeUname("Linux", "x86_64");
  await fakeTool("getconf", "getconf: GNU_LIBC_VERSION: unknown variable", 1, "stderr");
  await fakeTool("ldd", "ldd (Debian GLIBC 2.36-9+deb12u7) 2.36", 0);
  await writeLinuxX64Release();
  const result = await runInstaller();
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("refuses a musl host such as Alpine before downloading anything", async () => {
  await fakeUname("Linux", "x86_64");
  await fakeTool("getconf", "getconf: GNU_LIBC_VERSION: unknown variable", 1, "stderr");
  await fakeTool("ldd", "musl libc (x86_64)", 1, "stderr");
  await writeLinuxX64Release();
  const result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("musl-based Linux (for example Alpine) is not supported");
  expect(result.stderr).toContain("Docker image");
  expect(result.stdout).not.toContain("downloading");
  expect(await Bun.file(join(installDir, "agent-tag")).exists()).toBe(false);
});

test("explains how to pin a prerelease when no stable latest release exists", async () => {
  await fakeUname("Linux", "x86_64");
  // Only a prerelease is published, so GitHub's latest/download path has nothing.
  await writeFakeRelease({
    root: releases,
    tag: "v0.1.0-rc.1",
    assets: { "agent-tag-linux-x64": fakeBinaryScript("0.1.0-rc.1", "linux-x64") },
  });
  let result = await runInstaller();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("download failed");
  expect(result.stderr).toContain("if no stable release is published yet, pin a prerelease");
  expect(result.stderr).toContain("AGENT_TAG_VERSION=");

  result = await runInstaller({ AGENT_TAG_VERSION: "0.1.0-rc.1" });
  expect(result.exitCode).toBe(0);

  // A pinned version that does not exist gets the plain error, not the prerelease hint.
  result = await runInstaller({ AGENT_TAG_VERSION: "0.9.0" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("download failed");
  expect(result.stderr).not.toContain("pin a prerelease");
});
