import { describe, expect, test } from "bun:test";

import {
  createGitRunner,
  GIT_HARDENING_ARGS,
  GitError,
  gitBaseEnv,
  redactGitText,
  type GitChild,
  type GitSpawn,
} from "../src/git/runner.ts";
import { SecretString } from "../src/security/secret-file.ts";
import { join } from "node:path";

import { canaryToken, git, recordingSpawn, withTempDir } from "./fixtures/git-fixture.ts";

function processesMatching(pattern: string): string {
  return Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeChild(input: { stdout?: readonly Uint8Array[]; stderr?: string; exitCode?: number }): GitChild {
  return {
    stdout: streamOf(input.stdout ?? []),
    stderr: streamOf(input.stderr === undefined ? [] : [new TextEncoder().encode(input.stderr)]),
    exited: Promise.resolve(input.exitCode ?? 0),
    kill: () => undefined,
  };
}

/** A child that never exits until killed. */
function hangingSpawn(): { spawn: GitSpawn; killed: () => boolean } {
  let killed = false;
  return {
    killed: () => killed,
    spawn: () => {
      let finish: (code: number) => void = () => undefined;
      let closeStreams: Array<() => void> = [];
      const stream = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            closeStreams.push(() => controller.close());
          },
        });
      const child: GitChild = {
        stdout: stream(),
        stderr: stream(),
        exited: new Promise<number>((resolve) => {
          finish = resolve;
        }),
        kill: () => {
          killed = true;
          for (const close of closeStreams) close();
          closeStreams = [];
          finish(137);
        },
      };
      return child;
    },
  };
}

describe("git runner", () => {
  test("runs real git with only the minimal environment and the hardening flags", async () => {
    const recorder = recordingSpawn();
    const runner = createGitRunner({
      spawn: recorder.spawn,
      parentEnv: { PATH: process.env.PATH, HOME: "/home/example", LANG: "en_US.UTF-8", SLACK_BOT_TOKEN: "leak", GIT_DIR: "/evil" },
    });
    const result = await runner.runChecked({ args: ["--version"] });
    expect(result.stdout).toStartWith("git version");
    const call = recorder.calls[0]!;
    expect(call.argv.slice(1, 1 + GIT_HARDENING_ARGS.length)).toEqual([...GIT_HARDENING_ARGS]);
    expect(call.argv).toContain("core.hooksPath=/dev/null");
    expect(call.argv).toContain("core.fsmonitor=false");
    expect(call.argv).toContain("commit.gpgSign=false");
    expect(Object.keys(call.env).sort()).toEqual(
      [
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_GRAFT_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_OPTIONAL_LOCKS",
        "GIT_PAGER",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
      ].sort(),
    );
    expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  });

  test("base environment never inherits arbitrary parent variables", () => {
    const env = gitBaseEnv({ PATH: "/bin", HOME: "/h", AGENT_TAG_GIT_TOKEN: "x", GIT_ASKPASS: "/evil", SSH_AUTH_SOCK: "/s" });
    expect(env.AGENT_TAG_GIT_TOKEN).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  test("passes -C and per-call env, and nonzero exits are results for run and errors for runChecked", async () => {
    const recorder = recordingSpawn();
    const runner = createGitRunner({ spawn: recorder.spawn });
    const result = await runner.run({ cwd: "/nonexistent-agent-tag-dir", args: ["status"], env: { EXTRA: "1" } });
    expect(result.exitCode).not.toBe(0);
    expect(recorder.calls[0]!.argv).toContain("-C");
    expect(recorder.calls[0]!.env.EXTRA).toBe("1");
    const error = await runner.runChecked({ cwd: "/nonexistent-agent-tag-dir", args: ["status"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe("git.failed");
  });

  test("bounds captured output but drains the rest", async () => {
    const chunk = new Uint8Array(64 * 1_024).fill(0x61);
    const runner = createGitRunner({
      spawn: () => fakeChild({ stdout: Array.from({ length: 32 }, () => chunk) }),
    });
    const result = await runner.run({ args: ["log"], maxOutputBytes: 100_000 });
    expect(result.stdout.length).toBe(100_000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutBytes).toBe(32 * 64 * 1_024);
  });

  test("kills the child on timeout and on abort", async () => {
    const hanging = hangingSpawn();
    const runner = createGitRunner({ spawn: hanging.spawn });
    const timeout = await runner.run({ args: ["fetch"], timeoutMs: 20 }).catch((caught: unknown) => caught);
    expect((timeout as GitError).code).toBe("git.timeout");
    expect(hanging.killed()).toBe(true);

    const second = hangingSpawn();
    const controller = new AbortController();
    const pending = createGitRunner({ spawn: second.spawn }).run({ args: ["fetch"], signal: controller.signal });
    controller.abort();
    expect(((await pending.catch((caught: unknown) => caught)) as GitError).code).toBe("git.aborted");
    expect(second.killed()).toBe(true);
  });

  test("refuses secrets in argv and redacts them from output and errors", async () => {
    const token = canaryToken();
    const secret = new SecretString(token);
    let spawned = false;
    const refusing = createGitRunner({
      spawn: () => {
        spawned = true;
        return fakeChild({});
      },
    });
    const refused = await refusing.run({ args: ["push", `https://x:${token}@example.com/r.git`], secrets: [secret] }).catch((caught: unknown) => caught);
    expect((refused as GitError).code).toBe("git.argv-secret");
    expect(String((refused as GitError).message)).not.toContain(token);
    expect(spawned).toBe(false);

    const slackShaped = `xoxb-${"B".repeat(30)}`;
    const noisy = createGitRunner({
      spawn: () =>
        fakeChild({
          stdout: [new TextEncoder().encode(`data ${token} ${slackShaped}\n`)],
          stderr: `fatal: https://user:${token}@example.com/ failed ${token}`,
          exitCode: 128,
        }),
    });
    const result = await noisy.run({ args: ["push"], secrets: [secret] });
    expect(result.stdout).not.toContain(token);
    // Stdout is data callers scan for credential shapes, so only exact secrets are scrubbed from it.
    expect(result.stdout).toContain(slackShaped);
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).toContain("https://[REDACTED]@example.com/");
    const error = (await noisy.runChecked({ args: ["push"], secrets: [secret] }).catch((caught: unknown) => caught)) as GitError;
    expect(error.message).not.toContain(token);
    expect(error.stderr).not.toContain(token);
  });

  test("redactGitText removes userinfo and known token shapes", () => {
    const pat = canaryToken();
    expect(redactGitText(`https://x-access-token:abc@github.com/o/r.git ${pat}`)).toBe(
      "https://[REDACTED]@github.com/o/r.git [REDACTED:github-fine-grained-token]",
    );
  });

  test("reports a missing git binary as a spawn error", async () => {
    const runner = createGitRunner({ gitBinary: "/nonexistent/agent-tag-git" });
    const error = (await runner.run({ args: ["--version"] }).catch((caught: unknown) => caught)) as GitError;
    expect(error.code).toBe("git.spawn");
  });

  test("a timeout kills git's descendants and settles even while a slow clean filter holds the pipes", async () => {
    await withTempDir("git-runner-slow-filter", async (directory) => {
      git(directory, "init", "--quiet");
      // A unique duration so the check below finds only this filter's sleep.
      const marker = `20.${String(Math.floor(Math.random() * 9_000) + 1_000)}`;
      git(directory, "config", "filter.slow.clean", `sleep ${marker}; cat`);
      await Bun.write(join(directory, ".gitattributes"), "* filter=slow\n");
      await Bun.write(join(directory, "file.txt"), "content\n");
      const runner = createGitRunner({ parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" } });

      const started = performance.now();
      const error = await runner.run({ cwd: directory, args: ["add", "-A"], timeoutMs: 300 }).catch((caught: unknown) => caught);
      const elapsed = performance.now() - started;
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe("git.timeout");
      expect(elapsed).toBeLessThan(5_000);
      await Bun.sleep(200);
      expect(processesMatching(`sleep ${marker}`)).toBe("");
    });
  });

  test("abort settles the call even when the child ignores the kill and keeps its pipes open", async () => {
    const neverEnding = (): GitChild => ({
      stdout: new ReadableStream<Uint8Array>({ start: () => undefined }),
      stderr: new ReadableStream<Uint8Array>({ start: () => undefined }),
      exited: new Promise<number>(() => undefined),
      kill: () => undefined,
    });
    const runner = createGitRunner({ spawn: neverEnding });
    const timeout = await runner.run({ args: ["fetch"], timeoutMs: 30 }).catch((caught: unknown) => caught);
    expect((timeout as GitError).code).toBe("git.timeout");
    const controller = new AbortController();
    const pending = runner.run({ args: ["fetch"], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(((await pending.catch((caught: unknown) => caught)) as GitError).code).toBe("git.aborted");
  });

  test("requireCompleteOutput refuses a truncated stdout", async () => {
    const big = new Uint8Array(1_000).fill(0x61);
    const runner = createGitRunner({ spawn: () => fakeChild({ stdout: [big] }), maxOutputBytes: 100 });
    expect((await runner.run({ args: ["log"] })).stdoutTruncated).toBe(true);
    const error = await runner.run({ args: ["log"], requireCompleteOutput: true }).catch((caught: unknown) => caught);
    expect((error as GitError).code).toBe("git.output-truncated");
    expect((await runner.run({ args: ["log"], requireCompleteOutput: true, maxOutputBytes: 1_000 })).stdout.length).toBe(1_000);
  });
});
