import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { HELP_TEXT } from "../src/distribution.ts";
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

interface WorkflowStep {
  readonly run?: string;
  readonly if?: string;
}
interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStep[];
}

test("the GHCR push waits for every release gate and the published GitHub Release", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(repository, ".github", "workflows", "release.yml")).text(),
  ) as { readonly jobs: Readonly<Record<string, WorkflowJob>> };
  const needs = (name: string): readonly string[] => {
    const value = workflow.jobs[name]?.needs ?? [];
    return typeof value === "string" ? [value] : value;
  };
  const pushers = Object.entries(workflow.jobs)
    .filter(([, job]) => job.steps.some((step) => step.run?.includes("docker push") === true))
    .map(([name]) => name);
  expect(pushers).toEqual(["image"]);
  expect(needs("image")).toEqual(expect.arrayContaining(["docker", "publish"]));
  expect(needs("publish")).toEqual(expect.arrayContaining(["build", "smoke", "docker"]));
  expect(workflow.jobs.build?.steps.some((step) => step.run === "bun run check")).toBe(true);
  expect(workflow.jobs.image?.if).toBe("needs.version.outputs.publish == 'true'");
  expect(workflow.jobs.image?.permissions?.packages).toBe("write");
  // Only the push job may write packages; the PR-reachable verify job stays read-only.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "image") expect(job.permissions?.packages).toBeUndefined();
  }
});

test("install snippets pin a prerelease while the project is not generally available", async () => {
  const readme = await Bun.file(join(repository, "README.md")).text();
  if (!readme.includes("not yet generally available")) return;
  for (const document of ["README.md", "docs/install.md"]) {
    const text = await Bun.file(join(repository, document)).text();
    const snippets = text.split("\n").filter((line) => line.includes("install.sh |"));
    expect(snippets.length).toBeGreaterThan(0);
    for (const line of snippets) expect(line).toMatch(/\| AGENT_TAG_VERSION=\d+\.\d+\.\d+-\S+ sh$/);
  }
});

test("install.sh only suggests commands the CLI ships", async () => {
  const script = await Bun.file(join(repository, "install.sh")).text();
  const suggested = [...script.matchAll(/^\s*say ".*?\bagent-tag ([a-z][a-z-]*)/gm)].map((match) => match[1]);
  expect(suggested.length).toBeGreaterThan(0);
  for (const command of suggested) expect(HELP_TEXT).toContain(`agent-tag ${command} `);
});

test("install.sh is valid POSIX sh", async () => {
  const result = await run(["/bin/sh", "-n", join(repository, "install.sh")], repository);
  expect(result.exitCode).toBe(0);
  if (await Bun.file("/bin/dash").exists()) {
    expect((await run(["/bin/dash", "-n", join(repository, "install.sh")], repository)).exitCode).toBe(0);
  }
});
