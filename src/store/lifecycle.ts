// Task lifecycle (PR-N1): idle close, operator close, and the retired-thread rows the cleanup worker
// (PR-N2) consumes. Reopen lives in tasks.ts (`findOrCreateTask`), inside the ingest transaction.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { isoDateTime, nonEmpty } from "./schema.ts";
import { taskBranchName } from "./tasks.ts";

export const TASK_CLOSE_REASONS = ["idle", "command", "root-deleted", "admin"] as const;
export type TaskCloseReason = (typeof TASK_CLOSE_REASONS)[number];

/**
 * Latest activity on a task: the newest accepted event (`last_activity_at`) or operation and
 * interaction transition. Derived here so the operation and interaction modules need no hooks.
 */
const ACTIVITY_SQL = `MAX(
  COALESCE(t.last_activity_at, t.updated_at),
  COALESCE((SELECT MAX(o.updated_at) FROM operations o WHERE o.task_id = t.task_id), ''),
  COALESCE((SELECT MAX(i.updated_at) FROM interactions i WHERE i.task_id = t.task_id), '')
)`;

/**
 * Nothing in flight for the task: no queued or running turn, no open approval or question, and no
 * undelivered Slack post, reaction or PR job. A task closes only when every guard holds.
 */
const QUIET_SQL = `
  NOT EXISTS (SELECT 1 FROM operations o WHERE o.task_id = t.task_id AND o.status IN ('pending', 'inflight'))
  AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.task_id = t.task_id
    AND i.state IN ('pending', 'response-pending', 'inflight'))
  AND NOT EXISTS (SELECT 1 FROM slack_outbox x WHERE x.task_id = t.task_id AND x.status IN ('pending', 'inflight'))
  AND NOT EXISTS (SELECT 1 FROM slack_reactions r WHERE r.task_id = t.task_id AND r.status IN ('pending', 'inflight'))
  AND NOT EXISTS (SELECT 1 FROM pr_sync_jobs j WHERE j.task_id = t.task_id AND j.status IN ('pending', 'inflight'))
  AND t.restart_requested_at IS NULL`;

const DUE_SQL = `t.state = 'active' AND (t.close_requested_at IS NOT NULL OR ${ACTIVITY_SQL} <= ?) AND ${QUIET_SQL}`;

export interface ListCloseCandidatesInput {
  /** Tasks idle since at or before this instant are due; a requested close is due regardless. */
  readonly idleBefore: string;
  readonly limit: number;
}

/** Active tasks that can close now, requested closes first, then the longest idle. */
export function listCloseCandidates(database: Database, input: ListCloseCandidatesInput): readonly string[] {
  const idleBefore = isoDateTime.parse(input.idleBefore);
  const limit = z.number().int().positive().parse(input.limit);
  return database
    .query<{ task_id: string }, [string, number]>(
      `SELECT t.task_id FROM tasks t WHERE ${DUE_SQL}
       ORDER BY t.close_requested_at IS NULL, ${ACTIVITY_SQL}, t.task_id LIMIT ?`,
    )
    .all(idleBefore, limit)
    .map((row) => row.task_id);
}

/** The task columns a retired-thread row is built from. */
export const retirableTaskSchema = z.object({
  session_generation: z.number().int().positive(),
  t3_project_id: nonEmpty.nullable(),
  t3_thread_id: nonEmpty.nullable(),
  t3_thread_started_at: isoDateTime.nullable(),
  repository_root: nonEmpty,
});

/**
 * Records the task's current T3 thread in task_retired_t3_threads (generation, branch and stable
 * command ids for the session stop and PR-N2's cleanup), inside the caller's transaction. A thread
 * no turn was ever sent to has nothing in T3 or git, so its row is already complete.
 */
export function retireCurrentThread(
  database: Database,
  input: {
    readonly taskId: string;
    readonly task: z.infer<typeof retirableTaskSchema>;
    readonly reason: TaskCloseReason | "restart";
    readonly now: string;
  },
): void {
  const { taskId, task, now } = input;
  if (task.t3_project_id === null || task.t3_thread_id === null) return;
  const generation = task.session_generation;
  // A turn sent to the thread may have created it even with no receipt (or one a forced `!restart`
  // outran); one dispatched before migration 28 pinned nothing, so any unsettled sent turn counts.
  const created = task.t3_thread_started_at !== null || database
    .query(
      `SELECT 1 FROM operations WHERE task_id = ? AND (t3_thread_id = ? OR (t3_thread_id IS NULL
         AND t3_turn_dispatched_at IS NOT NULL AND status IN ('pending', 'inflight'))) LIMIT 1`,
    )
    .get(taskId, task.t3_thread_id) !== null;
  // A session that adopted the previous generation's worktree ran on that generation's branch.
  const adopted = z.object({ branch: nonEmpty }).nullable().parse(
    database
      .query(
        `SELECT branch FROM task_retired_t3_threads WHERE task_id = ? AND generation < ? AND worktree_state = 'adopted'
         AND generation = (SELECT MAX(generation) FROM task_retired_t3_threads WHERE task_id = ? AND generation < ?)`,
      )
      .get(taskId, generation, taskId, generation),
  );
  database
    .query(
      `INSERT INTO task_retired_t3_threads (
        task_id, generation, t3_project_id, t3_thread_id, repository_root, branch, reason, retired_at,
        thread_created, session_stop_command_id, delete_command_id, worktree_state, branch_state, completed_at, pr_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT pr_url FROM task_pull_requests WHERE task_id = ?))`,
    )
    .run(
      taskId,
      generation,
      task.t3_project_id,
      task.t3_thread_id,
      task.repository_root,
      adopted?.branch ?? taskBranchName(taskId, generation),
      input.reason,
      now,
      created ? 1 : 0,
      `${taskId}:g${generation}:session.stop`,
      `${taskId}:g${generation}:thread.delete`,
      created ? "unknown" : "none",
      created ? "unknown" : "deleted",
      created ? null : now,
      taskId,
    );
}

export interface CloseTaskInput {
  readonly taskId: string;
  /** Used when the task has no requested close of its own (whose reason wins). */
  readonly reason: TaskCloseReason;
  readonly actorId: string;
  readonly now: string;
  /**
   * The idle cutoff the caller listed with. Omitted, the task closes whenever nothing is in flight
   * (an operator close). Rechecked here, so a reply that lands after listing keeps the task open.
   */
  readonly idleBefore?: string;
}

export type CloseTaskResult =
  | { readonly kind: "closed"; readonly reason: TaskCloseReason; readonly generation: number }
  /** Work is queued or in flight (or, with `idleBefore`, the task is no longer idle). */
  | { readonly kind: "busy" }
  | { readonly kind: "not-active" };

/**
 * Closes an active task in one IMMEDIATE transaction: records its T3 thread as retired (generation,
 * branch and stable command ids for PR-N2's cleanup), marks it closed and audits `task.closed`. A
 * thread that never started has nothing in T3 or git, so its retired row is already complete.
 */
export function closeTask(database: Database, input: CloseTaskInput): CloseTaskResult {
  const taskId = requiredId(input.taskId, "taskId");
  const actorId = requiredId(input.actorId, "actorId");
  const now = isoDateTime.parse(input.now);
  const fallbackReason = z.enum(TASK_CLOSE_REASONS).parse(input.reason);
  const idleBefore = input.idleBefore === undefined ? null : isoDateTime.parse(input.idleBefore);
  return database.transaction((): CloseTaskResult => {
    const task = retirableTaskSchema.extend({
      state: z.enum(["active", "closed"]),
      close_reason: z.enum(TASK_CLOSE_REASONS).nullable(),
      close_requested_at: isoDateTime.nullable(),
    }).nullable().parse(
      database
        .query(
          `SELECT state, session_generation, t3_project_id, t3_thread_id, t3_thread_started_at, repository_root,
                  close_reason, close_requested_at FROM tasks WHERE task_id = ?`,
        )
        .get(taskId),
    );
    if (task === null || task.state !== "active") return { kind: "not-active" };
    const due = database
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM tasks t WHERE t.task_id = ? AND ${idleBefore === null ? `t.state = 'active' AND ${QUIET_SQL}` : DUE_SQL}`,
      )
      .get(...((idleBefore === null ? [taskId] : [taskId, idleBefore]) as [string, string]));
    if (due?.count !== 1) return { kind: "busy" };
    const reason = task.close_requested_at === null ? fallbackReason : (task.close_reason ?? fallbackReason);
    const generation = task.session_generation;
    retireCurrentThread(database, { taskId, task, reason, now });
    database
      .query(
        `UPDATE tasks SET state = 'closed', closed_at = ?, close_reason = ?, close_requested_at = NULL, updated_at = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(now, reason, now, taskId);
    writeAudit(database, {
      actorType: reason === "admin" ? "operator" : "service",
      actorId,
      authority: "task-lifecycle",
      source: reason,
      target: taskId,
      action: "task.closed",
      result: "closed",
      correlationId: taskId,
      metadata: { reason, generation },
      createdAt: now,
    });
    return { kind: "closed", reason, generation };
  }).immediate();
}

export interface RequestTaskCloseInput {
  readonly taskId: string;
  readonly reason: TaskCloseReason;
  readonly actorId: string;
  readonly now: string;
}

export type RequestTaskCloseResult =
  | { readonly kind: "closed"; readonly generation: number }
  /** Work is in flight; the lifecycle worker closes the task once it settles. */
  | { readonly kind: "requested" }
  | { readonly kind: "not-active" };

/** Closes the task now if nothing is in flight, else records the request for the lifecycle worker. */
export function requestTaskClose(database: Database, input: RequestTaskCloseInput): RequestTaskCloseResult {
  const taskId = requiredId(input.taskId, "taskId");
  const actorId = requiredId(input.actorId, "actorId");
  const now = isoDateTime.parse(input.now);
  const reason = z.enum(TASK_CLOSE_REASONS).parse(input.reason);
  return database.transaction((): RequestTaskCloseResult => {
    const closed = closeTask(database, { taskId, reason, actorId, now });
    if (closed.kind === "closed") return { kind: "closed", generation: closed.generation };
    if (closed.kind === "not-active") return closed;
    database
      .query(
        `UPDATE tasks SET close_requested_at = COALESCE(close_requested_at, ?), close_reason = ?, updated_at = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(now, reason, now, taskId);
    writeAudit(database, {
      actorType: reason === "admin" ? "operator" : "service",
      actorId,
      authority: "task-lifecycle",
      source: reason,
      target: taskId,
      action: "task.close.requested",
      result: "pending",
      correlationId: taskId,
      metadata: { reason },
      createdAt: now,
    });
    return { kind: "requested" };
  }).immediate();
}

export interface TaskSummary {
  readonly taskId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly profileId: string;
  readonly state: "active" | "closed";
  readonly generation: number;
  readonly lastActivityAt: string;
  readonly closeRequestedAt: string | null;
  readonly closeReason: TaskCloseReason | null;
  readonly closedAt: string | null;
}

export interface ListTasksInput {
  readonly state?: "active" | "closed";
  readonly limit: number;
}

/** Tasks, most recently active first, for `agent-tag tasks list`. */
export function listTasks(database: Database, input: ListTasksInput): readonly TaskSummary[] {
  const limit = z.number().int().positive().parse(input.limit);
  const state = input.state === undefined ? null : z.enum(["active", "closed"]).parse(input.state);
  const rows = z.array(z.object({
    task_id: nonEmpty,
    conversation_id: nonEmpty,
    thread_ts: nonEmpty,
    profile_id: nonEmpty,
    state: z.enum(["active", "closed"]),
    session_generation: z.number().int().positive(),
    last_activity_at: isoDateTime,
    close_requested_at: isoDateTime.nullable(),
    close_reason: z.enum(TASK_CLOSE_REASONS).nullable(),
    closed_at: isoDateTime.nullable(),
  })).parse(
    database
      .query(
        `SELECT * FROM (
           SELECT t.task_id, t.conversation_id, t.thread_ts, t.profile_id, t.state, t.session_generation,
                  ${ACTIVITY_SQL} AS last_activity_at, t.close_requested_at, t.close_reason, t.closed_at
           FROM tasks t WHERE ?1 IS NULL OR t.state = ?1
         ) ORDER BY last_activity_at DESC, task_id LIMIT ?2`,
      )
      .all(state, limit),
  );
  return rows.map((row) => ({
    taskId: row.task_id,
    conversationId: row.conversation_id,
    threadTs: row.thread_ts,
    profileId: row.profile_id,
    state: row.state,
    generation: row.session_generation,
    lastActivityAt: row.last_activity_at,
    closeRequestedAt: row.close_requested_at,
    closeReason: row.close_reason,
    closedAt: row.closed_at,
  }));
}
