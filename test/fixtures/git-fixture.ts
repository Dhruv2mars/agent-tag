// Real-git fixtures for the PR workflow tests. Fixture setup uses its own isolated git invocations
// (no global or system config), separate from the runner under test.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunGitSpawn, type GitSpawn, type GitSpawnRequest } from "../../src/git/runner.ts";

export const FIXTURE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent-agent-tag-fixture-home",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture Agent",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Agent",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  LC_ALL: "C",
};

/** Runs fixture git and returns trimmed stdout; throws with stderr on failure. */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: FIXTURE_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

export async function withTempDir<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const created = await mkdtemp(join(tmpdir(), `agent-tag-${prefix}-`));
  const directory = await realpath(created);
  try {
    return await body(directory);
  } finally {
    if (!created.startsWith(join(tmpdir(), `agent-tag-${prefix}-`))) throw new Error(`refusing to remove ${created}`);
    await rm(created, { recursive: true, force: true });
  }
}

export interface SourceRepo {
  readonly root: string;
  readonly worktree: string;
  readonly branch: string;
  readonly taskId: string;
  readonly gitRoot: string;
}

/** A repo with one commit on `main` and a linked worktree on `agent-tag/<taskId>`. */
export async function createSourceRepo(directory: string, taskId = "task-1"): Promise<SourceRepo> {
  const root = join(directory, "repo");
  const worktree = join(directory, "worktree");
  const branch = `agent-tag/${taskId}`;
  Bun.spawnSync(["mkdir", "-p", root]);
  git(root, "init", "--quiet", "-b", "main");
  await Bun.write(join(root, "README.md"), "# Example\n");
  await Bun.write(join(root, ".gitignore"), ".env\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  git(root, "worktree", "add", "--quiet", "-b", branch, worktree, "main");
  return { root, worktree, branch, taskId, gitRoot: join(directory, "data", "git") };
}

export interface RecordedSpawn extends GitSpawnRequest {}

/** Wraps the real spawn and records every argv and env. */
export function recordingSpawn(): { readonly spawn: GitSpawn; readonly calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  return {
    calls,
    spawn: (request) => {
      calls.push({ ...request, argv: [...request.argv], env: { ...request.env } });
      return bunGitSpawn(request);
    },
  };
}

/** A token-shaped canary built at runtime so the source file never contains a credential pattern. */
export function canaryToken(): string {
  return `github_pat_${crypto.randomUUID().replaceAll("-", "")}${"Z".repeat(20)}`;
}
