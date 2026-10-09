// Schedules: creation, listing, cancellation, claiming due runs and settling them.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { scheduleRecurrenceSchema, type ScheduleRecurrence } from "../routines/cron.ts";
import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import {
  isoDateTime,
  nonEmpty,
  recurrenceJson,
  schedulePrompt,
  scheduleRowSchema,
  scheduleTargetSchema,
} from "./schema.ts";
import type { ClaimedSchedule, ScheduleSummary } from "./types.ts";

const scheduleSummaryRowSchema = z.object({
  schedule_id: nonEmpty,
  task_id: nonEmpty,
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  profile_id: nonEmpty,
  actor_user_id: nonEmpty,
  kind: z.enum(["agent", "reminder"]),
  prompt: schedulePrompt,
  state: z.enum(["active", "cancelled", "completed"]),
  next_run_at: isoDateTime,
  cadence_seconds: z.number().int().min(60).nullable(),
  recurrence_json: recurrenceJson,
  missed_run_policy: z.enum(["run-once", "skip"]),
  overlap_policy: z.enum(["skip", "queue"]),
  time_zone: nonEmpty.nullable(),
  human_readable: nonEmpty.nullable(),
  notify_user_id: nonEmpty.nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  failure_streak_started_at: isoDateTime.nullable(),
  ended_reason: z.enum(["user-cancelled", "auto-disabled", "authority-revoked", "completed"]).nullable(),
  ended_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});

const SCHEDULE_SUMMARY_COLUMNS = `schedule_id, task_id, workspace_id, conversation_id, thread_ts, profile_id,
  actor_user_id, kind, prompt, state, next_run_at, cadence_seconds, recurrence_json, missed_run_policy,
  overlap_policy, time_zone, human_readable, notify_user_id, consecutive_failures, failure_streak_started_at,
  ended_reason, ended_at, created_at`;

function toScheduleSummary(raw: unknown): ScheduleSummary {
  const row = scheduleSummaryRowSchema.parse(raw);
  return {
    scheduleId: row.schedule_id,
    taskId: row.task_id,
    kind: row.kind,
    prompt: row.prompt,
    state: row.state,
    nextRunAt: row.next_run_at,
    cadenceSeconds: row.cadence_seconds,
    recurrence: row.recurrence_json,
    missedRunPolicy: row.missed_run_policy,
    overlapPolicy: row.overlap_policy,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    threadTs: row.thread_ts,
    profileId: row.profile_id,
    actorUserId: row.actor_user_id,
    timeZone: row.time_zone,
    humanReadable: row.human_readable,
    notifyUserId: row.notify_user_id,
    consecutiveFailures: row.consecutive_failures,
    failureStreakStartedAt: row.failure_streak_started_at,
    endedReason: row.ended_reason,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

/** One schedule by id, or null. */
export function getSchedule(database: Database, scheduleId: string): ScheduleSummary | null {
  const raw = database
    .query(`SELECT ${SCHEDULE_SUMMARY_COLUMNS} FROM schedules WHERE schedule_id = ?`)
    .get(requiredId(scheduleId, "scheduleId"));
  return raw === null ? null : toScheduleSummary(raw);
}

/** The schedule created from one Slack request (`<channel>:<ts>`), or null. */
export function findScheduleBySourceEvent(
  database: Database,
  input: { readonly workspaceId: string; readonly sourceEventKey: string },
): ScheduleSummary | null {
  const raw = database
    .query(`SELECT ${SCHEDULE_SUMMARY_COLUMNS} FROM schedules WHERE workspace_id = ? AND source_event_key = ?`)
    .get(requiredId(input.workspaceId, "workspaceId"), requiredId(input.sourceEventKey, "sourceEventKey"));
  return raw === null ? null : toScheduleSummary(raw);
}

export function countActiveSchedules(database: Database, workspaceId: string): number {
  const row = database
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM schedules WHERE workspace_id = ? AND state = 'active'",
    )
    .get(requiredId(workspaceId, "workspaceId"));
  if (row === null) throw new Error("failed to count active schedules");
  return row.count;
}

export interface CreateScheduleInput {
  readonly taskId: string;
  readonly actorUserId: string;
  readonly kind: "agent" | "reminder";
  readonly prompt: string;
  readonly runAt: string;
  readonly cadenceSeconds?: number;
  readonly recurrence?: ScheduleRecurrence;
  readonly missedRunPolicy: "run-once" | "skip";
  readonly misfireGraceSeconds: number;
  readonly overlapPolicy: "skip" | "queue";
  readonly now: string;
  /** Where the request came from. A repeated `eventKey` returns the existing schedule instead. */
  readonly source?: ScheduleSourceInput;
}

export interface ScheduleSourceInput {
  /** "<channel>:<ts>" of the Slack request. */
  readonly eventKey?: string;
  readonly timeZone?: string;
  readonly humanReadable?: string;
  readonly notifyUserId?: string;
}

const optionalText = (value: string | undefined, name: string): string | null =>
  value === undefined ? null : requiredId(value.trim(), name);

export function createSchedule(database: Database, input: CreateScheduleInput): ScheduleSummary {
  const now = isoDateTime.parse(input.now);
  const runAt = isoDateTime.parse(input.runAt);
  if (
    input.cadenceSeconds !== undefined &&
    (!Number.isSafeInteger(input.cadenceSeconds) || input.cadenceSeconds < 60)
  ) {
    throw new Error("schedule cadence must be at least 60 seconds");
  }
  if (input.cadenceSeconds !== undefined && input.recurrence !== undefined) {
    throw new Error("schedule cadence and recurrence are mutually exclusive");
  }
  const recurrence =
    input.recurrence === undefined ? null : scheduleRecurrenceSchema.parse(input.recurrence);
  if (
    !Number.isSafeInteger(input.misfireGraceSeconds) ||
    input.misfireGraceSeconds < 0 ||
    input.misfireGraceSeconds > 86_400
  ) {
    throw new Error("schedule misfire grace must be between 0 and 86400 seconds");
  }
  const sourceEventKey = optionalText(input.source?.eventKey, "source.eventKey");
  const timeZone = optionalText(input.source?.timeZone, "source.timeZone");
  const humanReadable = optionalText(input.source?.humanReadable, "source.humanReadable");
  const notifyUserId = optionalText(input.source?.notifyUserId, "source.notifyUserId");
  const create = database.transaction((): ScheduleSummary => {
    const taskId = requiredId(input.taskId, "taskId");
    const target = scheduleTargetSchema.parse(
      database
        .query(
          `SELECT workspace_id, conversation_id, thread_ts, profile_id, repository_root
           FROM tasks WHERE task_id = ? AND state = 'active'`,
        )
        .get(taskId),
    );
    if (sourceEventKey !== null) {
      const existing = findScheduleBySourceEvent(database, {
        workspaceId: target.workspace_id,
        sourceEventKey,
      });
      if (existing !== null) return existing;
    }
    const scheduleId = crypto.randomUUID();
    database
      .query(
        `INSERT INTO schedules (
          schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id,
          profile_id, repository_root, kind, prompt, cadence_seconds, recurrence_json, missed_run_policy,
          misfire_grace_seconds, overlap_policy, state, next_run_at, created_at, updated_at,
          time_zone, human_readable, source_event_key, notify_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scheduleId,
        taskId,
        target.workspace_id,
        target.conversation_id,
        target.thread_ts,
        requiredId(input.actorUserId, "actorUserId"),
        target.profile_id,
        target.repository_root,
        input.kind,
        schedulePrompt.parse(input.prompt),
        input.cadenceSeconds ?? null,
        recurrence === null ? null : JSON.stringify(recurrence),
        input.missedRunPolicy,
        input.misfireGraceSeconds,
        input.overlapPolicy,
        runAt,
        now,
        now,
        timeZone,
        humanReadable,
        sourceEventKey,
        notifyUserId,
      );
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "schedule-create",
      source: taskId,
      target: scheduleId,
      action: "schedule.created",
      result: "active",
      correlationId: scheduleId,
      metadata: {
        kind: input.kind,
        recurring: input.cadenceSeconds !== undefined || recurrence !== null,
        missedRunPolicy: input.missedRunPolicy,
        overlapPolicy: input.overlapPolicy,
        source: sourceEventKey === null ? "cli" : "slack",
      },
      createdAt: now,
    });
    const created = getSchedule(database, scheduleId);
    if (created === null) throw new Error("created schedule is missing");
    return created;
  });
  return create.immediate();
}

export function listSchedules(database: Database, taskId: string): ReadonlyArray<ScheduleSummary> {
  return database
    .query(`SELECT ${SCHEDULE_SUMMARY_COLUMNS} FROM schedules WHERE task_id = ? ORDER BY created_at, schedule_id`)
    .all(requiredId(taskId, "taskId"))
    .map(toScheduleSummary);
}

export interface ListConversationSchedulesInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly limit?: number;
  /** Also include schedules auto-disabled at or after this instant (listed after the active ones). */
  readonly autoDisabledSince?: string;
}

/** Active schedules of one conversation in creation order, optionally followed by recently auto-disabled ones. */
export function listActiveSchedulesForConversation(
  database: Database,
  input: ListConversationSchedulesInput,
): ReadonlyArray<ScheduleSummary> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("schedule list limit must be between 1 and 1000");
  }
  const workspaceId = requiredId(input.workspaceId, "workspaceId");
  const conversationId = requiredId(input.conversationId, "conversationId");
  const since = input.autoDisabledSince === undefined ? null : isoDateTime.parse(input.autoDisabledSince);
  return database
    .query(
      `SELECT ${SCHEDULE_SUMMARY_COLUMNS} FROM schedules
       WHERE workspace_id = ? AND conversation_id = ?
         AND (state = 'active' OR (? IS NOT NULL AND state = 'cancelled'
           AND ended_reason = 'auto-disabled' AND julianday(ended_at) >= julianday(?)))
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, created_at, schedule_id
       LIMIT ?`,
    )
    .all(workspaceId, conversationId, since, since, limit)
    .map(toScheduleSummary);
}

export interface CancelScheduleInput {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly actorUserId: string;
  readonly now: string;
}

export function cancelSchedule(database: Database, input: CancelScheduleInput): boolean {
  const now = isoDateTime.parse(input.now);
  const cancel = database.transaction(() => {
    const result = database
      .query(
        `UPDATE schedules SET state = 'cancelled', ended_reason = 'user-cancelled', ended_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND task_id = ? AND state = 'active'`,
      )
      .run(
        now,
        now,
        requiredId(input.scheduleId, "scheduleId"),
        requiredId(input.taskId, "taskId"),
      );
    if (result.changes === 0) return false;
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "schedule-cancel",
      source: input.scheduleId,
      target: input.scheduleId,
      action: "schedule.cancelled",
      result: "cancelled",
      correlationId: input.scheduleId,
      metadata: {},
      createdAt: now,
    });
    return true;
  });
  return cancel.immediate();
}

export interface RevokeClaimedScheduleInput {
  readonly scheduleId: string;
  readonly workerId: string;
  readonly now: string;
}

export function revokeClaimedSchedule(database: Database, input: RevokeClaimedScheduleInput): void {
  const now = isoDateTime.parse(input.now);
  const revoke = database.transaction(() => {
    const result = database.query(
      `UPDATE schedules SET state = 'cancelled', ended_reason = 'authority-revoked', ended_at = ?,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE schedule_id = ? AND state = 'active' AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(now, now, requiredId(input.scheduleId, "scheduleId"), requiredId(input.workerId, "workerId"), now);
    requireLeaseHeld(result, "schedule");
    writeAudit(database, {
      actorType: "worker", actorId: input.workerId, authority: "schedule-dispatch",
      source: input.scheduleId, target: input.scheduleId, action: "schedule.authority-revoked",
      result: "cancelled", correlationId: input.scheduleId, metadata: {}, createdAt: now,
    });
  });
  revoke.immediate();
}

export interface ClaimDueScheduleInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export function claimDueSchedule(database: Database, input: ClaimDueScheduleInput): ClaimedSchedule | null {
  const now = isoDateTime.parse(input.now);
  const workerId = requiredId(input.workerId, "workerId");
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction(() => {
    const identity = z.object({ schedule_id: nonEmpty }).nullable().parse(
      database
        .query(
          `SELECT schedule_id FROM schedules
           WHERE state = 'active' AND next_run_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY next_run_at, schedule_id LIMIT 1`,
        )
        .get(now, now),
    );
    if (identity === null) return null;
    const result = database
      .query(
        `UPDATE schedules SET attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE schedule_id = ? AND state = 'active'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(workerId, expiresAt, now, identity.schedule_id, now);
    if (result.changes !== 1) return null;
    const row = scheduleRowSchema.parse(
      database
        .query(
          `SELECT schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id,
                  profile_id, repository_root, kind, prompt, cadence_seconds, recurrence_json, missed_run_policy,
                  misfire_grace_seconds, overlap_policy, notify_user_id, next_run_at, attempts, lease_expires_at
           FROM schedules WHERE schedule_id = ?`,
        )
        .get(identity.schedule_id),
    );
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "schedule-dispatch",
      source: row.schedule_id,
      target: row.task_id,
      action: "schedule.claimed",
      result: "inflight",
      correlationId: row.schedule_id,
      metadata: { attempt: row.attempts, dueAt: row.next_run_at },
      createdAt: now,
    });
    return {
      scheduleId: row.schedule_id,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      threadTs: row.thread_ts,
      actorUserId: row.actor_user_id,
      profileId: row.profile_id,
      repositoryRoot: row.repository_root,
      kind: row.kind,
      prompt: row.prompt,
      cadenceSeconds: row.cadence_seconds,
      recurrence: row.recurrence_json,
      missedRunPolicy: row.missed_run_policy,
      misfireGraceSeconds: row.misfire_grace_seconds,
      overlapPolicy: row.overlap_policy,
      notifyUserId: row.notify_user_id,
      dueAt: row.next_run_at,
      attempt: row.attempts,
      leaseExpiresAt: row.lease_expires_at,
    };
  });
  return claim.immediate();
}

export function hasOpenScheduleOperation(database: Database, scheduleId: string): boolean {
  const row = database
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count
       FROM schedule_runs r JOIN operations o ON o.operation_id = r.operation_id
       WHERE r.schedule_id = ? AND o.status IN ('pending', 'inflight')`,
    )
    .get(requiredId(scheduleId, "scheduleId"));
  if (row === null) throw new Error("failed to check schedule overlap");
  return row.count > 0;
}

export interface SettleScheduleRunInput {
  readonly scheduleId: string;
  readonly workerId: string;
  readonly dueAt: string;
  readonly disposition: "dispatched" | "missed-skipped" | "overlap-skipped";
  readonly operationId?: string;
  readonly nextRunAt?: string;
  readonly now: string;
}

export function settleScheduleRun(database: Database, input: SettleScheduleRunInput): void {
  const now = isoDateTime.parse(input.now);
  const dueAt = isoDateTime.parse(input.dueAt);
  const nextRunAt = input.nextRunAt === undefined ? null : isoDateTime.parse(input.nextRunAt);
  const skipped = input.disposition !== "dispatched";
  const settle = database.transaction(() => {
    database
      .query(
        `INSERT INTO schedule_runs (
          run_id, schedule_id, due_at, disposition, operation_id, created_at, outcome, outcome_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${input.scheduleId}:${dueAt}`,
        requiredId(input.scheduleId, "scheduleId"),
        dueAt,
        input.disposition,
        input.operationId ?? null,
        now,
        skipped ? "skipped" : null,
        skipped ? now : null,
      );
    const completed = nextRunAt === null;
    const result = database
      .query(
        `UPDATE schedules SET state = ?, next_run_at = COALESCE(?, next_run_at),
           ended_reason = CASE WHEN ? THEN 'completed' ELSE ended_reason END,
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND state = 'active' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        completed ? "completed" : "active",
        nextRunAt,
        completed ? 1 : 0,
        completed ? 1 : 0,
        now,
        now,
        input.scheduleId,
        requiredId(input.workerId, "workerId"),
        now,
      );
    const cancelledDuringRun = result.changes !== 1;
    if (cancelledDuringRun) {
      // A user cancel while the run was claimed clears the lease. The run was already handed off (the
      // agent turn ingested or the reminder queued), so keep the run row for outcome tracking.
      const cancelled = database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM schedules
           WHERE schedule_id = ? AND state = 'cancelled' AND lease_owner IS NULL`,
        )
        .get(input.scheduleId);
      if ((cancelled?.count ?? 0) !== 1) requireLeaseHeld(result, "schedule");
    }
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "schedule-dispatch",
      source: input.scheduleId,
      target: input.operationId ?? input.scheduleId,
      action: "schedule.run.settled",
      result: input.disposition,
      correlationId: input.scheduleId,
      metadata: { dueAt, recurring: nextRunAt !== null, cancelledDuringRun },
      createdAt: now,
    });
  });
  settle.immediate();
}

export interface RecordScheduleDenialInput {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly workspaceId: string;
  readonly now: string;
}

export function recordScheduleDenial(database: Database, input: RecordScheduleDenialInput): void {
  const now = isoDateTime.parse(input.now);
  writeAudit(database, {
    actorType: "slack-user",
    actorId: requiredId(input.actorUserId, "actorUserId"),
    authority: "schedule-policy",
    source: requiredId(input.sourceId, "sourceId"),
    target: requiredId(input.workspaceId, "workspaceId"),
    action: "schedule.denied",
    result: requiredId(input.reason, "reason"),
    correlationId: input.sourceId,
    metadata: {},
    createdAt: now,
  });
}
