// Read-only table counts and operational status for doctor/status.
import type { Database } from "bun:sqlite";

import { activeOutboxRateLimit } from "./outbox.ts";
import { isoDateTime } from "./schema.ts";
import type { OperationalStatus } from "./types.ts";

export interface StoreDiagnostics {
  readonly events: number;
  readonly deliveries: number;
  readonly tasks: number;
  readonly operations: number;
  readonly outbox: number;
  readonly memoryEntries: number;
  readonly schedules: number;
  readonly scheduleRuns: number;
  readonly ambientDecisions: number;
  readonly auditRecords: number;
}

export function diagnostics(database: Database): StoreDiagnostics {
  const count = (table: string): number => {
    const allowed = new Set([
      "slack_events",
      "slack_deliveries",
      "tasks",
      "operations",
      "slack_outbox",
      "memory_entries",
      "schedules",
      "schedule_runs",
      "ambient_decisions",
      "audit_log",
    ]);
    if (!allowed.has(table)) throw new Error("unsupported diagnostics table");
    const value = database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ?.count;
    if (value === undefined) throw new Error(`failed to count ${table}`);
    return value;
  };
  return {
    events: count("slack_events"),
    deliveries: count("slack_deliveries"),
    tasks: count("tasks"),
    operations: count("operations"),
    outbox: count("slack_outbox"),
    memoryEntries: count("memory_entries"),
    schedules: count("schedules"),
    scheduleRuns: count("schedule_runs"),
    ambientDecisions: count("ambient_decisions"),
    auditRecords: count("audit_log"),
  };
}

export function operationalStatus(database: Database, nowInput: string): OperationalStatus {
  const now = isoDateTime.parse(nowInput);
  const operations = database.query<{
    ready: number;
    deferred: number;
    activeLease: number;
    expiredLease: number;
    stalledRetry: number;
    stalledFailed: number;
    oldestReadyAt: string | null;
  }, [string, string, string, string, string]>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?)) AS ready,
       COUNT(*) FILTER (WHERE status = 'pending' AND blocked_until > ?) AS deferred,
       COUNT(*) FILTER (WHERE status = 'inflight' AND lease_expires_at > ?) AS activeLease,
       COUNT(*) FILTER (WHERE status = 'inflight' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)) AS expiredLease,
       COUNT(*) FILTER (WHERE status = 'pending' AND last_error_code = 'T3TurnStalled') AS stalledRetry,
       COUNT(*) FILTER (WHERE status = 'failed' AND last_error_code = 'T3TurnStalled') AS stalledFailed,
       MIN(CASE WHEN status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?)
           THEN created_at END) AS oldestReadyAt
     FROM operations`,
  ).get(now, now, now, now, now);
  const interactions = database.query<{
    awaitingHuman: number;
    responseQueued: number;
  }, []>(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'pending') AS awaitingHuman,
       COUNT(*) FILTER (WHERE state IN ('response-pending', 'inflight')) AS responseQueued
     FROM interactions`,
  ).get();
  const outbox = database.query<{
    pending: number;
    activeLease: number;
    expiredLease: number;
    retryBlocked: number;
    outcomeUnknown: number;
  }, [string, string, string]>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'inflight' AND lease_expires_at > ?) AS activeLease,
       COUNT(*) FILTER (WHERE status = 'inflight' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)) AS expiredLease,
       COUNT(*) FILTER (WHERE status = 'pending' AND blocked_until > ?) AS retryBlocked,
       COUNT(*) FILTER (WHERE status = 'failed' AND last_error_code = 'delivery-outcome-unknown') AS outcomeUnknown
     FROM slack_outbox`,
  ).get(now, now, now);
  if (operations === null || interactions === null || outbox === null) {
    throw new Error("operational status query failed");
  }
  return {
    asOf: now,
    operations,
    interactions,
    outbox: { ...outbox, rateLimitedUntil: activeOutboxRateLimit(database, now) },
  };
}
