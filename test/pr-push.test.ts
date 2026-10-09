import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ASKPASS_SCRIPT,
  ASKPASS_TOKEN_ENV,
  ensureAskpassScript,
  githubRemoteUrl,
  parsePushPorcelain,
  PushError,
  pushToRemote,
  type PushInput,
} from "../src/git/push.ts";
import { createGitRunner, type GitRunner, type GitSpawn } from "../src/git/runner.ts";
import { prSnapshot } from "../src/git/snapshot.ts";
import { SecretString } from "../src/security/secret-file.ts";
import { scanForSecrets } from "../src/security/secret-scan.ts";
import { canaryToken, createSourceRepo, git, recordingSpawn, withTempDir, type SourceRepo } from "./fixtures/git-fixture.ts";

interface Prepared {
  readonly repo: SourceRepo;
  readonly sha: string;
  readonly mirrorPath: string;
  readonly remoteBase: string;
  readonly remotePath: string;
  readonly askpassPath: string;
}

function isolatedRunner(spawn?: GitSpawn): GitRunner {
  return createGitRunner({
    parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" },
    ...(spawn === undefined ? {} : { spawn }),
  });
}

/** Source repo with one task commit snapshotted into a mirror, plus an empty bare remote at `<remoteBase>/octo/example.git`. */
async function prepare(directory: string): Promise<Prepared> {
  const repo = await createSourceRepo(directory);
  await Bun.write(join(repo.worktree, "feature.txt"), "feature\n");
  const snapshot = await prSnapshot({
    taskId: repo.taskId,
    repositoryRoot: repo.root,
    repo: "octo/example",
    baseBranch: "main",
    t3Thread: { branch: repo.branch, worktreePath: repo.worktree },
    request: "Add feature",
    conversationId: "C1",
    threadTs: "1.1",
    actorUserId: "U1",
    commitAuthor: { name: "Agent Tag", email: "agent-tag@users.noreply.github.com" },
    gitRoot: repo.gitRoot,
    limits: { maxChangedFiles: 300, maxDiffBytes: 2_000_000, secretScan: "block" },
    runner: isolatedRunner(),
  });
  if (snapshot.kind !== "ready") throw new Error(`fixture snapshot was ${snapshot.kind}`);
  const remoteBase = join(directory, "remote");
  const remotePath = join(remoteBase, "octo", "example.git");
  await mkdir(remotePath, { recursive: true });
  git(remotePath, "init", "--quiet", "--bare");
  const askpassPath = await ensureAskpassScript(repo.gitRoot);
  return { repo, sha: snapshot.sha, mirrorPath: snapshot.mirrorPath, remoteBase, remotePath, askpassPath };
}

function pushInput(prepared: Prepared, token: string, overrides: Partial<PushInput> = {}): PushInput {
  return {
    runner: isolatedRunner(),
    mirrorPath: prepared.mirrorPath,
    remoteUrl: githubRemoteUrl(`file://${prepared.remoteBase}`, "octo/example", { allowTestRemote: true }),
    sha: prepared.sha,
    headBranch: prepared.repo.branch,
    token: new SecretString(token),
    askpassPath: prepared.askpassPath,
    allowTestRemote: true,
    ...overrides,
  };
}

function remoteHead(prepared: Prepared, branch: string): string | undefined {
  const result = Bun.spawnSync(["git", "-C", prepared.remotePath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

describe("pushToRemote", () => {
  test("pushes the SHA, holds the token only in the push child's env, and never writes it to disk", async () => {
    await withTempDir("pr-push-basic", async (directory) => {
      const prepared = await prepare(directory);
      const token = canaryToken();
      const recorder = recordingSpawn();
      const runner = isolatedRunner(recorder.spawn);

      const first = await pushToRemote(pushInput(prepared, token, { runner }));
      expect(first).toEqual({ kind: "pushed", status: "created", remoteRef: `refs/heads/${prepared.repo.branch}` });
      expect(remoteHead(prepared, prepared.repo.branch)).toBe(prepared.sha);
      expect(await pushToRemote(pushInput(prepared, token, { runner }))).toMatchObject({ kind: "pushed", status: "up-to-date" });

      // Argv/env recorder: the token is never in argv and is only in AGENT_TAG_GIT_TOKEN of push children.
      for (const call of recorder.calls) {
        expect(call.argv.join("\0")).not.toContain(token);
        const isPush = call.argv.includes("push");
        for (const [key, value] of Object.entries(call.env)) {
          if (value.includes(token)) expect(isPush && key === ASKPASS_TOKEN_ENV).toBe(true);
        }
        if (isPush) {
          expect(call.env[ASKPASS_TOKEN_ENV]).toBe(token);
          expect(call.env.GIT_ASKPASS).toBe(prepared.askpassPath);
          const argv = call.argv;
          expect(argv[argv.indexOf("credential.helper=") - 1]).toBe("-c");
          expect(argv).toContain("http.followRedirects=false");
          expect(argv).toContain("--no-verify");
          expect(argv).toContain("core.hooksPath=/dev/null");
          expect(argv.at(-1)).toBe(`${prepared.sha}:refs/heads/${prepared.repo.branch}`);
          expect(argv.some((arg) => arg.startsWith("+"))).toBe(false);
          expect(argv).not.toContain("--force");
        } else {
          expect(call.env[ASKPASS_TOKEN_ENV]).toBeUndefined();
          expect(call.env.GIT_ASKPASS).toBeUndefined();
        }
      }
      expect(recorder.calls.filter((call) => call.argv.includes("push")).length).toBe(2);

      // Not in any git config, remote URL, or file under the fixture tree (including .git directories).
      for (const config of [
        join(prepared.repo.root, ".git", "config"),
        join(prepared.mirrorPath, "config"),
        join(prepared.remotePath, "config"),
      ]) {
        expect(await readFile(config, "utf8")).not.toContain(token);
      }
      expect(git(prepared.repo.worktree, "remote", "-v")).not.toContain(token);
      const scan = await scanForSecrets({
        roots: [directory, join(prepared.repo.root, ".git"), prepared.mirrorPath, prepared.remotePath],
        canaries: [{ name: "github-pat", secret: new SecretString(token) }],
      });
      expect(scan.findings.filter((finding) => finding.kind === "exact-secret")).toEqual([]);
    });
  });

  test("a non-fast-forward is reported as push.rejected and nothing is overwritten", async () => {
    await withTempDir("pr-push-nonff", async (directory) => {
      const prepared = await prepare(directory);
      const token = canaryToken();
      await pushToRemote(pushInput(prepared, token));

      // Someone else pushes to the PR branch from a separate clone.
      const other = join(directory, "other");
      Bun.spawnSync(["git", "clone", "--quiet", prepared.remotePath, other], {
        env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      git(other, "switch", "--quiet", prepared.repo.branch);
      await Bun.write(join(other, "theirs.txt"), "theirs\n");
      git(other, "add", "-A");
      git(other, "commit", "--quiet", "-m", "their change");
      git(other, "push", "--quiet", "origin", prepared.repo.branch);
      const theirs = git(other, "rev-parse", "HEAD");

      // Our follow-up commit, snapshotted into the mirror.
      await Bun.write(join(prepared.repo.worktree, "ours.txt"), "ours\n");
      git(prepared.repo.worktree, "add", "-A");
      git(prepared.repo.worktree, "commit", "--quiet", "-m", "our follow-up");
      const ours = git(prepared.repo.worktree, "rev-parse", "HEAD");
      git(prepared.mirrorPath, "-c", "protocol.file.allow=always", "fetch", "--quiet", prepared.repo.root, `+${ours}:refs/agent-tag/${prepared.repo.taskId}`);

      const result = await pushToRemote(pushInput(prepared, token, { sha: ours }));
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.code).toBe("push.rejected");
        expect(result.reason).toMatch(/fetch first|non-fast-forward/);
      }
      expect(remoteHead(prepared, prepared.repo.branch)).toBe(theirs);
    });
  });

  test("url.insteadOf planted in the source repo or the user's global config does not redirect the push", async () => {
    await withTempDir("pr-push-insteadof", async (directory) => {
      const prepared = await prepare(directory);
      const evilPath = join(directory, "evil", "octo", "example.git");
      await mkdir(evilPath, { recursive: true });
      git(evilPath, "init", "--quiet", "--bare");
      const target = `file://${prepared.remoteBase}/`;
      const evil = `file://${join(directory, "evil")}/`;
      git(prepared.repo.root, "config", `url.${evil}.insteadOf`, target);
      git(prepared.repo.root, "config", `url.${evil}.pushInsteadOf`, target);
      // A same-user agent could also edit ~/.gitconfig; the runner ignores global config.
      const home = join(directory, "home");
      await mkdir(home);
      await writeFile(join(home, ".gitconfig"), `[url "${evil}"]\n\tinsteadOf = ${target}\n\tpushInsteadOf = ${target}\n[credential]\n\thelper = store\n`);
      const runner = createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: home } });

      const result = await pushToRemote(pushInput(prepared, canaryToken(), { runner }));
      expect(result).toMatchObject({ kind: "pushed", status: "created" });
      expect(remoteHead(prepared, prepared.repo.branch)).toBe(prepared.sha);
      const evilRefs = Bun.spawnSync(["git", "-C", evilPath, "for-each-ref"], { env: { PATH: process.env.PATH ?? "" } });
      expect(evilRefs.stdout.toString().trim()).toBe("");
      expect(await Bun.file(join(home, ".git-credentials")).exists()).toBe(false);
    });
  });

  test("refuses to push when the mirror's config has keys Agent Tag did not write", async () => {
    await withTempDir("pr-push-mirror-config", async (directory) => {
      const prepared = await prepare(directory);
      git(prepared.mirrorPath, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
      const error = await pushToRemote(pushInput(prepared, canaryToken())).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PushError);
      expect((error as PushError).code).toBe("push.mirror-config");
      expect(remoteHead(prepared, prepared.repo.branch)).toBeUndefined();
    });
  });

  test("refuses to push when the mirror's config listing is cut, so a key past the cap cannot hide", async () => {
    await withTempDir("pr-push-mirror-config-truncated", async (directory) => {
      const prepared = await prepare(directory);
      git(prepared.mirrorPath, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
      // The cap ends exactly after the first (allowed) key, so a prefix check would see nothing wrong.
      const runner = createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" }, maxOutputBytes: "core.repositoryformatversion\n".length });
      const error = await pushToRemote(pushInput(prepared, canaryToken(), { runner })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PushError);
      expect((error as PushError).code).toBe("push.mirror-config");
      expect(remoteHead(prepared, prepared.repo.branch)).toBeUndefined();
    });
  });

  test("validates inputs before running git", async () => {
    await withTempDir("pr-push-validate", async (directory) => {
      const prepared = await prepare(directory);
      const token = canaryToken();
      const code = async (overrides: Partial<PushInput>, value = token) =>
        ((await pushToRemote(pushInput(prepared, value, overrides)).catch((caught: unknown) => caught)) as PushError).code;
      expect(await code({ sha: "main" })).toBe("push.invalid-input");
      expect(await code({ headBranch: "-x" })).toBe("push.invalid-input");
      expect(await code({ remoteUrl: "http://github.com/octo/example.git" })).toBe("push.invalid-input");
      expect(await code({ remoteUrl: "file:///tmp/x.git", allowTestRemote: false })).toBe("push.invalid-input");
      expect(await code({ remoteUrl: "https://x:y@github.com/octo/example.git" })).toBe("push.invalid-input");
      expect(await code({}, "two words")).toBe("push.invalid-input");
      expect(await code({ sha: "0".repeat(40) })).toBe("push.missing-commit");
      expect(() => githubRemoteUrl("http://github.com", "octo/example")).toThrow(PushError);
      expect(() => githubRemoteUrl("https://github.com", "../etc")).toThrow(PushError);
      expect(githubRemoteUrl("https://ghe.example/", "octo/example")).toBe("https://ghe.example/octo/example.git");
    });
  });

  test("answers git's prompts through askpass over HTTP; the token never appears in errors or output", async () => {
    await withTempDir("pr-push-http", async (directory) => {
      const prepared = await prepare(directory);
      const token = canaryToken();
      const seen: string[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          const authorization = request.headers.get("authorization");
          if (authorization === null) {
            return new Response("auth required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="GitHub"' } });
          }
          seen.push(authorization);
          // Echo the credential back, as a hostile or buggy server might.
          return new Response(`denied ${authorization} ${token}`, { status: 403 });
        },
      });
      try {
        const recorder = recordingSpawn();
        const runner = isolatedRunner(recorder.spawn);
        const remoteUrl = githubRemoteUrl(`http://127.0.0.1:${server.port}`, "octo/example", { allowTestRemote: true });
        const error = (await pushToRemote(pushInput(prepared, token, { runner, remoteUrl })).catch((caught: unknown) => caught)) as PushError;
        expect(error).toBeInstanceOf(PushError);
        expect(error.code).toBe("push.auth");
        expect(error.retryable).toBe(false);
        expect(error.message).not.toContain(token);
        expect(seen).toContain(`Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
        for (const call of recorder.calls) expect(call.argv.join(" ")).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });
  });

  test("a network failure is retryable and redacted", async () => {
    await withTempDir("pr-push-network", async (directory) => {
      const prepared = await prepare(directory);
      const token = canaryToken();
      const error = (await pushToRemote(
        pushInput(prepared, token, { remoteUrl: "http://127.0.0.1:1/octo/example.git" }),
      ).catch((caught: unknown) => caught)) as PushError;
      expect(error.code).toBe("push.network");
      expect(error.retryable).toBe(true);
      expect(error.message).not.toContain(token);
    });
  });
});

describe("askpass script", () => {
  test("is written 0700, holds no secret, and answers username and password prompts", async () => {
    await withTempDir("pr-askpass", async (directory) => {
      const gitRoot = join(directory, "git");
      const path = await ensureAskpassScript(gitRoot);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect((await stat(gitRoot)).mode & 0o777).toBe(0o700);
      expect(await readFile(path, "utf8")).toBe(ASKPASS_SCRIPT);
      const token = canaryToken();
      const ask = (prompt: string) =>
        Bun.spawnSync([path, prompt], { env: { PATH: "/usr/bin:/bin", [ASKPASS_TOKEN_ENV]: token } }).stdout.toString();
      expect(ask("Username for 'https://github.com': ")).toBe("x-access-token\n");
      expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(`${token}\n`);

      // A tampered script is replaced.
      await writeFile(path, "#!/bin/sh\necho \"$AGENT_TAG_GIT_TOKEN\" > /tmp/stolen\n");
      await chmod(path, 0o755);
      await ensureAskpassScript(gitRoot);
      expect(await readFile(path, "utf8")).toBe(ASKPASS_SCRIPT);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    });
  });

  test("parses push porcelain lines", () => {
    const stdout = "To file:///r.git\n*\tabc:refs/heads/x\t[new branch]\nDone\n";
    expect(parsePushPorcelain(stdout, "refs/heads/x")).toEqual({ flag: "*", summary: "[new branch]" });
    expect(parsePushPorcelain("!\tabc:refs/heads/x\t[rejected] (fetch first)\n", "refs/heads/x")).toEqual({
      flag: "!",
      summary: "[rejected] (fetch first)",
    });
    expect(parsePushPorcelain("Done\n", "refs/heads/x")).toBeUndefined();
  });
});
