import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { HELP_TEXT } from "../src/distribution.ts";
import { RELEASE_TARGETS } from "../src/release.ts";
import { SERVICE_ACTIONS } from "../src/service-manager.ts";

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

const PUBLISH_GATE = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && needs.version.outputs.publish == 'true'";

async function loadReleaseWorkflow() {
  return Bun.YAML.parse(
    await Bun.file(join(repository, ".github", "workflows", "release.yml")).text(),
  ) as { readonly jobs: Readonly<Record<string, WorkflowJob>> };
}

test("only a pushed v* tag publishes; manual runs on a tag and pull requests stay dry runs", async () => {
  const workflow = await loadReleaseWorkflow();
  const script = workflow.jobs.version?.steps[0]?.run;
  expect(script).toBeDefined();
  const resolve = async (eventName: string, ref: string) => {
    const output = join(scratch, `github-output-${eventName}-${ref.replaceAll("/", "_")}`);
    await Bun.write(output, "");
    const result = await run(["/bin/sh", "-euc", script ?? ""], scratch, {
      EVENT_NAME: eventName,
      REF: ref,
      REF_NAME: ref.replace(/^refs\/(tags|heads)\//, ""),
      RUN_NUMBER: "42",
      GITHUB_OUTPUT: output,
    });
    expect(result.exitCode).toBe(0);
    return Object.fromEntries((await Bun.file(output).text()).trim().split("\n").map((line) => line.split("=", 2)));
  };
  expect(await resolve("push", "refs/tags/v0.1.0-rc.1")).toEqual({ version: "0.1.0-rc.1", publish: "true" });
  expect(await resolve("workflow_dispatch", "refs/tags/v0.1.0-rc.1")).toEqual({ version: "0.1.0-rc.1", publish: "false" });
  expect(await resolve("workflow_dispatch", "refs/heads/main")).toEqual({ version: "0.0.0-dryrun.42", publish: "false" });
  expect(await resolve("pull_request", "refs/pull/7/merge")).toEqual({ version: "0.0.0-dryrun.42", publish: "false" });

  // Every job that can create a release or push an image re-checks the event and ref itself.
  const publishers = Object.entries(workflow.jobs)
    .filter(([, job]) =>
      job.steps.some((step) => /\bgh release create\b|\bdocker push\b|\bnpm publish\b/.test(step.run ?? "")),
    )
    .map(([name]) => name)
    .sort();
  expect(publishers).toEqual(["image", "publish"]);
  for (const name of publishers) expect(workflow.jobs[name]?.if).toBe(PUBLISH_GATE);
});

test("the GHCR push waits for every release gate and the published GitHub Release", async () => {
  const workflow = await loadReleaseWorkflow();
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
  expect(workflow.jobs.image?.if).toBe(PUBLISH_GATE);
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

test("every service:<action> script routes through the unified cross-platform service command", () => {
  const scripts: Record<string, string> = packageJson.scripts;
  const serviceScripts = Object.keys(scripts).filter((name) => name.startsWith("service:")).sort();
  expect(serviceScripts).toEqual(SERVICE_ACTIONS.map((action) => `service:${action}`).sort());
  for (const action of SERVICE_ACTIONS) expect(scripts[`service:${action}`]).toBe(`bun run src/cli.ts service ${action}`);
  expect(Object.values(scripts).join("\n")).not.toContain("manage-launchd");
});

test("operator docs only reference package scripts that exist", async () => {
  const scripts: Record<string, string> = packageJson.scripts;
  const missing: string[] = [];
  for (const file of ["README.md", "docs/install.md", "docs/operations.md"]) {
    const text = await Bun.file(join(repository, file)).text();
    // `bun run <name>` where <name> is a script, not a file path such as src/cli.ts.
    for (const match of text.matchAll(/bun run ([A-Za-z0-9:_-]+)(?![\w./<:-])/g)) {
      if (!(match[1]! in scripts)) missing.push(`${file}: ${match[0]}`);
    }
  }
  expect(missing).toEqual([]);
});
