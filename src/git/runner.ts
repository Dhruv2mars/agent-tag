// Injectable wrapper around the `git` binary.
//
// - argv arrays only: nothing goes through a shell.
// - The parent environment is not inherited. The child gets PATH, HOME and LANG plus settings that
//   stop prompts and stop git from reading the system or the user's global config.
// - Every call starts with `-c` overrides that disable hooks, fsmonitor and commit signing, so a
//   repository-controlled `.git/config` or hooks directory cannot run code through these commands.
// - Output capture is bounded and every call has a timeout. Errors are redacted: per-call secrets are
//   scrubbed exactly, known credential shapes by pattern, and userinfo in URLs is removed.
import { redactSecrets } from "../security/redact.ts";
import type { SecretString } from "../security/secret-file.ts";

/** Prepended to every git invocation. `-c` beats every config file, including the repository's own. */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "core.pager=cat",
];

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

export interface GitSpawnRequest {
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Uint8Array | undefined;
}

export interface GitChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** Kills the child and everything it started (filters, transport and credential helpers). */
  kill(): void;
}

/** Test seam: the default spawns with `Bun.spawn`. A recorder can wrap it to inspect argv and env. */
export type GitSpawn = (request: GitSpawnRequest) => GitChild;

export const bunGitSpawn: GitSpawn = (request) => {
  const child = Bun.spawn([...request.argv], {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    env: { ...request.env },
    stdin: request.stdin === undefined ? "ignore" : request.stdin,
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so a timeout can kill git's descendants too. A filter or helper that outlives
    // git would otherwise keep running and hold the output pipes open.
    detached: true,
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone; fall back to the child itself.
        child.kill("SIGKILL");
      }
    },
  };
};

export interface GitRunRequest {
  /** Run as `git -C <cwd>`. */
  readonly cwd?: string;
  readonly args: readonly string[];
  /** Extra environment for this child only, on top of the minimal base environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  /** Bytes kept per stream; the rest is read and discarded so the child never blocks on a full pipe. */
  readonly maxOutputBytes?: number;
  /** Values scrubbed from output and errors, and refused in argv. */
  readonly secrets?: readonly SecretString[];
  readonly signal?: AbortSignal;
  /**
   * Throw `git.output-truncated` instead of returning a truncated stdout. Set this whenever stdout feeds
   * a security decision (secret scans, config allowlists), so a cut never hides anything.
   */
  readonly requireCompleteOutput?: boolean;
}

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type GitErrorCode =
  | "git.spawn"
  | "git.timeout"
  | "git.aborted"
  | "git.failed"
  | "git.argv-secret"
  | "git.output-truncated";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | undefined;
  /** Redacted, bounded stderr of the failed command. */
  readonly stderr: string;

  constructor(input: { code: GitErrorCode; message: string; exitCode?: number; stderr?: string }) {
    super(input.message);
    this.name = "GitError";
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr ?? "";
  }
}

export interface GitRunner {
  /** Runs git and returns its result whatever the exit code. Throws `GitError` on spawn failure or timeout. */
  run(request: GitRunRequest): Promise<GitRunResult>;
  /** Like `run`, but a nonzero exit code throws `GitError` with code `git.failed`. */
  runChecked(request: GitRunRequest): Promise<GitRunResult>;
}

export interface GitRunnerOptions {
  readonly gitBinary?: string;
  readonly spawn?: GitSpawn;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Source of PATH, HOME and LANG for the child. Defaults to `process.env`. Nothing else is copied. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

/** The only environment a git child sees, apart from per-call `env`. */
export function gitBaseEnv(parentEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parentEnv.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // The user's global config is ignored too: a same-user agent can edit ~/.gitconfig (credential
    // helpers, url.*.insteadOf, fsmonitor), so it is not trusted for commands Agent Tag runs.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  if (parentEnv.HOME !== undefined) env.HOME = parentEnv.HOME;
  if (parentEnv.LANG !== undefined) env.LANG = parentEnv.LANG;
  return env;
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/** Removes exact secrets, known credential shapes and URL userinfo from `text`. */
export function redactGitText(text: string, secrets: readonly SecretString[] = []): string {
  return redactSecrets(scrubExact(text, secrets)).replace(URL_USERINFO, "$1[REDACTED]@");
}

function scrubExact(text: string, secrets: readonly SecretString[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    const value = secret.exposeToBoundary();
    if (value.length > 0) scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  return scrubbed;
}

/** Reads `stream` to the end, keeping at most `limit` bytes. `cancel` ends the read early. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  cancel: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly total: number; readonly truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = stream.getReader();
  const onCancel = () => void reader.cancel().catch(() => undefined);
  cancel.addEventListener("abort", onCancel, { once: true });
  for (;;) {
    if (cancel.aborted) break;
    const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    if (done) break;
    total += value.byteLength;
    if (kept < limit) {
      const slice = value.subarray(0, Math.min(value.byteLength, limit - kept));
      chunks.push(slice);
      kept += slice.byteLength;
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  cancel.removeEventListener("abort", onCancel);
  return { bytes, total, truncated: total > kept };
}

function describeArgs(args: readonly string[], secrets: readonly SecretString[]): string {
  return redactGitText(args.filter((arg) => !GIT_HARDENING_ARGS.includes(arg)).slice(0, 6).join(" "), secrets);
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const gitBinary = options.gitBinary ?? "git";
  const spawn = options.spawn ?? bunGitSpawn;
  const baseEnv = gitBaseEnv(options.parentEnv ?? process.env);

  const run = async (request: GitRunRequest): Promise<GitRunResult> => {
    const secrets = request.secrets ?? [];
    const args = [...GIT_HARDENING_ARGS, ...(request.cwd === undefined ? [] : ["-C", request.cwd]), ...request.args];
    const label = describeArgs(request.args, secrets);
    for (const secret of secrets) {
      const value = secret.exposeToBoundary();
      if (args.some((arg) => arg.includes(value))) {
        throw new GitError({ code: "git.argv-secret", message: "refusing to pass a secret in git argv" });
      }
    }
    if (request.signal?.aborted === true) {
      throw new GitError({ code: "git.aborted", message: `git ${label} was cancelled` });
    }
    const stdin = typeof request.stdin === "string" ? new TextEncoder().encode(request.stdin) : request.stdin;
    let child: GitChild;
    try {
      child = spawn({ argv: [gitBinary, ...args], cwd: undefined, env: { ...baseEnv, ...request.env }, stdin });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitError({ code: "git.spawn", message: `could not start git: ${redactGitText(detail, secrets)}` });
    }

    const limit = request.maxOutputBytes ?? options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
    const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    let stopped: "timeout" | "aborted" | undefined;
    const reads = new AbortController();
    let settleStopped: () => void = () => undefined;
    const stoppedPromise = new Promise<void>((resolve) => {
      settleStopped = resolve;
    });
    const stop = (reason: "timeout" | "aborted") => {
      stopped ??= reason;
      try {
        child.kill();
      } finally {
        // Settle now: neither the exit nor a descendant that still holds a pipe may extend the call.
        reads.abort();
        settleStopped();
      }
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const work = Promise.all([
        child.exited,
        readBounded(child.stdout, limit, reads.signal),
        readBounded(child.stderr, limit, reads.signal),
      ]);
      work.catch(() => undefined);
      const finished = await Promise.race([work, stoppedPromise.then(() => undefined)]);
      if (stopped === "aborted") throw new GitError({ code: "git.aborted", message: `git ${label} was cancelled` });
      if (stopped === "timeout" || finished === undefined) {
        throw new GitError({ code: "git.timeout", message: `git ${label} timed out after ${timeoutMs} ms` });
      }
      const [exitCode, stdout, stderr] = finished;
      if (request.requireCompleteOutput === true && stdout.truncated) {
        throw new GitError({
          code: "git.output-truncated",
          message: `git ${label} printed more than ${limit} bytes; refusing to act on partial output`,
        });
      }
      const decoder = new TextDecoder();
      return {
        exitCode,
        // Stdout is data (diffs, commit messages) that callers scan for credential shapes, so only the
        // exact per-call secrets are scrubbed from it. Stderr is diagnostics and is fully redacted.
        stdout: scrubExact(decoder.decode(stdout.bytes), secrets),
        stderr: redactGitText(decoder.decode(stderr.bytes), secrets),
        stdoutBytes: stdout.total,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    } finally {
      clearTimeout(timer);
      reads.abort();
      request.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    run,
    async runChecked(request) {
      const result = await run(request);
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim().slice(0, 2_000);
        throw new GitError({
          code: "git.failed",
          message: `git ${describeArgs(request.args, request.secrets ?? [])} failed with exit code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
          exitCode: result.exitCode,
          stderr,
        });
      }
      return result;
    },
  };
}
