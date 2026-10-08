// Schedule run outcomes: settles each dispatched run from its operation or reminder outbox row, keeps
// the per-schedule failure streak, and auto-disables recurring schedules that keep failing.
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
  consecutive_failures: z.number().int().nonnegative(),
  failure_streak_started_at: isoDateTime,
  last_failure_at: isoDateTime.nullable(),
  last_error_code: z.string().nullable(),
});

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
    for (const run of runs) {
      if (recordRunOutcome(database, run, now, workerId)) recorded += 1;
      faultInjector("schedule-outcome.after-record");
    }
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
  if (outcome === "succeeded") {
    database
      .query(
        `UPDATE schedules SET consecutive_failures = 0, failure_streak_started_at = NULL
         WHERE schedule_id = ?`,
      )
      .run(run.schedule_id);
  } else if (outcome === "failed") {
    database
      .query(
        `UPDATE schedules SET consecutive_failures = consecutive_failures + 1,
           failure_streak_started_at = COALESCE(failure_streak_started_at, ?)
         WHERE schedule_id = ?`,
      )
      .run(run.due_at, run.schedule_id);
  }
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

/**
 * Disables active recurring schedules whose failure streak reached the threshold and spans at least
 * the minimum, measured between the due times of the first and the latest failed run. A schedule
 * leased by a ScheduleWorker is left for a later sweep so it never races `settleScheduleRun`.
 */
function disableFailingSchedules(
  database: Database,
  input: ReconcileScheduleRunOutcomesInput,
  now: string,
  workerId: string,
): ReadonlyArray<string> {
  const candidates = database
    .query(
      `SELECT s.schedule_id, s.task_id, s.conversation_id, s.thread_ts, s.actor_user_id, s.kind, s.prompt,
              s.consecutive_failures, s.failure_streak_started_at, last.due_at AS last_failure_at,
              last.outcome_error_code AS last_error_code
       FROM schedules s
       LEFT JOIN schedule_runs last ON last.run_id = (
         SELECT r.run_id FROM schedule_runs r
         WHERE r.schedule_id = s.schedule_id AND r.outcome = 'failed'
         ORDER BY r.due_at DESC, r.run_id DESC LIMIT 1)
       WHERE s.state = 'active'
         AND (s.cadence_seconds IS NOT NULL OR s.recurrence_json IS NOT NULL)
         AND s.consecutive_failures >= ?
         AND s.failure_streak_started_at IS NOT NULL
         AND (s.lease_owner IS NULL OR s.lease_expires_at <= ?)
       ORDER BY s.failure_streak_started_at, s.schedule_id`,
    )
    .all(input.consecutiveFailures, now)
    .map((raw) => disableCandidateSchema.parse(raw));
  const disabled: string[] = [];
  for (const candidate of candidates) {
    const lastFailureAt = candidate.last_failure_at ?? candidate.failure_streak_started_at;
    const spanMs = Date.parse(lastFailureAt) - Date.parse(candidate.failure_streak_started_at);
    if (spanMs < input.minFailureSpanSeconds * 1_000) continue;
    const result = database
      .query(
        `UPDATE schedules SET state = 'cancelled', ended_reason = 'auto-disabled', ended_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE schedule_id = ? AND state = 'active'
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now, candidate.schedule_id, now);
    if (result.changes !== 1) continue;
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
        consecutiveFailures: candidate.consecutive_failures,
        streakStartedAt: candidate.failure_streak_started_at,
        lastErrorCode: candidate.last_error_code,
      },
      createdAt: now,
    });
    enqueueAutoDisabledNotice(database, input, candidate, now);
    disabled.push(candidate.schedule_id);
  }
  return disabled;
}

function enqueueAutoDisabledNotice(
  database: Database,
  input: ReconcileScheduleRunOutcomesInput,
  candidate: z.infer<typeof disableCandidateSchema>,
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
      consecutiveFailures: candidate.consecutive_failures,
      streakStartedAt: candidate.failure_streak_started_at,
      lastErrorCode: candidate.last_error_code,
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
