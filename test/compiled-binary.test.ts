import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRelease } from "../scripts/build-release.ts";
import { detectReleaseTarget, parseSha256Sums, sha256Hex } from "../src/release.ts";

const host = detectReleaseTarget(process.platform, process.arch);
let outdir: string;

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "agent-tag-compiled-test-"));
});

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true });
});

async function run(
  command: readonly string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Run from the temporary directory so nothing can fall back to the repository's node_modules.
  const child = Bun.spawn([...command], {
    cwd: outdir,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test.skipIf(host === undefined)(
  "compiles a standalone host binary that runs help, version, and refuses a missing release",
  async () => {
    if (host === undefined) return;
    const sums = await buildRelease({ targets: [host], version: "0.0.1-test.1", outdir, sumsOnly: false, smoke: true });
    expect((await readdir(outdir)).sort()).toEqual(["SHA256SUMS", `agent-tag-${host}`]);
    const binary = join(outdir, `agent-tag-${host}`);
    expect(parseSha256Sums(sums).get(`agent-tag-${host}`)).toBe(sha256Hex(await Bun.file(binary).bytes()));

    const help = await run([binary, "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("agent-tag update [--check] [--version X]");

    const version = await run([binary, "version", "--json"]);
    expect(version.exitCode).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ version: "0.0.1-test.1", target: host, installKind: "binary" });

    // An unreachable release mirror must fail before anything is written beside the binary.
    const update = await run([binary, "update", "--version", "0.0.2"], {
      AGENT_TAG_RELEASE_BASE_URL: "http://127.0.0.1:9/releases",
    });
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toStartWith("agent-tag: downloading agent-tag 0.0.2");
    expect(update.stderr.trim().split("\n").at(-1)).toStartWith("agent-tag: ");
    expect((await readdir(outdir)).sort()).toEqual(["SHA256SUMS", `agent-tag-${host}`]);

    // An unknown command is a plain usage error, not a Bun crash with an embedded code frame.
    const unknown = await run([binary, "onbaord"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toStartWith("agent-tag: unknown command: onbaord\nusage: agent-tag onboard");
    expect(unknown.stderr).not.toContain("cli.ts");

    // doctor and onboard load their bundled JSON (T3 pin, package engines, config template, Slack
    // manifest) from the binary, not from a source tree that does not exist beside it. HOME points
    // into the temporary directory so neither command can read or write the operator's real home.
    const isolated = { HOME: join(outdir, "home") };
    const doctor = await run([binary, "doctor", join(outdir, "missing.json")], isolated);
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain("PASS  bun-version");
    expect(doctor.stdout).toContain(`config not found at ${join(outdir, "missing.json")}`);
    expect(`${doctor.stdout}${doctor.stderr}`).not.toContain("$bunfs");

    const onboard = await run([binary, "onboard", "--dir", join(outdir, "home", ".agent-tag")], isolated);
    expect(onboard.exitCode).toBe(1);
    expect(onboard.stdout).toContain("Agent Tag onboarding");
    expect(onboard.stderr).toBe("agent-tag onboard: pass --accept-risk to acknowledge trusted same-user execution in non-interactive mode\n");
    expect((await readdir(outdir)).sort()).toEqual(["SHA256SUMS", `agent-tag-${host}`]);
  },
  120_000,
);

test.skipIf(host === undefined)(
  "a compiled binary updates itself in place from a release mirror",
  async () => {
    if (host === undefined) return;
    const asset = `agent-tag-${host}`;
    const installDir = join(outdir, "install");
    const releaseDir = join(outdir, "release");
    await buildRelease({ targets: [host], version: "0.0.1", outdir: installDir, sumsOnly: false, smoke: false });
    await buildRelease({ targets: [host], version: "0.0.2", outdir: releaseDir, sumsOnly: false, smoke: false });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/releases/latest") return new Response(null, { status: 302, headers: { location: "/releases/tag/v0.0.2" } });
        if (path === `/releases/download/v0.0.2/${asset}`) return new Response(Bun.file(join(releaseDir, asset)));
        if (path === "/releases/download/v0.0.2/SHA256SUMS") return new Response(Bun.file(join(releaseDir, "SHA256SUMS")));
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const binary = join(installDir, asset);
      const env = { AGENT_TAG_RELEASE_BASE_URL: `${server.url.origin}/releases` };
      const check = await run([binary, "update", "--check"], env);
      expect(check.stdout).toContain("agent-tag 0.0.2 is available (installed: 0.0.1)");

      const update = await run([binary, "update"], env);
      expect(update.stderr).toBe(`agent-tag: downloading agent-tag 0.0.2 (${asset})\n`);
      expect(update.exitCode).toBe(0);
      expect(update.stdout).toContain("Updated agent-tag 0.0.1 -> 0.0.2");
      expect(sha256Hex(await Bun.file(binary).bytes())).toBe(sha256Hex(await Bun.file(join(releaseDir, asset)).bytes()));
      expect(JSON.parse((await run([binary, "version", "--json"])).stdout)).toMatchObject({ version: "0.0.2" });
      expect((await readdir(installDir)).sort()).toEqual(["SHA256SUMS", asset]);

      const again = await run([binary, "update"], env);
      expect(again.stdout).toContain("agent-tag 0.0.2 is up to date");
    } finally {
      void server.stop(true);
    }
  },
  180_000,
);

test.skipIf(host === undefined)(
  "bundles the undici Socket Mode transport into compiled binaries",
  async () => {
    const probe = join(outdir, "socket-probe");
    const build = await run([
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "fixtures", "compiled-socket-probe.ts"),
      "--outfile",
      probe,
    ]);
    expect(build.exitCode).toBe(0);
    const result = await run([probe]);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("socket-mode-transport-ok");
  },
  60_000,
);

test.skipIf(host === undefined)(
  "a compiled binary generates service units that run the binary itself",
  async () => {
    const probe = join(outdir, "service-unit-probe");
    const build = await run([
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "fixtures", "compiled-service-unit-probe.ts"),
      "--outfile",
      probe,
    ]);
    expect(build.exitCode).toBe(0);
    // Invoked through a symlink, the unit still names the real file that `agent-tag update` replaces.
    const link = join(outdir, "service-unit-probe-link");
    await symlink(probe, link);
    const result = await run([link, "/cfg/agent-tag.json"]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      program: { kind: "binary", binaryPath: await realpath(probe) },
      configPath: "/cfg/agent-tag.json",
      workingDirectory: "/cfg",
    });
  },
  60_000,
);
