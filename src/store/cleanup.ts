// Retired-thread cleanup (PR-N2): the leased queue over task_retired_t3_threads that CleanupWorker
// drains (delete the T3 thread, remove the worktree, delete an empty branch), the coordinator's
// claim on a retained worktree when a closed task reopens, and the lifecycle counts for doctor/status.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { isThreadMuted } from "./commands.ts";
import { requiredId } from "./context.ts";
import { leaseExpiry } from "./lease.ts";
import { contextNotice, enqueueOnce } from "./pull-requests.ts";
import { type AuditAction, isoDateTime, nonEmpty } from "./schema.ts";

export const WORKTREE_STATES = ["unknown", "none", "removed", "retained-dirty", "adopted", "failed"] as const;
export const BRANCH_STATES = ["unknown", "deleted", "kept-commits", "kept-pr", "adopted", "failed"] as const;
export type WorktreeState = (typeof WORKTREE_STATES)[number];
export type BranchState = (typeof BRANCH_STATES)[number];

const retiredRowSchema = z.object({
  task_id: nonEmpty,
  generation: z.number().int().positive(),
  t3_thread_id: nonEmpty,
  repository_root: nonEmpty,
  branch: nonEmpty,
  reason: nonEmpty,
  retired_at: isoDateTime,
  session_stopped_at: isoDateTime.nullable(),
  delete_command_id: nonEmpty,
  thread_deleted_at: isoDateTime.nullable(),
  worktree_path: nonEmpty.nullable(),
  worktree_state: z.enum(WORKTREE_STATES),
  retain_until: isoDateTime.nullable(),
  branch_state: z.enum(BRANCH_STATES),
  head_commit_count: z.number().int().nonnegative().nullable(),
  pr_url: nonEmpty.nullable(),
  cleanup_attempts: z.number().int().nonnegative(),
  last_error_code: nonEmpty.nullable(),
  completed_at: isoDateTime.nullable(),
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  task_state: z.enum(["active", "closed"]),
  task_generation: z.number().int().positive(),
  close_reason: nonEmpty.nullable(),
});

/** One retired T3 thread, with the task fields the dirty-worktree notice needs. */
export interface RetiredThread {
  readonly taskId: string;
  readonly generation: number;
  readonly threadId: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly reason: string;
  readonly retiredAt: string;
  readonly sessionStoppedAt: string | null;
  readonly deleteCommandId: string;
  readonly threadDeletedAt: string | null;
  readonly worktreePath: string | null;
  readonly worktreeState: WorktreeState;
  readonly retainUntil: string | null;
  readonly branchState: BranchState;
  readonly headCommitCount: number | null;
  readonly prUrl: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly completedAt: string | null;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  /** The task is still closed on this row's generation (not reopened or restarted since). */
  readonly stillClosed: boolean;
  readonly closeReason: string | null;
}

const ROW_SQL = `SELECT r.task_id, r.generation, r.t3_thread_id, r.repository_root, r.branch, r.reason, r.retired_at,
    r.session_stopped_at, r.delete_command_id, r.thread_deleted_at, r.worktree_path, r.worktree_state, r.retain_until, r.branch_state, r.head_commit_count,
    r.pr_url, r.cleanup_attempts, r.last_error_code, r.completed_at, t.workspace_id, t.conversation_id, t.thread_ts,
    t.state AS task_state, t.session_generation AS task_generation, t.close_reason
  FROM task_retired_t3_threads r JOIN tasks t ON t.task_id = r.task_id`;

function toRetiredThread(raw: unknown): RetiredThread {
  const row = retiredRowSchema.parse(raw);
  return {
    taskId: row.task_id,
    generation: row.generation,
    threadId: row.t3_thread_id,
    repositoryRoot: row.repository_root,
    branch: row.branch,
    reason: row.reason,
    retiredAt: row.retired_at,
    sessionStoppedAt: row.session_stopped_at,
    deleteCommandId: row.delete_command_id,
    threadDeletedAt: row.thread_deleted_at,
    worktreePath: row.worktree_path,
    worktreeState: row.worktree_state,
    retainUntil: row.retain_until,
    branchState: row.branch_state,
    headCommitCount: row.head_commit_count,
    prUrl: row.pr_url,
    attempts: row.cleanup_attempts,
    lastErrorCode: row.last_error_code,
    completedAt: row.completed_at,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    threadTs: row.thread_ts,
    stillClosed: row.task_state === "closed" && row.task_generation === row.generation,
    closeReason: row.close_reason,
  };
}

/**
 * Rows the cleanup worker may take: not complete, due, and unleased. A created thread waits until
 * SessionStopWorker has settled its session stop, so the two workers never share the backoff columns.
 */
const CLAIMABLE_SQL = `r.completed_at IS NULL AND r.session_stopped_at IS NOT NULL
  AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?1)
  AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= ?1)`;

export interface ClaimRetiredThreadInput {
  readonly owner: string;
  readonly now: string;
  readonly leaseMs: number;
  /** Skip these rows (already handled in this pass). */
  readonly exclude?: readonly string[];
}

/** Leases the next due retired thread, oldest first. */
export function claimNextRetiredThread(database: Database, input: ClaimRetiredThreadInput): RetiredThread | null {
  const owner = requiredId(input.owner, "owner");
  const now = isoDateTime.parse(input.now);
  const expires = leaseExpiry(now, input.leaseMs);
  const exclude = JSON.stringify(input.exclude ?? []);
  return database.transaction((): RetiredThread | null => {
    const next = z.object({ task_id: nonEmpty, generation: z.number().int() }).nullable().parse(
      database
        .query(
          `SELECT r.task_id, r.generation FROM task_retired_t3_threads r WHERE ${CLAIMABLE_SQL}
             AND (r.task_id || ':' || r.generation) NOT IN (SELECT value FROM json_each(?2))
           ORDER BY r.next_attempt_at IS NOT NULL, r.next_attempt_at, r.retired_at, r.task_id, r.generation LIMIT 1`,
        )
        .get(now, exclude),
    );
    if (next === null) return null;
    database
      .query("UPDATE task_retired_t3_threads SET lease_owner = ?, lease_expires_at = ? WHERE task_id = ? AND generation = ?")
      .run(owner, expires, next.task_id, next.generation);
    return getRetiredThread(database, next.task_id, next.generation);
  }).immediate();
}

export function getRetiredThread(database: Database, taskId: string, generation: number): RetiredThread | null {
  const raw = database.query(`${ROW_SQL} WHERE r.task_id = ? AND r.generation = ?`).get(taskId, generation);
  return raw === null ? null : toRetiredThread(raw);
}

/** Every retired thread still waiting for cleanup, for `tasks cleanup --dry-run`. */
export function listPendingRetiredThreads(database: Database): readonly RetiredThread[] {
  return database
    .query(`${ROW_SQL} WHERE r.completed_at IS NULL ORDER BY r.retired_at, r.task_id, r.generation`)
    .all()
    .map(toRetiredThread);
}

/** A persisted cleanup step. Only the given fields change; `null` clears a column. */
export interface RetiredThreadPatch {
  readonly branch?: string;
  readonly threadDeletedAt?: string;
  readonly worktreePath?: string | null;
  readonly worktreeState?: WorktreeState;
  readonly retainUntil?: string | null;
  readonly branchState?: BranchState;
  readonly headCommitCount?: number | null;
  readonly prUrl?: string | null;
  readonly nextAttemptAt?: string | null;
  readonly lastErrorCode?: string | null;
  readonly attempts?: number;
  readonly completed?: boolean;
  /** Releases the lease with this write (the row waits for `nextAttemptAt` or is complete). */
  readonly release?: boolean;
}

export interface RecordRetiredStepInput {
  readonly taskId: string;
  readonly generation: number;
  readonly owner: string;
  readonly leaseMs: number;
  readonly patch: RetiredThreadPatch;
  readonly audit?: {
    readonly action: AuditAction;
    readonly result: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  };
  /**
   * A notice in the task's Slack thread, posted at most once per row and key. Dropped when the task
   * has moved on from this generation, its root message was deleted, or the thread is muted.
   */
  readonly notice?: { readonly key: string; readonly text: string };
  readonly now: string;
}

const PATCH_COLUMNS: ReadonlyArray<readonly [keyof RetiredThreadPatch, string]> = [
  ["branch", "branch"],
  ["threadDeletedAt", "thread_deleted_at"],
  ["worktreePath", "worktree_path"],
  ["worktreeState", "worktree_state"],
  ["retainUntil", "retain_until"],
  ["branchState", "branch_state"],
  ["headCommitCount", "head_commit_count"],
  ["prUrl", "pr_url"],
  ["nextAttemptAt", "next_attempt_at"],
  ["lastErrorCode", "last_error_code"],
  ["attempts", "cleanup_attempts"],
];

/**
 * Applies one cleanup step under the caller's live lease (renewing it), with its audit row and
 * optional thread notice, in one transaction. Throws when the lease is gone: the caller stops.
 */
export function recordRetiredStep(database: Database, input: RecordRetiredStepInput): RetiredThread {
  const taskId = requiredId(input.taskId, "taskId");
  const owner = requiredId(input.owner, "owner");
  const now = isoDateTime.parse(input.now);
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of PATCH_COLUMNS) {
    const value = input.patch[key];
    if (value === undefined || typeof value === "boolean") continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (input.patch.completed === true) {
    sets.push("completed_at = ?");
    values.push(now);
  }
  const release = input.patch.release === true || input.patch.completed === true;
  sets.push("lease_owner = ?", "lease_expires_at = ?");
  values.push(release ? null : owner, release ? null : leaseExpiry(now, input.leaseMs));
  return database.transaction((): RetiredThread => {
    const result = database
      .query(
        `UPDATE task_retired_t3_threads SET ${sets.join(", ")}
         WHERE task_id = ? AND generation = ? AND completed_at IS NULL AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(...values, taskId, input.generation, owner, now);
    if (result.changes !== 1) throw new RetiredLeaseLostError(taskId, input.generation);
    const row = getRetiredThread(database, taskId, input.generation);
    if (row === null) throw new RetiredLeaseLostError(taskId, input.generation);
    if (input.audit !== undefined) {
      writeAudit(database, {
        actorType: "service",
        actorId: "cleanup-worker",
        authority: "task-lifecycle",
        source: `${taskId}:g${input.generation}`,
        target: taskId,
        action: input.audit.action,
        result: input.audit.result,
        correlationId: taskId,
        metadata: { generation: input.generation, ...input.audit.metadata },
        createdAt: now,
      });
    }
    if (input.notice !== undefined && row.stillClosed && row.closeReason !== "root-deleted" && !isThreadMuted(database, row)) {
      enqueueOnce(database, {
        taskId,
        correlationId: taskId,
        conversationId: row.conversationId,
        threadTs: row.threadTs,
        clientMessageId: `${taskId}:g${input.generation}:${input.notice.key}`,
        payload: contextNotice(input.notice.text),
        createdAt: now,
      });
    }
    return row;
  }).immediate();
}

export class RetiredLeaseLostError extends Error {
  constructor(taskId: string, generation: number) {
    super(`cleanup lease for ${taskId}:g${generation} is missing, expired, or the row is complete`);
    this.name = "RetiredLeaseLostError";
  }
}

/** The previous session a reopened task can continue from (never one a `!restart` retired). */
export interface ResumeCandidate {
  readonly generation: number;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly worktreeState: WorktreeState;
  readonly branchState: BranchState;
}

/** The latest retired thread before `generation`, unless a `!restart` (a deliberate fresh start) retired it. */
export function getResumeCandidate(database: Database, taskId: string, generation: number): ResumeCandidate | null {
  const row = z.object({
    generation: z.number().int().positive(),
    branch: nonEmpty,
    reason: nonEmpty,
    worktree_path: nonEmpty.nullable(),
    worktree_state: z.enum(WORKTREE_STATES),
    branch_state: z.enum(BRANCH_STATES),
  }).nullable().parse(
    database
      .query(
        `SELECT generation, branch, reason, worktree_path, worktree_state, branch_state FROM task_retired_t3_threads
         WHERE task_id = ? AND generation < ? ORDER BY generation DESC LIMIT 1`,
      )
      .get(requiredId(taskId, "taskId"), generation),
  );
  if (row === null || row.reason === "restart") return null;
  return {
    generation: row.generation,
    branch: row.branch,
    worktreePath: row.worktree_path,
    worktreeState: row.worktree_state,
    branchState: row.branch_state,
  };
}

/**
 * The reopened task's new T3 thread takes over a retained dirty worktree. Refused while the cleanup
 * worker holds a live lease on the row (it may be mid-removal); idempotent once adopted.
 */
export function adoptRetiredWorktree(
  database: Database,
  input: { readonly taskId: string; readonly generation: number; readonly now: string },
): boolean {
  const taskId = requiredId(input.taskId, "taskId");
  const now = isoDateTime.parse(input.now);
  return database.transaction((): boolean => {
    const result = database
      .query(
        `UPDATE task_retired_t3_threads SET worktree_state = 'adopted', branch_state = 'adopted',
           completed_at = COALESCE(completed_at, ?), next_attempt_at = NULL, retain_until = NULL
         WHERE task_id = ? AND generation = ? AND worktree_state = 'retained-dirty' AND worktree_path IS NOT NULL
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, taskId, input.generation, now);
    if (result.changes === 1) {
      writeAudit(database, {
        actorType: "service",
        actorId: "coordinator",
        authority: "task-lifecycle",
        source: `${taskId}:g${input.generation}`,
        target: taskId,
        action: "task.worktree.adopted",
        result: "adopted",
        correlationId: taskId,
        metadata: { generation: input.generation },
        createdAt: now,
      });
      return true;
    }
    const adopted = database
      .query<{ count: number }, [string, number]>(
        "SELECT COUNT(*) AS count FROM task_retired_t3_threads WHERE task_id = ? AND generation = ? AND worktree_state = 'adopted'",
      )
      .get(taskId, input.generation);
    return adopted?.count === 1;
  }).immediate();
}

/** The `lifecycle` block of doctor and status: DB only, so it works while T3 is down. */
export interface LifecycleCounts {
  readonly activeTasks: number;
  readonly releasedTasks: number;
  readonly closedTasks: number;
  /** Retired T3 threads whose cleanup has not finished (excluding retained dirty worktrees). */
  readonly pendingCleanup: number;
  readonly retainedDirty: number;
  /** Earliest `retain_until` among retained dirty worktrees (null: none, or all kept forever). */
  readonly oldestRetainUntil: string | null;
  /** Rows whose worktree or branch cleanup failed for good. */
  readonly cleanupFailures: number;
}

export function lifecycleCounts(database: Database): LifecycleCounts {
  const tasks = database
    .query<{ active: number; released: number; closed: number }, []>(
      `SELECT COUNT(*) FILTER (WHERE state = 'active') AS active,
              COUNT(*) FILTER (WHERE state = 'active' AND session_released_at IS NOT NULL) AS released,
              COUNT(*) FILTER (WHERE state = 'closed') AS closed
       FROM tasks`,
    )
    .get();
  const retired = database
    .query<{ pending: number; dirty: number; oldest: string | null; failed: number }, []>(
      `SELECT COUNT(*) FILTER (WHERE completed_at IS NULL AND worktree_state != 'retained-dirty') AS pending,
              COUNT(*) FILTER (WHERE worktree_state = 'retained-dirty') AS dirty,
              MIN(retain_until) FILTER (WHERE worktree_state = 'retained-dirty') AS oldest,
              COUNT(*) FILTER (WHERE worktree_state = 'failed' OR branch_state = 'failed') AS failed
       FROM task_retired_t3_threads`,
    )
    .get();
  if (tasks === null || retired === null) throw new Error("lifecycle count query failed");
  return {
    activeTasks: tasks.active,
    releasedTasks: tasks.released,
    closedTasks: tasks.closed,
    pendingCleanup: retired.pending,
    retainedDirty: retired.dirty,
    oldestRetainUntil: retired.oldest,
    cleanupFailures: retired.failed,
  };
}
