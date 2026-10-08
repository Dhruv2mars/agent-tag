// Schedule run outcomes: settles each dispatched run from its operation or reminder outbox row, keeps
// the per-schedule failure streak, and auto-disables recurring schedules that keep failing.
//
// Auto-disable invariants (every path below upholds them; see test/schedule-outcomes.test.ts):
//  1. The streak is derived from recorded run outcomes, never from the order runs were reconciled in:
//     it is the `failed` runs after the schedule's latest `succeeded` run, in due-time order.
//     `cancelled` (user-stopped) and `skipped` runs neither break nor extend it.
//  2. A disable is decided only over a fully reconciled suffix: while any counted dispatched run due
//     after the latest success still awaits its outcome (finished but beyond this sweep's batch
//     limit, or still in flight), the schedule is left for a later sweep.
//  3. So a success after failures always prevents the disable: it is either reconciled before the
//     decision (resetting the streak) or it blocks the decision until it is.
//  4. Runs dispatched before outcome tracking existed (`legacy = 1`, set by migration 15) get an
//     outcome for history but never count toward a streak nor block a decision: an upgrade cannot
//     disable a routine for failures from before the policy shipped.
//  5. Only active, recurring, unleased schedules are disabled. The state change, its audit row and the
//     owner notice are written in one transaction, guarded by `state = 'active'` and the notice's
//     unique client message id, so each disable happens and is announced exactly once.
//  6. `schedules.consecutive_failures` / `failure_streak_started_at` cache (1) for display; they are
//     refreshed for every schedule a sweep recorded runs for, and decisions recompute from runs.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId } from "./context.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { isoDateTime, nonEmpty, outboxPayloadSchema, schedulePrompt } from "./schema.ts";
import type { ScheduleRunOutcome, SlackOutboxPayload } from "./types.ts";

/** What the owner-visible notice of an auto-disabled schedule may say. Never written to the audit log. */
export interface AutoDisabledNoticeInput {
  readonly scheduleId: string;
  readonly kind: "agent" | "reminder";
  readonly prompt: string;
  readonly actorUserId: string;
  readonly consecutiveFailures: number;
  readonly streakStartedAt: string;
  readonly lastErrorCode: string | null;
}

export interface ReconcileScheduleRunOutcomesInput {
  readonly now: string;
  /** Maximum runs settled per call (default 50). */
  readonly limit?: number;
  /** Failures in a row (no success in between) needed to disable a recurring schedule. */
  readonly consecutiveFailures: number;
  /** Minimum time between the first and the latest failed run's due time. */
  readonly minFailureSpanSeconds: number;
  readonly workerId?: string;
  readonly renderAutoDisabledNotice: (input: AutoDisabledNoticeInput) => SlackOutboxPayload;
}

export interface ReconcileScheduleRunOutcomesResult {
  /** Runs whose outcome was recorded by this call. */
  readonly recorded: number;
  /** Schedules disabled by this call. */
  readonly autoDisabled: ReadonlyArray<string>;
}

const pendingRunSchema = z.object({
  run_id: nonEmpty,
  schedule_id: nonEmpty,
  due_at: isoDateTime,
  operation_id: nonEmpty.nullable(),
  operation_status: z.enum(["succeeded", "failed"]).nullable(),
  operation_error: z.string().nullable(),
  outbox_status: z.enum(["delivered", "failed"]).nullable(),
  outbox_error: z.string().nullable(),
});

const disableCandidateSchema = z.object({
  schedule_id: nonEmpty,
  task_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  actor_user_id: nonEmpty,
  kind: z.enum(["agent", "reminder"]),
  prompt: schedulePrompt,
});

const streakRowSchema = z.object({
  last_success_at: isoDateTime.nullable(),
  failures: z.number().int().nonnegative(),
  started_at: isoDateTime.nullable(),
  last_failure_at: isoDateTime.nullable(),
  last_error_code: z.string().nullable(),
  unreconciled: z.number().int().nonnegative(),
});

/** A schedule's current failure streak, computed from its counted (non-legacy) runs. */
interface FailureStreak {
  readonly failures: number;
  /** Due time of the first failed run after the latest success. */
  readonly startedAt: string | null;
  /** Due time of the latest failed run. */
  readonly lastFailureAt: string | null;
  readonly lastErrorCode: string | null;
  /** Counted dispatched runs due after the latest success that have no outcome yet. */
  readonly unreconciled: number;
}

type PendingRun = z.infer<typeof pendingRunSchema>;

/**
 * Maps a terminal run to its outcome. A user-cancelled turn is neutral; retry-scheduled operations
 * are still `pending` and so never reach here.
 */
function classifyRun(run: PendingRun): { readonly outcome: ScheduleRunOutcome; readonly errorCode: string | null } {
  if (run.operation_status === "succeeded" || run.outbox_status === "delivered") {
    return { outcome: "succeeded", errorCode: null };
  }
  const errorCode = (run.operation_status === "failed" ? run.operation_error : run.outbox_error) ?? null;
  if (run.operation_status === "failed" && errorCode === "user-cancelled") {
    return { outcome: "cancelled", errorCode };
  }
  return { outcome: "failed", errorCode };
}

function requirePolicy(input: ReconcileScheduleRunOutcomesInput): number {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("schedule outcome limit must be between 1 and 1000");
  }
  if (!Number.isSafeInteger(input.consecutiveFailures) || input.consecutiveFailures < 1) {
    throw new Error("consecutiveFailures must be a positive integer");
  }
  if (!Number.isSafeInteger(input.minFailureSpanSeconds) || input.minFailureSpanSeconds < 0) {
    throw new Error("minFailureSpanSeconds must be a non-negative integer");
  }
  return limit;
}

/**
 * Records the outcome of finished schedule runs and auto-disables failing recurring schedules, in one
 * immediate transaction. Each run's outcome is written once (guarded by `outcome IS NULL`), so a crash
 * rolls back the whole sweep and a re-run never double-counts.
 */
export function reconcileScheduleRunOutcomes(
  context: StoreContext,
  input: ReconcileScheduleRunOutcomesInput,
): ReconcileScheduleRunOutcomesResult {
  const { database, faultInjector } = context;
  const now = isoDateTime.parse(input.now);
  const limit = requirePolicy(input);
  const workerId = requiredId(input.workerId ?? "agent-tag", "workerId");
  const reconcile = database.transaction((): ReconcileScheduleRunOutcomesResult => {
    const runs = database
      .query(
        `SELECT r.run_id, r.schedule_id, r.due_at, r.operation_id,
                o.status AS operation_status, o.last_error_code AS operation_error,
                b.status AS outbox_status, b.last_error_code AS outbox_error
         FROM schedule_runs r
         LEFT JOIN operations o ON o.operation_id = r.operation_id
         LEFT JOIN slack_outbox b
           ON r.operation_id IS NULL AND b.client_message_id = r.schedule_id || ':' || r.due_at || ':reminder'
         WHERE r.outcome IS NULL AND r.disposition = 'dispatched'
           AND (o.status IN ('succeeded', 'failed') OR b.status IN ('delivered', 'failed'))
         ORDER BY r.due_at, r.run_id
         LIMIT ?`,
      )
      .all(limit)
      .map((raw) => pendingRunSchema.parse(raw));
    let recorded = 0;
    const touched = new Set<string>();
    for (const run of runs) {
      if (recordRunOutcome(database, run, now, workerId)) {
        recorded += 1;
        touched.add(run.schedule_id);
      }
      faultInjector("schedule-outcome.after-record");
    }
    for (const scheduleId of touched) refreshStreakCache(database, scheduleId);
    const autoDisabled = disableFailingSchedules(database, input, now, workerId);
    return { recorded, autoDisabled };
  });
  return reconcile.immediate();
}

function recordRunOutcome(database: Database, run: PendingRun, now: string, workerId: string): boolean {
  const { outcome, errorCode } = classifyRun(run);
  const result = database
    .query(
      `UPDATE schedule_runs SET outcome = ?, outcome_at = ?, outcome_error_code = ?
       WHERE run_id = ? AND outcome IS NULL`,
    )
    .run(outcome, now, errorCode, run.run_id);
  if (result.changes !== 1) return false;
  writeAudit(database, {
    actorType: "worker",
    actorId: workerId,
    authority: "schedule-dispatch",
    source: run.schedule_id,
    target: run.operation_id ?? run.run_id,
    action: "schedule.run.outcome",
    result: outcome,
    correlationId: run.schedule_id,
    metadata: { dueAt: run.due_at, outcome, errorCode },
    createdAt: now,
  });
  return true;
}

/** Computes a schedule's failure streak from its recorded runs (invariants 1, 2 and 4). */
function failureStreak(database: Database, scheduleId: string): FailureStreak {
  const row = streakRowSchema.parse(
    database
      .query(
        `WITH last_success AS (
           SELECT MAX(due_at) AS due_at FROM schedule_runs
           WHERE schedule_id = $id AND legacy = 0 AND outcome = 'succeeded'),
         streak AS (
           SELECT r.due_at, r.run_id, r.outcome_error_code FROM schedule_runs r, last_success s
           WHERE r.schedule_id = $id AND r.legacy = 0 AND r.outcome = 'failed'
             AND (s.due_at IS NULL OR r.due_at > s.due_at))
         SELECT (SELECT due_at FROM last_success) AS last_success_at,
                (SELECT COUNT(*) FROM streak) AS failures,
                (SELECT MIN(due_at) FROM streak) AS started_at,
                (SELECT MAX(due_at) FROM streak) AS last_failure_at,
                (SELECT outcome_error_code FROM streak ORDER BY due_at DESC, run_id DESC LIMIT 1)
                  AS last_error_code,
                (SELECT COUNT(*) FROM schedule_runs r, last_success s
                 WHERE r.schedule_id = $id AND r.legacy = 0 AND r.disposition = 'dispatched'
                   AND r.outcome IS NULL AND (s.due_at IS NULL OR r.due_at > s.due_at)) AS unreconciled`,
      )
      .get({ id: scheduleId }),
  );
  return {
    failures: row.failures,
    startedAt: row.started_at,
    lastFailureAt: row.last_failure_at,
    lastErrorCode: row.last_error_code,
    unreconciled: row.unreconciled,
  };
}

/** Rewrites the cached streak columns from the schedule's runs (invariant 6). */
function refreshStreakCache(database: Database, scheduleId: string): void {
  const streak = failureStreak(database, scheduleId);
  database
    .query("UPDATE schedules SET consecutive_failures = ?, failure_streak_started_at = ? WHERE schedule_id = ?")
    .run(streak.failures, streak.startedAt, scheduleId);
}

/**
 * Disables active recurring schedules whose failure streak reached the threshold and spans at least
 * the minimum, measured between the due times of the first and the latest failed run, once no run
 * that could still change that streak awaits its outcome. A schedule leased by a ScheduleWorker is
 * left for a later sweep so it never races `settleScheduleRun`.
 */
function disableFailingSchedules(
  database: Database,
  input: ReconcileScheduleRunOutcomesInput,
  now: string,
  workerId: string,
): ReadonlyArray<string> {
  // The cached count only preselects; each candidate's streak is recomputed from its runs below.
  const candidates = database
    .query(
      `SELECT schedule_id, task_id, conversation_id, thread_ts, actor_user_id, kind, prompt
       FROM schedules
       WHERE state = 'active'
         AND (cadence_seconds IS NOT NULL OR recurrence_json IS NOT NULL)
         AND consecutive_failures >= ?
         AND (lease_owner IS NULL OR lease_expires_at <= ?)
       ORDER BY failure_streak_started_at, schedule_id`,
    )
    .all(input.consecutiveFailures, now)
    .map((raw) => disableCandidateSchema.parse(raw));
  const disabled: string[] = [];
  for (const candidate of candidates) {
    const streak = failureStreak(database, candidate.schedule_id);
    if (streak.unreconciled > 0) continue;
    if (streak.failures < input.consecutiveFailures) continue;
    if (streak.startedAt === null || streak.lastFailureAt === null) continue;
    const spanMs = Date.parse(streak.lastFailureAt) - Date.parse(streak.startedAt);
    if (spanMs < input.minFailureSpanSeconds * 1_000) continue;
    const result = database
      .query(
        `UPDATE schedules SET state = 'cancelled', ended_reason = 'auto-disabled', ended_at = ?,
           consecutive_failures = ?, failure_streak_started_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND state = 'active'
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, streak.failures, streak.startedAt, now, candidate.schedule_id, now);
    if (result.changes !== 1) continue;
    const decided = { ...candidate, failures: streak.failures, startedAt: streak.startedAt, lastErrorCode: streak.lastErrorCode };
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "schedule-policy",
      source: candidate.schedule_id,
      target: candidate.task_id,
      action: "schedule.auto-disabled",
      result: "cancelled",
      correlationId: candidate.schedule_id,
      metadata: {
        kind: candidate.kind,
        consecutiveFailures: decided.failures,
        streakStartedAt: decided.startedAt,
        lastErrorCode: decided.lastErrorCode,
      },
      createdAt: now,
    });
    enqueueAutoDisabledNotice(database, input, decided, now);
    disabled.push(candidate.schedule_id);
  }
  return disabled;
}

function enqueueAutoDisabledNotice(
  database: Database,
  input: ReconcileScheduleRunOutcomesInput,
  candidate: z.infer<typeof disableCandidateSchema> & {
    readonly failures: number;
    readonly startedAt: string;
    readonly lastErrorCode: string | null;
  },
  now: string,
): void {
  const clientMessageId = `${candidate.schedule_id}:auto-disabled`;
  const prior = database
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM slack_outbox WHERE client_message_id = ?")
    .get(clientMessageId);
  if ((prior?.count ?? 0) > 0) return;
  const payload = outboxPayloadSchema.parse(
    input.renderAutoDisabledNotice({
      scheduleId: candidate.schedule_id,
      kind: candidate.kind,
      prompt: candidate.prompt,
      actorUserId: candidate.actor_user_id,
      consecutiveFailures: candidate.failures,
      streakStartedAt: candidate.startedAt,
      lastErrorCode: candidate.lastErrorCode,
    }),
  );
  const outboxId = crypto.randomUUID();
  insertOutboxMessage(database, {
    outboxId,
    taskId: candidate.task_id,
    correlationId: candidate.schedule_id,
    conversationId: candidate.conversation_id,
    threadTs: candidate.thread_ts,
    clientMessageId,
    payload,
    createdAt: now,
  });
  writeAudit(database, {
    actorType: "service",
    actorId: "agent-tag",
    authority: "slack-write",
    source: candidate.schedule_id,
    target: outboxId,
    action: "slack.outbox.enqueued",
    result: "pending",
    correlationId: candidate.schedule_id,
    metadata: { clientMessageId },
    createdAt: now,
  });
}
