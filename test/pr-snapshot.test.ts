import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { createGitRunner } from "../src/git/runner.ts";
import {
  addedLinesByPath,
  leftoverCommitMessage,
  mirrorPathFor,
  parseWorktreeList,
  prSnapshot,
  type PrSnapshotInput,
} from "../src/git/snapshot.ts";
import { createSourceRepo, git, recordingSpawn, withTempDir, type SourceRepo } from "./fixtures/git-fixture.ts";

const AUTHOR = { name: "Agent Tag", email: "agent-tag@users.noreply.github.com" };

function snapshotInput(repo: SourceRepo, overrides: Partial<PrSnapshotInput> = {}): PrSnapshotInput {
  return {
    taskId: repo.taskId,
    repositoryRoot: repo.root,
    repo: "octo/example",
    baseBranch: "main",
    t3Thread: { branch: repo.branch, worktreePath: repo.worktree },
    request: "Fix the typo in README\nand anything else",
    conversationId: "C123",
    threadTs: "1700000000.000100",
    actorUserId: "U123",
    commitAuthor: AUTHOR,
    gitRoot: repo.gitRoot,
    limits: { maxChangedFiles: 300, maxDiffBytes: 2_000_000, secretScan: "block" },
    runner: createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" } }),
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function slackShapedToken(): string {
  return `xoxb-${"Q".repeat(32)}`;
}

describe("prSnapshot", () => {
  test("commits leftovers with the configured author and hooks off, then fetches into the mirror", async () => {
    await withTempDir("pr-snapshot-dirty", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "README.md"), "# Example, fixed\n");
      await Bun.write(join(repo.worktree, "new.txt"), "new file\n");

      const result = await prSnapshot(snapshotInput(repo));
      if (result.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(result)}`);
      expect(result.committedLeftovers).toBe(true);
      expect(result.aheadCount).toBe(1);
      expect(result.changedFiles).toBe(2);
      expect(result.warning).toBeUndefined();
      expect(result.sha).toBe(git(repo.root, "rev-parse", `refs/heads/${repo.branch}`));
      expect(git(repo.worktree, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
        `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>`,
      );
      const message = git(repo.worktree, "log", "-1", "--format=%B");
      expect(message).toBe(
        "Agent Tag: Fix the typo in README\n\nSlack-Thread: C123/1700000000.000100\nRequested-by: U123",
      );
      expect(git(repo.worktree, "status", "--porcelain")).toBe("");

      expect(result.mirrorPath).toBe(join(repo.gitRoot, "octo", "example.git"));
      expect(result.mirrorRef).toBe(`refs/agent-tag/${repo.taskId}`);
      expect(git(result.mirrorPath, "rev-parse", result.mirrorRef)).toBe(result.sha);
      expect(git(result.mirrorPath, "rev-parse", "--is-bare-repository")).toBe("true");
      expect((await stat(result.mirrorPath)).mode & 0o777).toBe(0o700);
      expect((await stat(repo.gitRoot)).mode & 0o777).toBe(0o700);
      // `--template=`: no sample hooks are copied into the mirror.
      expect(await exists(join(result.mirrorPath, "hooks"))).toBe(false);
    });
  });

  test("keeps agent commits as they are and makes no extra commit", async () => {
    await withTempDir("pr-snapshot-committed", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "README.md"), "# Agent commit\n");
      git(repo.worktree, "commit", "--quiet", "-am", "agent: update readme");
      const agentSha = git(repo.worktree, "rev-parse", "HEAD");

      const result = await prSnapshot(snapshotInput(repo));
      if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
      expect(result.committedLeftovers).toBe(false);
      expect(result.sha).toBe(agentSha);
      expect(git(repo.worktree, "log", "-1", "--format=%s")).toBe("agent: update readme");
    });
  });

  test("reports empty when nothing is ahead of base and unchanged when the SHA was already pushed", async () => {
    await withTempDir("pr-snapshot-empty", async (directory) => {
      const repo = await createSourceRepo(directory);
      const empty = await prSnapshot(snapshotInput(repo));
      expect(empty).toEqual({ kind: "empty", sha: git(repo.root, "rev-parse", "main"), committedLeftovers: false });
      expect(await exists(repo.gitRoot)).toBe(false);

      await Bun.write(join(repo.worktree, "a.txt"), "a\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "a");
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      expect(await prSnapshot(snapshotInput(repo, { lastPushedSha: sha }))).toEqual({ kind: "unchanged", sha });
    });
  });

  test("prefers origin/<base> and only guards the delta since the last pushed SHA", async () => {
    await withTempDir("pr-snapshot-delta", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "one.txt"), "1\n");
      await Bun.write(join(repo.worktree, "two.txt"), "2\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "first");
      const pushed = git(repo.worktree, "rev-parse", "HEAD");
      await Bun.write(join(repo.worktree, "three.txt"), "3\n");
      // origin/main exists and equals main.
      git(repo.root, "update-ref", "refs/remotes/origin/main", "main");

      const result = await prSnapshot(snapshotInput(repo, { lastPushedSha: pushed }));
      if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
      expect(result.aheadCount).toBe(2);
      expect(result.changedFiles).toBe(1);
      expect(result.mergeBase).toBe(git(repo.root, "rev-parse", "main"));
    });
  });

  test("does not commit leftovers when the agent moved HEAD, but still snapshots the task branch", async () => {
    await withTempDir("pr-snapshot-head-moved", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "task.txt"), "task work\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "task work");
      const taskSha = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "switch", "--quiet", "-c", "elsewhere");
      await Bun.write(join(repo.worktree, "stray.txt"), "uncommitted on another branch\n");

      const result = await prSnapshot(snapshotInput(repo));
      if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
      expect(result.warning).toBe("head-moved");
      expect(result.committedLeftovers).toBe(false);
      expect(result.sha).toBe(taskSha);
      expect(git(repo.worktree, "status", "--porcelain")).toBe("?? stray.txt");
    });
  });

  test("never commits a .gitignored .env", async () => {
    await withTempDir("pr-snapshot-gitignore", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, ".env"), `SLACK_BOT_TOKEN=${slackShapedToken()}\n`);
      await Bun.write(join(repo.worktree, "app.txt"), "app\n");

      const result = await prSnapshot(snapshotInput(repo));
      if (result.kind !== "ready") throw new Error(`expected ready, got ${result.kind}`);
      expect(git(repo.root, "ls-tree", "-r", "--name-only", result.sha)).not.toContain(".env");
    });
  });

  test("blocks a credential in a new file without fetching or reporting the value", async () => {
    await withTempDir("pr-snapshot-secret", async (directory) => {
      const repo = await createSourceRepo(directory);
      const token = slackShapedToken();
      await Bun.write(join(repo.worktree, "config", "settings.ts"), `export const token = "${token}";\n`);
      await Bun.write(join(repo.worktree, "clean.txt"), "clean\n");

      const result = await prSnapshot(snapshotInput(repo));
      expect(result).toMatchObject({
        kind: "blocked",
        committedLeftovers: true,
        detail: { reason: "secret", paths: ["config/settings.ts"], patternNames: ["slack-token"] },
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(await exists(mirrorPathFor(repo.gitRoot, "octo/example"))).toBe(false);

      // `secretScan: "off"` lets the operator opt out.
      const allowed = await prSnapshot(snapshotInput(repo, { limits: { maxChangedFiles: 300, maxDiffBytes: 2_000_000, secretScan: "off" } }));
      expect(allowed.kind).toBe("ready");
    });
  });

  test("blocks a credential in a commit message and in a binary-looking file", async () => {
    await withTempDir("pr-snapshot-secret-message", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "x.txt"), "x\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", `add x\n\nkey ${`AKIA${"Q".repeat(16)}`}`);
      const message = await prSnapshot(snapshotInput(repo));
      expect(message).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["commit message"], patternNames: ["aws-access-key"] } });

      const binaryRepo = await createSourceRepo(join(directory, "binary"));
      await Bun.write(join(binaryRepo.worktree, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${slackShapedToken()}\n`)]));
      const binary = await prSnapshot(snapshotInput(binaryRepo));
      expect(binary).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["blob.bin"] } });
    });
  });

  test("blocks changes over the file-count or byte limits", async () => {
    await withTempDir("pr-snapshot-size", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "a.txt"), "a\n");
      await Bun.write(join(repo.worktree, "b.txt"), "b\n");
      const files = await prSnapshot(snapshotInput(repo, { limits: { maxChangedFiles: 1, maxDiffBytes: 2_000_000, secretScan: "block" } }));
      expect(files).toMatchObject({ kind: "blocked", detail: { reason: "size", changedFiles: 2, maxChangedFiles: 1 } });

      const bytes = await prSnapshot(snapshotInput(repo, { limits: { maxChangedFiles: 300, maxDiffBytes: 50, secretScan: "block" } }));
      expect(bytes).toMatchObject({ kind: "blocked", detail: { reason: "size", maxDiffBytes: 50 } });
      if (bytes.kind === "blocked" && bytes.detail.reason === "size") expect(bytes.detail.diffBytes).toBeGreaterThan(50);
      expect(await exists(mirrorPathFor(repo.gitRoot, "octo/example"))).toBe(false);
    });
  });

  test("planted hooks, hooksPath, fsmonitor, textconv and external diff never run", async () => {
    await withTempDir("pr-snapshot-hostile", async (directory) => {
      const repo = await createSourceRepo(directory);
      const markers = join(directory, "markers");
      await mkdir(markers);
      const script = async (path: string, name: string) => {
        await Bun.write(path, `#!/bin/sh\nenv > "${markers}/${name}"\ncat >/dev/null 2>&1\nexit 0\n`);
        await chmod(path, 0o755);
      };
      const commonDir = join(repo.root, ".git");
      for (const hook of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg", "pre-push", "post-checkout", "reference-transaction"]) {
        await script(join(commonDir, "hooks", hook), `hook-${hook}`);
      }
      const hooksPath = join(directory, "evil-hooks");
      await mkdir(hooksPath);
      for (const hook of ["pre-commit", "post-commit", "reference-transaction"]) await script(join(hooksPath, hook), `hookspath-${hook}`);
      await script(join(directory, "fsmonitor.sh"), "fsmonitor");
      await script(join(directory, "textconv.sh"), "textconv");
      await script(join(directory, "extdiff.sh"), "extdiff");
      git(repo.root, "config", "core.hooksPath", hooksPath);
      git(repo.root, "config", "core.fsmonitor", join(directory, "fsmonitor.sh"));
      git(repo.root, "config", "diff.evil.textconv", join(directory, "textconv.sh"));
      git(repo.root, "config", "diff.external", join(directory, "extdiff.sh"));
      git(repo.root, "config", "uploadpack.packObjectsHook", join(directory, "textconv.sh"));
      await Bun.write(join(repo.worktree, ".gitattributes"), "* diff=evil\n");
      await Bun.write(join(repo.worktree, "README.md"), "# changed\n");

      const recorder = recordingSpawn();
      const result = await prSnapshot(snapshotInput(repo, { runner: createGitRunner({ spawn: recorder.spawn }) }));
      expect(result.kind).toBe("ready");
      expect(await readdir(markers)).toEqual([]);
      // No credential is ever handed to a snapshot command.
      for (const call of recorder.calls) {
        expect(call.env.GIT_ASKPASS).toBeUndefined();
        expect(call.env.AGENT_TAG_GIT_TOKEN).toBeUndefined();
        expect(call.argv).toContain("core.hooksPath=/dev/null");
        expect(call.argv).toContain("core.fsmonitor=false");
      }
      const diffCalls = recorder.calls.filter((call) => call.argv.includes("diff"));
      expect(diffCalls.length).toBeGreaterThan(0);
      for (const call of diffCalls) {
        expect(call.argv).toContain("--no-ext-diff");
      }

      // Positive control: the planted scripts are live for an unhardened git.
      await Bun.write(join(repo.worktree, "README.md"), "# changed again\n");
      git(repo.worktree, "status", "--porcelain");
      git(repo.worktree, "diff");
      git(repo.worktree, "commit", "--quiet", "-am", "control");
      const fired = await readdir(markers);
      expect(fired).toContain("hookspath-pre-commit");
      expect(fired).toContain("fsmonitor");
      expect(fired.some((name) => name === "extdiff" || name === "textconv")).toBe(true);
    });
  }, 30_000);

  test("falls back to `git worktree list` when T3 gives no worktree path", async () => {
    await withTempDir("pr-snapshot-fallback", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "file.txt"), "content\n");
      const result = await prSnapshot(snapshotInput(repo, { t3Thread: { branch: null, worktreePath: null } }));
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") expect(result.branch).toBe(repo.branch);

      const missing = await prSnapshot(snapshotInput(repo, { taskId: "other-task", t3Thread: { branch: null, worktreePath: null } }));
      expect(missing).toEqual({ kind: "no-worktree" });
    });
  });

  test("blocks a secret that one new commit adds and a later commit deletes (the push would carry it)", async () => {
    await withTempDir("pr-snapshot-history-secret", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "config.txt"), `token=${slackShapedToken()}\n`);
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "add config");
      const first = await prSnapshot(snapshotInput(repo));
      expect(first).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["config.txt"] } });

      // Deleting the secret without rewriting history must not unblock: the blob is still in the push.
      await Bun.write(join(repo.worktree, "config.txt"), "token=from-env\n");
      git(repo.worktree, "commit", "--quiet", "-am", "remove token");
      git(repo.worktree, "rm", "--quiet", "config.txt");
      git(repo.worktree, "commit", "--quiet", "-m", "drop config");
      const second = await prSnapshot(snapshotInput(repo));
      if (second.kind !== "blocked") throw new Error(`expected blocked, got ${JSON.stringify(second)}`);
      expect(second.detail).toMatchObject({ reason: "secret", paths: ["config.txt"], patternNames: ["slack-token"] });
      expect(await exists(join(repo.gitRoot, "octo", "example.git"))).toBe(false);
    });
  });

  test("blocks a secret added only by a merge commit's own changes", async () => {
    await withTempDir("pr-snapshot-evil-merge", async (directory) => {
      const repo = await createSourceRepo(directory);
      git(repo.worktree, "checkout", "--quiet", "-b", "side");
      await Bun.write(join(repo.worktree, "side.txt"), "side\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "side");
      git(repo.worktree, "checkout", "--quiet", repo.branch);
      await Bun.write(join(repo.worktree, "main.txt"), "main\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "main");
      git(repo.worktree, "merge", "--quiet", "--no-commit", "side");
      await Bun.write(join(repo.worktree, "merge.txt"), `${slackShapedToken()}\n`);
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "merge side");
      git(repo.worktree, "rm", "--quiet", "merge.txt");
      git(repo.worktree, "commit", "--quiet", "-m", "drop merge.txt");
      const result = await prSnapshot(snapshotInput(repo));
      expect(result).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["merge.txt"] } });
    });
  });

  test("history churn beyond maxDiffBytes is a size block even when the net diff is small", async () => {
    await withTempDir("pr-snapshot-history-size", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "big.txt"), "x\n".repeat(5_000));
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "big");
      git(repo.worktree, "rm", "--quiet", "big.txt");
      await Bun.write(join(repo.worktree, "small.txt"), "small\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "small");
      const result = await prSnapshot(snapshotInput(repo, { limits: { maxChangedFiles: 300, maxDiffBytes: 2_000, secretScan: "block" } }));
      if (result.kind !== "blocked" || result.detail.reason !== "size") throw new Error(`expected size block, got ${JSON.stringify(result)}`);
      expect(result.detail.diffBytes).toBeLessThan(2_000);
      expect(result.detail.historyBytes).toBeGreaterThan(2_000);

      // Turning the secret scan off skips only the credential checks, not the history byte limit.
      const unscanned = await prSnapshot(snapshotInput(repo, { limits: { maxChangedFiles: 300, maxDiffBytes: 2_000, secretScan: "off" } }));
      expect(unscanned).toMatchObject({ kind: "blocked", detail: { reason: "size" } });
    });
  });

  test("scans the stored commits, not a refs/replace/* stand-in that the fetch would not transfer", async () => {
    await withTempDir("pr-snapshot-replace", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "config.txt"), `token=${slackShapedToken()}\n`);
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "add config");
      const secretCommit = git(repo.worktree, "rev-parse", "HEAD");
      // A clean look-alike with the same parent, swapped in for the secret commit by a replace ref.
      git(repo.worktree, "reset", "--quiet", "--hard", "HEAD~1");
      await Bun.write(join(repo.worktree, "config.txt"), "token=from-env\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "add config");
      const clean = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "reset", "--quiet", "--hard", secretCommit);
      git(repo.worktree, "replace", secretCommit, clean);
      git(repo.worktree, "reset", "--quiet", "--hard", "HEAD");
      expect(git(repo.worktree, "show", "HEAD:config.txt")).toBe("token=from-env");

      const result = await prSnapshot(snapshotInput(repo));
      expect(result).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["config.txt"] } });
      expect(await exists(mirrorPathFor(repo.gitRoot, "octo/example"))).toBe(false);
    });
  });

  test("scans history the fetch transfers even when info/grafts hides a commit", async () => {
    await withTempDir("pr-snapshot-grafts", async (directory) => {
      const repo = await createSourceRepo(directory);
      const base = git(repo.worktree, "rev-parse", "HEAD");
      await Bun.write(join(repo.worktree, "config.txt"), `token=${slackShapedToken()}\n`);
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "add config");
      git(repo.worktree, "rm", "--quiet", "config.txt");
      await Bun.write(join(repo.worktree, "small.txt"), "small\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", "drop config");
      const tip = git(repo.worktree, "rev-parse", "HEAD");
      // The graft claims the tip's parent is base, hiding the secret commit from log.
      const commonDir = git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
      await mkdir(join(commonDir, "info"), { recursive: true });
      await Bun.write(join(commonDir, "info", "grafts"), `${tip} ${base}\n`);

      const result = await prSnapshot(snapshotInput(repo));
      expect(result).toMatchObject({ kind: "blocked", detail: { reason: "secret", paths: ["config.txt"] } });
    });
  });

  test("fails closed when commit messages exceed the output cap instead of scanning a prefix", async () => {
    await withTempDir("pr-snapshot-message-truncation", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "one.txt"), "1\n");
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "--quiet", "-m", `leaked ${slackShapedToken()}`);
      await Bun.write(join(repo.worktree, "two.txt"), "2\n");
      git(repo.worktree, "add", "-A");
      // The newer message comes first in `git log` and fills the cap, pushing the older one past it.
      git(repo.worktree, "commit", "--quiet", "-m", `padding\n\n${"p".repeat(8_000)}`);
      const runner = createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" }, maxOutputBytes: 4_096 });
      const result = await prSnapshot(snapshotInput(repo, { runner }));
      expect(result).toMatchObject({ kind: "failed", code: "output-truncated" });
      expect(await exists(join(repo.gitRoot, "octo", "example.git"))).toBe(false);
    });
  });

  test("fails closed when the changed-file count output is cut, so maxChangedFiles cannot be undercounted", async () => {
    await withTempDir("pr-snapshot-numstat-truncation", async (directory) => {
      const repo = await createSourceRepo(directory);
      for (let index = 0; index < 400; index += 1) await Bun.write(join(repo.worktree, `file-${index}.txt`), "x\n");
      const runner = createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" }, maxOutputBytes: 4_096 });
      const result = await prSnapshot(
        snapshotInput(repo, { runner, limits: { maxChangedFiles: 350, maxDiffBytes: 2_000_000, secretScan: "block" } }),
      );
      expect(result).toMatchObject({ kind: "failed", code: "output-truncated" });
    });
  });

  test("never commits in a T3-supplied path that is not a worktree of the configured repository", async () => {
    await withTempDir("pr-snapshot-foreign-worktree", async (directory) => {
      const repo = await createSourceRepo(directory);
      const foreign = join(directory, "foreign");
      await mkdir(foreign);
      git(foreign, "init", "--quiet", "-b", repo.branch);
      await Bun.write(join(foreign, "keep.txt"), "kept\n");
      git(foreign, "add", "-A");
      git(foreign, "commit", "--quiet", "-m", "foreign initial");
      await Bun.write(join(foreign, "dirty.txt"), "uncommitted\n");

      const result = await prSnapshot(snapshotInput(repo, { t3Thread: { branch: repo.branch, worktreePath: foreign } }));
      // Falls back to the real task worktree, which is clean.
      expect(result.kind).toBe("empty");
      expect(git(foreign, "rev-list", "--count", "HEAD")).toBe("1");
      expect(git(foreign, "status", "--porcelain")).toBe("?? dirty.txt");

      // A path inside the real worktree still works.
      await mkdir(join(repo.worktree, "sub"));
      await Bun.write(join(repo.worktree, "sub", "file.txt"), "content\n");
      const inside = await prSnapshot(snapshotInput(repo, { t3Thread: { branch: repo.branch, worktreePath: join(repo.worktree, "sub") } }));
      expect(inside).toMatchObject({ kind: "ready", committedLeftovers: true });
    });
  });

  test("returns a failure code instead of throwing", async () => {
    await withTempDir("pr-snapshot-failure", async (directory) => {
      const repo = await createSourceRepo(directory);
      await Bun.write(join(repo.worktree, "file.txt"), "content\n");
      expect(await prSnapshot(snapshotInput(repo, { baseBranch: "does-not-exist" }))).toMatchObject({ kind: "failed", code: "base-missing" });
      expect(await prSnapshot(snapshotInput(repo, { taskId: "../escape" }))).toMatchObject({ kind: "failed", code: "invalid-task-id" });
      expect(await prSnapshot(snapshotInput(repo, { repo: "../x" }))).toMatchObject({ kind: "failed", code: "invalid-repo" });
    });
  });
});

describe("snapshot helpers", () => {
  test("leftover commit subject is trimmed to 72 characters", () => {
    const message = leftoverCommitMessage({ request: `\n  ${"x".repeat(100)}\nmore`, conversationId: "C1", threadTs: "1.2", actorUserId: "U1" });
    const subject = message.split("\n")[0]!;
    expect(subject.length).toBe(72);
    expect(subject).toStartWith("Agent Tag: xxx");
  });

  test("parses worktree porcelain output", () => {
    expect(parseWorktreeList("worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0detached\0\0")).toEqual([
      { path: "/r", branch: "refs/heads/main" },
      { path: "/w" },
    ]);
  });

  test("added lines exclude file headers and removed lines", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "+++plus content",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+bee",
    ].join("\n");
    expect(addedLinesByPath(diff)).toEqual({ text: "new\n++plus content\nbee", paths: ["a.txt", "a.txt", "b.txt"] });
    const combined = ["diff --cc f", "--- a/f", "+++ b/f", "@@@ -2,0 -2,1 +2,2 @@@", "+ b", "++evil", "- gone", "  same"].join("\n");
    expect(addedLinesByPath(combined)).toEqual({ text: "b\nevil", paths: ["f", "f"] });
  });
});
