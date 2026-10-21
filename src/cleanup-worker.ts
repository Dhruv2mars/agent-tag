// Retired T3 thread cleanup (PR-N2). Once SessionStopWorker has stopped a retired thread's session,
// this worker deletes the thread in T3, removes its worktree (a dirty one is kept for
// `lifecycle.dirtyWorktreeRetentionDays` so a reopen can pick it up) and deletes the session branch
// when it has no commits and no PR. Every step is persisted under a lease before the next one, so a
// crash resumes where it stopped; the T3 command ids are stable, so a replayed dispatch is a no-op.
//
// Removal is fail-closed. A worktree is removed only when T3 reported it for this exact thread on one
// of this task's branches, git lists it as a worktree of the task's repository on that branch, no
// other T3 thread is bound to it, and it is not the repository, the data dir or HOME (or an ancestor).
// A clean tree is removed with `force:false`, so git still refuses if a file appeared meanwhile.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type { AgentTagConfig } from "./config.ts";
import { GitError, type GitRunner } from "./git/runner.ts";
import {
  type RetiredThread,
  type RetiredThreadPatch,
  RetiredLeaseLostError,
  type AgentTagStore,
  type AuditAction,
} from "./store/store.ts";
import { classifyT3DispatchError } from "./t3/dispatch-errors.ts";
import {
  type T3Command,
  type T3ThreadSnapshot,
  T3ThreadNotFoundError,
  type T3VcsStatus,
  type T3WorktreeBinding,
} from "./t3/gateway.ts";

/** The T3 calls cleanup makes; `T3Connection` implements it. */
export interface CleanupT3 {
  fetchThread(threadId: string, signal?: AbortSignal): Promise<T3ThreadSnapshot>;
  dispatch(command: T3Command, signal?: AbortSignal): Promise<unknown>;
  vcsStatus(cwd: string, signal?: AbortSignal): Promise<T3VcsStatus>;
  removeWorktree(input: { readonly cwd: string; readonly path: string; readonly force: boolean }, signal?: AbortSignal): Promise<void>;
  worktreeBindings(signal?: AbortSignal): Promise<readonly T3WorktreeBinding[]>;
}

export type CleanupPolicy = Pick<
  AgentTagConfig["lifecycle"],
  "dirtyWorktreeRetentionDays" | "deleteEmptyBranches" | "maxCleanupsPerSweep" | "sweepIntervalSeconds"
>;

export type CleanupWorkerOutcome = { readonly kind: "idle" } | { readonly kind: "threads-cleaned"; readonly count: number };

export interface CleanupPassResult {
  /** Rows taken this pass. */
  readonly claimed: number;
  /** Rows finished (removed, kept, adopted or failed for good). */
  readonly completed: number;
  /** Rows waiting: a retained dirty worktree, or a backoff after a transient error. */
  readonly deferred: number;
}

const LEASE_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
const MAX_ATTEMPTS = 10;
const DAY_MS = 86_400_000;
/** A dirty worktree found after its retention already ran out still gets a day's notice before removal. */
const MIN_NOTICE_MS = DAY_MS;

/** A permanent refusal: the row completes as failed and nothing more is removed. */
class CleanupRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CleanupRefusal";
  }
}

type RowOutcome = "completed" | "deferred" | "lease-lost";

export class CleanupWorker {
  readonly requiresT3 = true;
  readonly #store: AgentTagStore;
  readonly #t3: CleanupT3;
  readonly #git: GitRunner;
  readonly #policy: CleanupPolicy;
  readonly #protectedPaths: readonly string[];
  readonly #now: () => Date;
  readonly #owner: string;
  #nextSweepAt = 0;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly t3: CleanupT3;
    readonly git: GitRunner;
    readonly policy: CleanupPolicy;
    /** The service data dir; never removed, nor any ancestor of it. */
    readonly dataDir: string;
    readonly home?: string;
    readonly now?: () => Date;
    readonly owner?: string;
  }) {
    this.#store = input.store;
    this.#t3 = input.t3;
    this.#git = input.git;
    this.#policy = input.policy;
    this.#protectedPaths = [input.dataDir, input.home ?? homedir()];
    this.#now = input.now ?? (() => new Date());
    this.#owner = input.owner ?? `cleanup-worker:${process.pid}:${crypto.randomUUID()}`;
  }

  async processNext(signal?: AbortSignal): Promise<CleanupWorkerOutcome> {
    const current = this.#now();
    if (current.getTime() < this.#nextSweepAt) return { kind: "idle" };
    this.#nextSweepAt = current.getTime() + this.#policy.sweepIntervalSeconds * 1_000;
    const result = await this.runPass({ limit: this.#policy.maxCleanupsPerSweep, ...(signal === undefined ? {} : { signal }) });
    return result.completed === 0 ? { kind: "idle" } : { kind: "threads-cleaned", count: result.completed };
  }

  /** One pass over the due rows; `limit: null` takes every due row (`tasks cleanup --once`). */
  async runPass(input: { readonly limit: number | null; readonly signal?: AbortSignal }): Promise<CleanupPassResult> {
    const seen: string[] = [];
    let completed = 0;
    let deferred = 0;
    while (input.limit === null || seen.length < input.limit) {
      if (input.signal?.aborted === true) break;
      const row = this.#store.claimNextRetiredThread({
        owner: this.#owner,
        now: this.#now().toISOString(),
        leaseMs: LEASE_MS,
        exclude: seen,
      });
      if (row === null) break;
      seen.push(`${row.taskId}:${row.generation}`);
      const outcome = await this.#clean(row, input.signal);
      if (outcome === "completed") completed += 1;
      else if (outcome === "deferred") deferred += 1;
    }
    return { claimed: seen.length, completed, deferred };
  }

  async #clean(claimed: RetiredThread, signal: AbortSignal | undefined): Promise<RowOutcome> {
    let row = claimed;
    const step = (
      patch: RetiredThreadPatch,
      audit?: { readonly action: AuditAction; readonly result: string; readonly metadata?: Readonly<Record<string, string | number | boolean | null>> },
      notice?: { readonly key: string; readonly text: string },
    ): RetiredThread => {
      row = this.#store.recordRetiredStep({
        taskId: row.taskId,
        generation: row.generation,
        owner: this.#owner,
        leaseMs: LEASE_MS,
        patch,
        ...(audit === undefined ? {} : { audit }),
        ...(notice === undefined ? {} : { notice }),
        now: this.#now().toISOString(),
      });
      return row;
    };
    try {
      // a. Capture the worktree T3 made for this thread, before the thread (and its record) is gone.
      if (row.worktreeState === "unknown" && row.worktreePath === null && row.threadDeletedAt === null) {
        await this.#capture(row, step, signal);
      }
      // c. Delete the thread. T3 stops its session; an unknown thread is already gone.
      if (row.threadDeletedAt === null) {
        try {
          await this.#t3.dispatch({ type: "thread.delete", commandId: row.deleteCommandId, threadId: row.threadId }, callSignal(signal));
        } catch (error) {
          if (classifyT3DispatchError(error).kind !== "rejected") throw error;
        }
        step({ threadDeletedAt: this.#now().toISOString() }, { action: "task.thread.deleted", result: "deleted", metadata: { threadId: row.threadId } });
      }
      // b + d. Status, then remove or retain the worktree.
      let prState: string | null | undefined;
      if (row.worktreePath !== null && (row.worktreeState === "unknown" || row.worktreeState === "retained-dirty")) {
        const result = await this.#worktree(row, step, signal);
        if (result.kind !== "removed") return result.kind;
        prState = result.prState;
      } else if (row.worktreeState === "unknown") {
        step({ worktreeState: "none" });
      }
      // e. Branch.
      if (row.branchState === "unknown" && (row.worktreeState === "removed" || row.worktreeState === "none")) {
        await this.#branch(row, prState, step);
      }
      // f. Done.
      step(
        { completed: true, lastErrorCode: null, nextAttemptAt: null },
        { action: "task.cleanup.completed", result: "completed", metadata: { worktreeState: row.worktreeState, branchState: row.branchState } },
      );
      return "completed";
    } catch (error) {
      if (error instanceof RetiredLeaseLostError) return "lease-lost";
      try {
        return this.#fail(row, error, step);
      } catch (inner) {
        if (inner instanceof RetiredLeaseLostError) return "lease-lost";
        throw inner;
      }
    }
  }

  async #capture(row: RetiredThread, step: StepFn, signal: AbortSignal | undefined): Promise<void> {
    let snapshot: T3ThreadSnapshot;
    try {
      snapshot = await this.#t3.fetchThread(row.threadId, callSignal(signal));
    } catch (error) {
      if (!(error instanceof T3ThreadNotFoundError)) throw error;
      // The thread is already gone from T3; git still knows the session branch's worktree, if any.
      const path = await this.#worktreeForBranch(row.repositoryRoot, row.branch);
      step({ threadDeletedAt: this.#now().toISOString(), ...(path === null ? { worktreeState: "none" } : { worktreePath: path }) });
      return;
    }
    const { worktreePath, branch } = snapshot.thread;
    if (worktreePath === null) {
      step({ worktreeState: "none" });
      return;
    }
    // A reopened task that adopted a worktree keeps the earlier generation's branch name.
    if (branch === null || !isTaskBranch(row.taskId, branch)) throw new CleanupRefusal("branch-mismatch");
    step({ worktreePath, branch });
  }

  async #worktree(
    row: RetiredThread,
    step: StepFn,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly kind: "deferred" | "completed" } | { readonly kind: "removed"; readonly prState: string | null | undefined }> {
    const path = row.worktreePath;
    if (path === null) throw new Error("worktree path missing");
    // T3 may remove a deleted thread's clean worktree itself (its worktreeOnDelete setting).
    if (!existsSync(path)) {
      step({ worktreeState: "removed" }, { action: "task.worktree.removed", result: "already-gone", metadata: { forced: false } });
      return { kind: "removed", prState: undefined };
    }
    await this.#guard(row, path, signal);
    const status = await this.#t3.vcsStatus(path, callSignal(signal));
    if (!status.isRepo || status.refName !== row.branch) throw new CleanupRefusal("branch-mismatch");
    step({
      headCommitCount: status.aheadOfDefaultCount ?? row.headCommitCount,
      prUrl: status.pr?.url ?? row.prUrl,
    });
    const prState = status.pr === undefined ? undefined : (status.pr?.state ?? null);
    let force = false;
    if (status.hasWorkingTreeChanges) {
      const now = this.#now().getTime();
      if (row.worktreeState !== "retained-dirty") {
        const days = this.#policy.dirtyWorktreeRetentionDays;
        if (days === null) {
          step(
            { worktreeState: "retained-dirty", retainUntil: null, completed: true },
            { action: "task.worktree.retained", result: "retained", metadata: { retainUntil: null } },
            { key: "worktree-retained", text: retainedNotice(null) },
          );
          return { kind: "completed" };
        }
        const retainUntil = new Date(Math.max(Date.parse(row.retiredAt) + days * DAY_MS, now + MIN_NOTICE_MS)).toISOString();
        step(
          { worktreeState: "retained-dirty", retainUntil, nextAttemptAt: retainUntil, release: true },
          { action: "task.worktree.retained", result: "retained", metadata: { retainUntil } },
          { key: "worktree-retained", text: retainedNotice(retainUntil) },
        );
        return { kind: "deferred" };
      }
      if (row.retainUntil === null) {
        step({ completed: true });
        return { kind: "completed" };
      }
      if (now < Date.parse(row.retainUntil)) {
        step({ nextAttemptAt: row.retainUntil, release: true });
        return { kind: "deferred" };
      }
      force = true;
    }
    // Renew the lease right before the destructive call: a reopen refuses to adopt while it is live.
    step({});
    await this.#t3.removeWorktree({ cwd: row.repositoryRoot, path, force }, callSignal(signal));
    step({ worktreeState: "removed", retainUntil: null }, { action: "task.worktree.removed", result: "removed", metadata: { forced: force } });
    return { kind: "removed", prState };
  }

  /** Every check must pass before a worktree is removed; a failure is permanent (nothing is removed). */
  async #guard(row: RetiredThread, path: string, signal: AbortSignal | undefined): Promise<void> {
    if (!isAbsolute(path)) throw new CleanupRefusal("worktree-path-relative");
    const real = realpathSync(path);
    for (const protectedPath of [row.repositoryRoot, ...this.#protectedPaths]) {
      if (isSameOrAncestor(real, realOrResolved(protectedPath))) throw new CleanupRefusal("worktree-path-protected");
    }
    const registered = await this.#worktreeForBranch(row.repositoryRoot, row.branch);
    if (registered === null || realOrResolved(registered) !== real) throw new CleanupRefusal("worktree-unregistered");
    const bindings = await this.#t3.worktreeBindings(callSignal(signal));
    const boundElsewhere = bindings.some(
      (binding) => binding.threadId !== row.threadId && binding.worktreePath !== null && realOrResolved(binding.worktreePath) === real,
    );
    if (boundElsewhere) throw new CleanupRefusal("worktree-bound");
  }

  async #branch(row: RetiredThread, prState: string | null | undefined, step: StepFn): Promise<void> {
    // An open PR, or a recorded one T3 did not see (or was not asked about), keeps the branch.
    if (prState === "open" || (row.prUrl !== null && (prState === undefined || prState === null))) {
      step({ branchState: "kept-pr" }, { action: "task.branch.deleted", result: "kept-pr" });
      return;
    }
    if ((row.headCommitCount ?? 0) > 0 && prState !== "merged") {
      step({ branchState: "kept-commits" }, { action: "task.branch.deleted", result: "kept-commits" });
      return;
    }
    if (!this.#policy.deleteEmptyBranches) return;
    if (!isTaskBranch(row.taskId, row.branch)) throw new CleanupRefusal("branch-unsafe");
    step({});
    // Lowercase -d: git itself refuses to delete unmerged work. Never retried with -D.
    const result = await this.#git.run({ cwd: row.repositoryRoot, args: ["branch", "-d", "--", row.branch], timeoutMs: GIT_TIMEOUT_MS });
    if (result.exitCode === 0 || /not found/i.test(result.stderr)) {
      step({ branchState: "deleted" }, { action: "task.branch.deleted", result: "deleted" });
    } else if (/not fully merged/i.test(result.stderr)) {
      step({ branchState: "kept-commits" }, { action: "task.branch.deleted", result: "kept-commits" });
    } else {
      throw new CleanupRefusal("branch-delete-failed");
    }
  }

  /** The worktree git has checked out on `branch` in this repository, if any. */
  async #worktreeForBranch(repositoryRoot: string, branch: string): Promise<string | null> {
    const result = await this.#git.runChecked({ cwd: repositoryRoot, args: ["worktree", "list", "--porcelain"], timeoutMs: GIT_TIMEOUT_MS });
    let path: string | null = null;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branch}` && path !== null) return path;
    }
    return null;
  }

  #fail(row: RetiredThread, error: unknown, step: StepFn): RowOutcome {
    const refusal = error instanceof CleanupRefusal;
    const code = refusal ? error.code : errorCode(error);
    const attempts = row.attempts + 1;
    if (refusal || attempts >= MAX_ATTEMPTS) {
      step(
        {
          attempts,
          lastErrorCode: code,
          ...(row.worktreeState === "removed" || row.worktreeState === "none" ? {} : { worktreeState: "failed" as const }),
          ...(row.branchState === "unknown" ? { branchState: "failed" as const } : {}),
          completed: true,
        },
        { action: "task.cleanup.failed", result: refusal ? "refused" : "exhausted", metadata: { code, attempts } },
      );
      return "completed";
    }
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    step({
      attempts,
      lastErrorCode: code,
      nextAttemptAt: new Date(this.#now().getTime() + delay).toISOString(),
      release: true,
    });
    return "deferred";
  }
}

type StepFn = (
  patch: RetiredThreadPatch,
  audit?: { readonly action: AuditAction; readonly result: string; readonly metadata?: Readonly<Record<string, string | number | boolean | null>> },
  notice?: { readonly key: string; readonly text: string },
) => RetiredThread;

/** `agent-tag/<taskId>` or `agent-tag/<taskId>-g<n>`, for a UUID task id. */
export function isTaskBranch(taskId: string, branch: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) return false;
  return new RegExp(`^agent-tag/${taskId}(-g[1-9][0-9]*)?$`).test(branch);
}

export function retainedNotice(retainUntil: string | null): string {
  const until = retainUntil === null ? "" : ` until ${retainUntil.slice(0, 10)}`;
  return `:file_folder: Uncommitted changes from this session are kept in a local worktree${until}. Reply here to pick them back up.`;
}

/** What one pending row's next cleanup pass would do, for `tasks cleanup --dry-run`. DB only. */
export function plannedCleanupAction(row: RetiredThread, policy: CleanupPolicy, now: Date): string {
  if (row.sessionStoppedAt === null) return "wait for the session stop";
  if (row.worktreeState === "retained-dirty") {
    if (row.retainUntil === null) return "keep the dirty worktree";
    return Date.parse(row.retainUntil) > now.getTime()
      ? `keep the dirty worktree until ${row.retainUntil}`
      : `force-remove the dirty worktree ${row.worktreePath ?? ""}`.trimEnd();
  }
  const steps: string[] = [];
  if (row.threadDeletedAt === null) steps.push(`delete T3 thread ${row.threadId}`);
  if (row.worktreeState === "unknown") {
    steps.push(row.worktreePath === null ? "remove its worktree if clean (keep if dirty)" : `remove ${row.worktreePath} if clean (keep if dirty)`);
  }
  if (row.branchState === "unknown") {
    steps.push(policy.deleteEmptyBranches ? `delete branch ${row.branch} if it has no commits or PR` : `keep branch ${row.branch}`);
  }
  const due = row.attempts > 0 ? ` (retry ${row.attempts + 1} of ${MAX_ATTEMPTS}, last error ${row.lastErrorCode ?? "unknown"})` : "";
  return `${steps.length === 0 ? "finish" : steps.join("; ")}${due}`;
}

function callSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `candidate` is `target` or contains it. */
function isSameOrAncestor(candidate: string, target: string): boolean {
  const fromCandidate = relative(candidate, target);
  return fromCandidate === "" || (!fromCandidate.startsWith("..") && !isAbsolute(fromCandidate));
}

function errorCode(error: unknown): string {
  if (error instanceof GitError) return error.code;
  return classifyT3DispatchError(error).code;
}
