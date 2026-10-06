import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { RELEASE_TARGETS } from "../src/release.ts";

const repository = resolve(import.meta.dir, "..");
const bunVersion = packageJson.packageManager.replace(/^bun@/, "");
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "agent-tag-distribution-files-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(command: readonly string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", ...env } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("the Dockerfile pins the repository Bun version, drops root, and declares the data volume", async () => {
  const dockerfile = await Bun.file(join(repository, "Dockerfile")).text();
  expect(dockerfile).toContain(`ARG BUN_VERSION=${bunVersion}`);
  expect(dockerfile).toContain("FROM oven/bun:${BUN_VERSION} AS build");
  expect(dockerfile).toContain("FROM oven/bun:${BUN_VERSION}-slim");
  expect(dockerfile).toContain("RUN bun install --frozen-lockfile");
  expect(dockerfile).toContain("AGENT_TAG_INSTALL_KIND=container");
  expect(dockerfile).toMatch(/^USER bun$/m);
  expect(dockerfile).toMatch(/^VOLUME \["\/data"\]$/m);
  const dockerignore = await Bun.file(join(repository, ".dockerignore")).text();
  expect(dockerignore.split("\n")[0]).toBe("*");
});

test("the Dockerfile bundle step yields a runnable container build outside the repository", async () => {
  const outfile = join(scratch, "agent-tag.js");
  const build = await run(
    [
      process.execPath,
      "build",
      "src/cli.ts",
      "--target=bun",
      "--sourcemap=inline",
      '--define=AGENT_TAG_BUILD_VERSION="0.5.0"',
      '--define=AGENT_TAG_BUILD_COMMIT=""',
      "--outfile",
      outfile,
    ],
    repository,
  );
  expect(build.exitCode).toBe(0);
  const env = { AGENT_TAG_INSTALL_KIND: "container" };
  const version = await run([process.execPath, outfile, "version", "--json"], scratch, env);
  expect(JSON.parse(version.stdout)).toMatchObject({ version: "0.5.0", commit: null, installKind: "container" });
  const update = await run([process.execPath, outfile, "update"], scratch, env);
  expect(update.exitCode).toBe(1);
  expect(update.stderr).toContain("pull a newer image");
});

test("the release workflow builds, smoke-tests, and publishes every target", async () => {
  const workflow = await Bun.file(join(repository, ".github", "workflows", "release.yml")).text();
  expect(workflow).toContain('tags: ["v*"]');
  expect(workflow).toContain("pull_request:");
  expect(workflow).toContain(`bun-version: ${bunVersion}`);
  for (const target of RELEASE_TARGETS) {
    expect(workflow).toContain(`target: ${target}`);
    expect(workflow).toMatch(new RegExp(`targets: .*\\b${target}\\b`));
  }
  expect(workflow).toContain("needs.version.outputs.publish == 'true'");
  expect(workflow).toContain("dist/SHA256SUMS");
  // Third-party actions stay pinned to full commit SHAs, as in ci.yml.
  for (const match of workflow.matchAll(/uses: (\S+)/g)) {
    expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
  }
});

test("install.sh is valid POSIX sh", async () => {
  const result = await run(["/bin/sh", "-n", join(repository, "install.sh")], repository);
  expect(result.exitCode).toBe(0);
  if (await Bun.file("/bin/dash").exists()) {
    expect((await run(["/bin/dash", "-n", join(repository, "install.sh")], repository)).exitCode).toBe(0);
  }
});
