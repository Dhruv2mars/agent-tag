// Snapshot step of the draft PR workflow (PR-M §3.2). Runs while the coordinator holds the operation lease
// and never touches a credential:
//   locate the task worktree -> commit leftovers (hooks off) -> ahead of base? -> size and secret guards
//   -> fetch the branch into a bare mirror owned by Agent Tag.
// Every failure is returned as `{ kind: "failed" }` with a short code so a git problem never fails the turn.
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
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
  /**
   * Set when the per-commit patches of the new commits (which are all scanned, since the push transfers
   * every one of them) exceed `maxDiffBytes` even though the net diff does not. Lower bound.
   */
  readonly historyBytes?: number;
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
 * Collects the added lines of a `git diff -U0` (or `git log -p --cc -U0`) and the file each belongs to.
 * Header lines (`+++ b/...`) are not content: added lines are only those inside a hunk. In a combined
 * (merge) hunk, `@@@` has one prefix column per parent and a line is added when any column is `+`.
 */
export function addedLinesByPath(diff: string): { readonly text: string; readonly paths: readonly string[] } {
  const lines: string[] = [];
  const paths: string[] = [];
  let path = "";
  let inHunk = false;
  let columns = 1;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const match = / b\/(.*)$/.exec(line);
      path = match?.[1] ?? "";
    } else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      inHunk = false;
      path = line.slice(line.indexOf(" ", "diff ".length) + 1);
    } else if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target.startsWith("b/")) path = target.slice(2);
    } else if (line.startsWith("@@")) {
      inHunk = true;
      columns = Math.max(1, (/^@+/.exec(line)?.[0].length ?? 2) - 1);
    } else if (inHunk && line.slice(0, columns).includes("+")) {
      lines.push(line.slice(columns));
      paths.push(path);
    }
  }
  return { text: lines.join("\n"), paths };
}

interface RunExtra {
  readonly stdin?: string;
  readonly maxOutputBytes?: number;
  /** Fail (`output-truncated`) rather than act on a cut stdout. Set wherever stdout feeds a guard. */
  readonly requireCompleteOutput?: boolean;
}

async function tryRun(input: PrSnapshotInput, cwd: string, args: readonly string[], extra: RunExtra = {}) {
  try {
    return await input.runner.run({ cwd, args, ...extra, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  } catch (error) {
    if (error instanceof GitError && error.code === "git.output-truncated") throw new SnapshotFailure("output-truncated", error.message);
    throw error;
  }
}

async function mustRun(input: PrSnapshotInput, cwd: string, args: readonly string[], code: string, extra: RunExtra = {}) {
  try {
    return await input.runner.runChecked({
      cwd,
      args,
      ...extra,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof GitError) {
      throw new SnapshotFailure(error.code === "git.output-truncated" ? "output-truncated" : code, error.message);
    }
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

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Real path of the first line `git rev-parse <flag>` prints in `cwd`, or undefined. */
async function revParsePath(input: PrSnapshotInput, cwd: string, flag: string): Promise<string | undefined> {
  const result = await tryRun(input, cwd, ["rev-parse", "--path-format=absolute", flag]);
  const printed = result.stdout.split("\n")[0]?.trim() ?? "";
  return result.exitCode === 0 && printed.length > 0 ? await realpathOrUndefined(printed) : undefined;
}

/**
 * The task worktree, but only a worktree of the configured repository: it must be in `repositoryRoot`'s
 * `git worktree list` and share its common git dir. A stale or wrong T3 path is never committed to.
 */
async function locateWorktree(input: PrSnapshotInput, branch: string): Promise<string | undefined> {
  const listed = await tryRun(input, input.repositoryRoot, ["worktree", "list", "--porcelain", "-z"], { requireCompleteOutput: true });
  if (listed.exitCode !== 0) return undefined;
  const entries = parseWorktreeList(listed.stdout);
  const rootCommonDir = await revParsePath(input, input.repositoryRoot, "--git-common-dir");
  if (rootCommonDir === undefined) return undefined;
  const belongs = async (path: string): Promise<string | undefined> => {
    if (!(await isDirectory(path))) return undefined;
    const top = await revParsePath(input, path, "--show-toplevel");
    if (top === undefined) return undefined;
    let listedHere = false;
    for (const entry of entries) {
      if ((await realpathOrUndefined(entry.path)) === top) listedHere = true;
    }
    if (!listedHere) return undefined;
    return (await revParsePath(input, top, "--git-common-dir")) === rootCommonDir ? top : undefined;
  };

  const given = input.t3Thread.worktreePath;
  if (given !== null && given !== undefined && given.length > 0) {
    const verified = await belongs(given);
    if (verified !== undefined) return verified;
  }
  const match = entries.find((entry) => entry.branch === `refs/heads/${branch}`);
  return match === undefined ? undefined : await belongs(match.path);
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
    { requireCompleteOutput: true },
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

  // The push transfers every new commit, not just the net result: a credential added in one commit and
  // deleted in the next is still in the pushed history. So each new commit's own patch is scanned too
  // (`--cc`: a merge shows only what it adds beyond its parents). A cut patch fails closed as a size block.
  const history = await mustRun(
    input,
    root,
    [
      "log",
      "--format=",
      "--cc",
      "-U0",
      "--text",
      "--no-color",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-show-signature",
      `${from}..${sha}`,
    ],
    "log-patches",
    { maxOutputBytes: maxDiffBytes + 1 },
  );
  if (history.stdoutTruncated || history.stdoutBytes > maxDiffBytes) {
    return {
      block: { reason: "size", changedFiles, diffBytes, maxChangedFiles, maxDiffBytes, historyBytes: history.stdoutBytes },
      changedFiles,
      diffBytes,
    };
  }
  const historyAdded = addedLinesByPath(history.stdout);
  record(scanTextForSecrets(historyAdded.text), (line) => historyAdded.paths[line - 1] ?? "");

  // Messages and identities of every new commit; a cut output fails rather than scanning a prefix.
  const messages = await mustRun(
    input,
    root,
    ["log", "--format=%an%n%ae%n%cn%n%ce%n%B", "--no-show-signature", `${from}..${sha}`],
    "log",
    { requireCompleteOutput: true },
  );
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
