// Snapshot step of the draft PR workflow (PR-M §3.2). Runs while the coordinator holds the operation lease
// and never touches a credential:
//   locate the task worktree -> commit leftovers (hooks off) -> ahead of base? -> size and secret guards
//   -> fetch the branch into a bare mirror owned by Agent Tag.
// Every failure is returned as `{ kind: "failed" }` with a short code so a git problem never fails the turn.
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { GIT_BRANCH_NAME_PATTERN, GITHUB_REPOSITORY_PATTERN } from "../config.ts";
import { scanTextForSecrets, type TextSecretFinding } from "../security/secret-scan.ts";
import { GitError, redactGitText, type GitRunner } from "./runner.ts";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_SUBJECT_MAX = 72;
const MAX_REPORTED_SECRET_PATHS = 10;

export interface SnapshotLimits {
  readonly maxChangedFiles: number;
  readonly maxDiffBytes: number;
  readonly secretScan: "block" | "off";
}

export interface PrSnapshotInput {
  readonly taskId: string;
  readonly repositoryRoot: string;
  /** `owner/name`, used only to place the mirror. */
  readonly repo: string;
  readonly baseBranch: string;
  /** From the T3 thread snapshot; null or undefined falls back to `agent-tag/<taskId>` and `git worktree list`. */
  readonly t3Thread: { readonly branch?: string | null; readonly worktreePath?: string | null };
  /** First line of the Slack request; becomes the commit subject for leftovers. */
  readonly request: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly commitAuthor: { readonly name: string; readonly email: string };
  /** `task_pull_requests.last_pushed_sha`, when a PR already exists for the task. */
  readonly lastPushedSha?: string | null;
  /** `<dataDir>/git`. Mirrors live at `<gitRoot>/<owner>/<name>.git`. */
  readonly gitRoot: string;
  readonly limits: SnapshotLimits;
  readonly runner: GitRunner;
  readonly signal?: AbortSignal;
}

export type SnapshotWarning = "head-moved";

export interface SecretBlockDetail {
  readonly reason: "secret";
  /** Files (or `commit message`) with a hit. Never the matched value or the line. */
  readonly paths: readonly string[];
  readonly patternNames: readonly string[];
}

export interface SizeBlockDetail {
  readonly reason: "size";
  readonly changedFiles: number;
  /** Lower bound once the diff exceeds `maxDiffBytes`. */
  readonly diffBytes: number;
  readonly maxChangedFiles: number;
  readonly maxDiffBytes: number;
}

export type PrSnapshotResult =
  | { readonly kind: "no-worktree" }
  | { readonly kind: "empty"; readonly sha: string; readonly committedLeftovers: boolean }
  | { readonly kind: "unchanged"; readonly sha: string }
  | {
      readonly kind: "blocked";
      readonly sha: string;
      readonly detail: SecretBlockDetail | SizeBlockDetail;
      readonly committedLeftovers: boolean;
      readonly warning?: SnapshotWarning;
    }
  | {
      readonly kind: "ready";
      readonly sha: string;
      readonly branch: string;
      readonly mergeBase: string;
      readonly aheadCount: number;
      readonly changedFiles: number;
      readonly diffBytes: number;
      readonly mirrorPath: string;
      readonly mirrorRef: string;
      readonly committedLeftovers: boolean;
      readonly warning?: SnapshotWarning;
    }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

class SnapshotFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `<gitRoot>/<owner>/<name>.git`. `repo` is validated so it cannot escape `gitRoot`. */
export function mirrorPathFor(gitRoot: string, repo: string): string {
  if (!GITHUB_REPOSITORY_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new SnapshotFailure("invalid-repo", "repo must be owner/name");
  }
  const [owner = "", name = ""] = repo.split("/");
  return join(resolve(gitRoot), owner, `${name}.git`);
}

export function mirrorRefFor(taskId: string): string {
  return `refs/agent-tag/${taskId}`;
}

/** `Agent Tag: <first line of the request, at most 72 characters>` plus trailers that link back to Slack. */
export function leftoverCommitMessage(input: {
  readonly request: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
}): string {
  const firstLine =
    input.request
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "changes";
  const prefix = "Agent Tag: ";
  const room = COMMIT_SUBJECT_MAX - prefix.length;
  const subject = firstLine.length > room ? `${firstLine.slice(0, room - 1)}…` : firstLine;
  return `${prefix}${subject}\n\nSlack-Thread: ${input.conversationId}/${input.threadTs}\nRequested-by: ${input.actorUserId}\n`;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): ReadonlyArray<{ readonly path: string; readonly branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const field of output.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) entries.push(current);
      current = undefined;
    } else if (field.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current !== undefined) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

/**
 * Collects the added lines of a `git diff -U0` and the file each belongs to. Header lines (`+++ b/...`)
 * are not content: added lines are only those inside a hunk.
 */
export function addedLinesByPath(diff: string): { readonly text: string; readonly paths: readonly string[] } {
  const lines: string[] = [];
  const paths: string[] = [];
  let path = "";
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const match = / b\/(.*)$/.exec(line);
      path = match?.[1] ?? "";
    } else if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target.startsWith("b/")) path = target.slice(2);
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      lines.push(line.slice(1));
      paths.push(path);
    }
  }
  return { text: lines.join("\n"), paths };
}

async function tryRun(input: PrSnapshotInput, cwd: string, args: readonly string[]) {
  return await input.runner.run({ cwd, args, ...(input.signal === undefined ? {} : { signal: input.signal }) });
}

async function mustRun(
  input: PrSnapshotInput,
  cwd: string,
  args: readonly string[],
  code: string,
  extra: { readonly stdin?: string; readonly maxOutputBytes?: number } = {},
) {
  try {
    return await input.runner.runChecked({
      cwd,
      args,
      ...extra,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof GitError) throw new SnapshotFailure(code, error.message);
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function locateWorktree(input: PrSnapshotInput, branch: string): Promise<string | undefined> {
  const given = input.t3Thread.worktreePath;
  if (given !== null && given !== undefined && given.length > 0 && (await isDirectory(given))) {
    const inside = await tryRun(input, given, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode === 0 && inside.stdout.trim() === "true") return given;
  }
  const listed = await tryRun(input, input.repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0) return undefined;
  const match = parseWorktreeList(listed.stdout).find((entry) => entry.branch === `refs/heads/${branch}`);
  return match !== undefined && (await isDirectory(match.path)) ? match.path : undefined;
}

async function commitLeftovers(input: PrSnapshotInput, worktree: string): Promise<boolean> {
  const status = await mustRun(input, worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=normal"], "status");
  if (status.stdout.length === 0) return false;
  await mustRun(input, worktree, ["add", "-A"], "add");
  // Nothing staged (for example only ignored or submodule-only changes): no commit.
  const staged = await tryRun(input, worktree, ["diff", "--cached", "--quiet", "--no-ext-diff"]);
  if (staged.exitCode === 0) return false;
  await mustRun(
    input,
    worktree,
    [
      "-c",
      `user.name=${input.commitAuthor.name}`,
      "-c",
      `user.email=${input.commitAuthor.email}`,
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--quiet",
      "-F",
      "-",
    ],
    "commit",
    { stdin: leftoverCommitMessage(input) },
  );
  return true;
}

async function resolveCommit(input: PrSnapshotInput, cwd: string, ref: string): Promise<string | undefined> {
  const result = await tryRun(input, cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function scanDelta(
  input: PrSnapshotInput,
  from: string,
  sha: string,
): Promise<{ readonly block?: SecretBlockDetail | SizeBlockDetail; readonly changedFiles: number; readonly diffBytes: number }> {
  const root = input.repositoryRoot;
  const range = [from, sha];
  const numstat = await mustRun(
    input,
    root,
    ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", ...range],
    "diff-numstat",
  );
  // Each `-z` numstat record is `added\tdeleted\tpath\0`.
  const changedFiles = numstat.stdout.split("\0").filter((record) => record.includes("\t")).length;
  const diff = await mustRun(
    input,
    root,
    ["diff", "-U0", "--text", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", ...range],
    "diff",
    { maxOutputBytes: input.limits.maxDiffBytes + 1 },
  );
  const diffBytes = diff.stdoutBytes;
  const { maxChangedFiles, maxDiffBytes } = input.limits;
  if (changedFiles > maxChangedFiles || diff.stdoutTruncated || diffBytes > maxDiffBytes) {
    return { block: { reason: "size", changedFiles, diffBytes, maxChangedFiles, maxDiffBytes }, changedFiles, diffBytes };
  }
  if (input.limits.secretScan === "off") return { changedFiles, diffBytes };

  const added = addedLinesByPath(diff.stdout);
  const hitPaths = new Set<string>();
  const patternNames = new Set<string>();
  const record = (findings: readonly TextSecretFinding[], pathOf: (line: number) => string) => {
    for (const finding of findings) {
      hitPaths.add(pathOf(finding.line));
      patternNames.add(finding.kind === "known-token-pattern" ? finding.patternName : finding.canaryName);
    }
  };
  record(scanTextForSecrets(added.text), (line) => added.paths[line - 1] ?? "");
  const messages = await mustRun(input, root, ["log", "--format=%B", "--no-show-signature", `${from}..${sha}`], "log");
  record(scanTextForSecrets(messages.stdout), () => "commit message");
  if (hitPaths.size === 0) return { changedFiles, diffBytes };
  return {
    block: {
      reason: "secret",
      paths: [...hitPaths].sort().slice(0, MAX_REPORTED_SECRET_PATHS),
      patternNames: [...patternNames].sort(),
    },
    changedFiles,
    diffBytes,
  };
}

async function ensureMirror(input: PrSnapshotInput, mirrorPath: string): Promise<void> {
  await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
  await chmod(resolve(input.gitRoot), 0o700);
  if (!(await isDirectory(mirrorPath))) {
    // `--template=` copies no sample hooks or info files: the mirror's contents are Agent Tag's alone.
    await mustRun(input, dirname(mirrorPath), ["init", "--quiet", "--bare", "--template=", mirrorPath], "mirror-init");
  }
  await chmod(mirrorPath, 0o700);
}

/** Commits leftovers, checks the branch against base and the guards, and fetches it into the mirror. */
export async function prSnapshot(input: PrSnapshotInput): Promise<PrSnapshotResult> {
  try {
    return await snapshot(input);
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      return { kind: "failed", code: error.code, message: redactGitText(error.message) };
    }
    if (error instanceof GitError) return { kind: "failed", code: error.code, message: error.message };
    return { kind: "failed", code: "unexpected", message: redactGitText(error instanceof Error ? error.message : String(error)) };
  }
}

async function snapshot(input: PrSnapshotInput): Promise<PrSnapshotResult> {
  if (!TASK_ID_PATTERN.test(input.taskId) || input.taskId.includes("..") || input.taskId.endsWith(".lock")) {
    throw new SnapshotFailure("invalid-task-id", "task id cannot be used in a git ref");
  }
  if (!GIT_BRANCH_NAME_PATTERN.test(input.baseBranch)) {
    throw new SnapshotFailure("invalid-base-branch", "base branch is not a valid branch name");
  }
  const branch = input.t3Thread.branch ?? `agent-tag/${input.taskId}`;
  if (!GIT_BRANCH_NAME_PATTERN.test(branch)) throw new SnapshotFailure("invalid-branch", "task branch is not a valid branch name");
  const mirrorPath = mirrorPathFor(input.gitRoot, input.repo);

  const worktree = await locateWorktree(input, branch);
  if (worktree === undefined) return { kind: "no-worktree" };

  // Branch guard: if the agent switched branches, leave its working tree alone and use the expected ref.
  const head = await tryRun(input, worktree, ["symbolic-ref", "-q", "HEAD"]);
  const headMoved = head.exitCode !== 0 || head.stdout.trim() !== `refs/heads/${branch}`;
  const warning = headMoved ? ({ warning: "head-moved" } as const) : {};
  const committedLeftovers = headMoved ? false : await commitLeftovers(input, worktree);

  const root = input.repositoryRoot;
  const sha = await resolveCommit(input, root, `refs/heads/${branch}`);
  if (sha === undefined) return { kind: "no-worktree" };

  let baseRef: string | undefined;
  for (const candidate of [`refs/remotes/origin/${input.baseBranch}`, `refs/heads/${input.baseBranch}`]) {
    if ((await resolveCommit(input, root, candidate)) !== undefined) {
      baseRef = candidate;
      break;
    }
  }
  if (baseRef === undefined) throw new SnapshotFailure("base-missing", `base branch ${input.baseBranch} was not found`);
  const mergeBase = (await mustRun(input, root, ["merge-base", baseRef, sha], "merge-base")).stdout.trim();
  const aheadCount = Number.parseInt(
    (await mustRun(input, root, ["rev-list", "--count", `${mergeBase}..${sha}`], "rev-list")).stdout.trim(),
    10,
  );
  if (!Number.isFinite(aheadCount) || aheadCount === 0) return { kind: "empty", sha, committedLeftovers };
  if (input.lastPushedSha === sha) return { kind: "unchanged", sha };

  // Guards cover what this push adds: since the last pushed SHA when it is an ancestor, else since base.
  let from = mergeBase;
  if (input.lastPushedSha !== null && input.lastPushedSha !== undefined && /^[0-9a-f]{40,64}$/.test(input.lastPushedSha)) {
    const ancestor = await tryRun(input, root, ["merge-base", "--is-ancestor", input.lastPushedSha, sha]);
    if (ancestor.exitCode === 0) from = input.lastPushedSha;
  }
  const scanned = await scanDelta(input, from, sha);
  if (scanned.block !== undefined) return { kind: "blocked", sha, detail: scanned.block, committedLeftovers, ...warning };

  await ensureMirror(input, mirrorPath);
  const mirrorRef = mirrorRefFor(input.taskId);
  await mustRun(
    input,
    mirrorPath,
    [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--end-of-options",
      resolve(root),
      `+${sha}:${mirrorRef}`,
    ],
    "mirror-fetch",
  );
  const mirrored = await resolveCommit(input, mirrorPath, mirrorRef);
  if (mirrored !== sha) throw new SnapshotFailure("mirror-mismatch", "mirror ref does not match the snapshot");

  return {
    kind: "ready",
    sha,
    branch,
    mergeBase,
    aheadCount,
    changedFiles: scanned.changedFiles,
    diffBytes: scanned.diffBytes,
    mirrorPath,
    mirrorRef,
    committedLeftovers,
    ...warning,
  };
}
