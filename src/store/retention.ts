import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";

import { STORE_MIGRATIONS } from "./migrations.ts";

/** Replacement for pruned message bodies. Row identity, status, and timestamps are kept for idempotency and audit. */
export const PRUNED_TEXT = "[pruned]";

const DAY_MS = 86_400_000;

export interface RetentionPolicy {
  /** Delete audit rows older than this many days. */
  readonly auditDays?: number | undefined;
  /** Replace payloads of settled Slack outbox rows older than this many days. */
  readonly outboxDays?: number | undefined;
  /**
   * Replace stored Slack message text, settled operation text, ended schedule prompts and consumed
   * thread note text older than this many days; delete unconsumed thread notes that old.
   */
  readonly messageDays?: number | undefined;
}

export interface RetentionCutoffs {
  readonly audit: string | null;
  readonly outbox: string | null;
  readonly message: string | null;
}

export interface PruneResult {
  readonly dryRun: boolean;
  readonly cutoffs: RetentionCutoffs;
  readonly auditDeleted: number;
  readonly outboxRedacted: number;
  readonly eventsRedacted: number;
  readonly operationsRedacted: number;
  /** Prompts of ended (cancelled, auto-disabled or completed) schedules. */
  readonly schedulesRedacted: number;
  /** Text of thread context notes already shown to a turn. */
  readonly notesRedacted: number;
  /** Thread context notes never shown to a turn: stale, so deleted outright. */
  readonly notesDeleted: number;
}

export function retentionEnabled(policy: RetentionPolicy): boolean {
  return policy.auditDays !== undefined || policy.outboxDays !== undefined || policy.messageDays !== undefined;
}

export function retentionCutoff(now: string, days: number | undefined): string | null {
  if (days === undefined) return null;
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error("retention days must be a positive integer");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("retention clock must be an ISO date-time");
  return new Date(nowMs - days * DAY_MS).toISOString();
}

export function retentionCutoffs(policy: RetentionPolicy, now: string): RetentionCutoffs {
  return {
    audit: retentionCutoff(now, policy.auditDays),
    outbox: retentionCutoff(now, policy.outboxDays),
    message: retentionCutoff(now, policy.messageDays),
  };
}

// Timestamps are compared through julianday() so differing ISO precision cannot misorder rows.
const AUDIT_WHERE = "julianday(created_at) < julianday(?)";
// Quarantined sends keep their payload: an operator must reconcile them before any resend.
const OUTBOX_WHERE = `status IN ('delivered', 'failed')
  AND (last_error_code IS NULL OR last_error_code <> 'delivery-outcome-unknown')
  AND julianday(updated_at) < julianday(?)
  AND payload_json <> json_object('text', '${PRUNED_TEXT}')`;
const EVENT_WHERE = `julianday(received_at) < julianday(?) AND text <> '${PRUNED_TEXT}'`;
// Only settled operations: pending and inflight turns still need their text to dispatch.
const OPERATION_WHERE = `status IN ('succeeded', 'failed')
  AND julianday(updated_at) < julianday(?)
  AND (json_extract(payload_json, '$.text') IS NOT '${PRUNED_TEXT}'
    OR (resolved_text IS NOT NULL AND resolved_text <> '${PRUNED_TEXT}'))`;
// Only ended schedules: an active schedule still needs its prompt for the next run.
const SCHEDULE_WHERE = `state <> 'active'
  AND julianday(COALESCE(ended_at, updated_at)) < julianday(?)
  AND prompt <> '${PRUNED_TEXT}'`;

const CONSUMED_NOTE_WHERE = `consumed_by_operation_id IS NOT NULL
  AND julianday(created_at) < julianday(?)
  AND (text <> '${PRUNED_TEXT}' OR (previous_text IS NOT NULL AND previous_text <> '${PRUNED_TEXT}'))`;
const PENDING_NOTE_WHERE = "consumed_by_operation_id IS NULL AND julianday(created_at) < julianday(?)";

function count(database: Database, table: string, where: string, cutoff: string): number {
  const row = database
    .query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(cutoff);
  return row?.count ?? 0;
}

/**
 * Applies the configured retention policy. Audit rows are deleted; message bodies are replaced with
 * {@link PRUNED_TEXT} so IDs, idempotency keys, and lease state survive. Runs in one immediate transaction.
 * Enables `secure_delete` on the connection first so replaced text is zeroed in the pages SQLite rewrites
 * instead of lingering in free space (Bun's bundled SQLite does not enable it by default on every platform).
 */
export function pruneRetainedData(
  database: Database,
  input: { readonly policy: RetentionPolicy; readonly now: string; readonly dryRun?: boolean },
): PruneResult {
  const cutoffs = retentionCutoffs(input.policy, input.now);
  const dryRun = input.dryRun ?? false;
  if (!dryRun) database.exec("PRAGMA secure_delete = ON");
  const run = database.transaction((): PruneResult => {
    let auditDeleted = 0;
    let outboxRedacted = 0;
    let eventsRedacted = 0;
    let operationsRedacted = 0;
    let schedulesRedacted = 0;
    let notesRedacted = 0;
    let notesDeleted = 0;
    if (cutoffs.audit !== null) {
      auditDeleted = dryRun
        ? count(database, "audit_log", AUDIT_WHERE, cutoffs.audit)
        : database.query(`DELETE FROM audit_log WHERE ${AUDIT_WHERE}`).run(cutoffs.audit).changes;
    }
    if (cutoffs.outbox !== null) {
      outboxRedacted = dryRun
        ? count(database, "slack_outbox", OUTBOX_WHERE, cutoffs.outbox)
        : database
            .query(`UPDATE slack_outbox SET payload_json = json_object('text', ?) WHERE ${OUTBOX_WHERE}`)
            .run(PRUNED_TEXT, cutoffs.outbox).changes;
    }
    if (cutoffs.message !== null) {
      eventsRedacted = dryRun
        ? count(database, "slack_events", EVENT_WHERE, cutoffs.message)
        : database
            .query(`UPDATE slack_events SET text = ? WHERE ${EVENT_WHERE}`)
            .run(PRUNED_TEXT, cutoffs.message).changes;
      operationsRedacted = dryRun
        ? count(database, "operations", OPERATION_WHERE, cutoffs.message)
        : database
            .query(
              `UPDATE operations
               SET payload_json = json_set(payload_json, '$.text', ?),
                   resolved_text = CASE WHEN resolved_text IS NULL THEN NULL ELSE ? END
               WHERE ${OPERATION_WHERE}`,
            )
            .run(PRUNED_TEXT, PRUNED_TEXT, cutoffs.message).changes;
      schedulesRedacted = dryRun
        ? count(database, "schedules", SCHEDULE_WHERE, cutoffs.message)
        : database
            .query(`UPDATE schedules SET prompt = ? WHERE ${SCHEDULE_WHERE}`)
            .run(PRUNED_TEXT, cutoffs.message).changes;
      notesRedacted = dryRun
        ? count(database, "thread_context_notes", CONSUMED_NOTE_WHERE, cutoffs.message)
        : database
            .query(
              `UPDATE thread_context_notes
               SET text = ?, previous_text = CASE WHEN previous_text IS NULL THEN NULL ELSE ? END
               WHERE ${CONSUMED_NOTE_WHERE}`,
            )
            .run(PRUNED_TEXT, PRUNED_TEXT, cutoffs.message).changes;
      notesDeleted = dryRun
        ? count(database, "thread_context_notes", PENDING_NOTE_WHERE, cutoffs.message)
        : database.query(`DELETE FROM thread_context_notes WHERE ${PENDING_NOTE_WHERE}`).run(cutoffs.message).changes;
    }
    return {
      dryRun,
      cutoffs,
      auditDeleted,
      outboxRedacted,
      eventsRedacted,
      operationsRedacted,
      schedulesRedacted,
      notesRedacted,
      notesDeleted,
    };
  });
  // A dry run only reads, so it takes no write lock and works on a read-only connection.
  return dryRun ? run.deferred() : run.immediate();
}

export function prunedRowCount(result: PruneResult): number {
  return (
    result.auditDeleted +
    result.outboxRedacted +
    result.eventsRedacted +
    result.operationsRedacted +
    result.schedulesRedacted +
    result.notesRedacted +
    result.notesDeleted
  );
}

/**
 * Opens a short-lived connection beside the service store, prunes, and closes it. After a real prune it
 * checkpoints and truncates the WAL so stale frames holding the old text do not stay on disk. If a reader
 * blocks the truncate past the busy timeout, the frames are left for the next prune or checkpoint.
 * A dry run opens the file read-only and refuses a store with pending migrations instead of applying them.
 */
export function pruneDatabaseFile(
  path: string,
  input: { readonly policy: RetentionPolicy; readonly now: string; readonly dryRun?: boolean },
): PruneResult {
  if (!isAbsolute(path)) throw new Error("store path must be absolute");
  const dryRun = input.dryRun ?? false;
  const database = dryRun
    ? new Database(path, { readonly: true, strict: true })
    : new Database(path, { readwrite: true, create: false, strict: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    if (dryRun) requireCurrentSchema(database);
    const result = pruneRetainedData(database, input);
    if (!result.dryRun) database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return result;
  } finally {
    database.close();
  }
}

function requireCurrentSchema(database: Database): void {
  const migrationsTable = database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  const applied = new Set(
    migrationsTable === null
      ? []
      : database.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((row) => row.version),
  );
  if (STORE_MIGRATIONS.some((migration) => !applied.has(migration.version))) {
    throw new Error("store has pending migrations; start the service or run prune without --dry-run to apply them first");
  }
}

/** A service maintenance worker that applies retention at most once per interval. */
export function createRetentionWorker(input: {
  readonly databasePath: string;
  readonly policy: RetentionPolicy;
  readonly now: () => Date;
  readonly intervalMs?: number;
}): { readonly processNext: () => Promise<{ readonly kind: string }> } {
  const intervalMs = input.intervalMs ?? 3_600_000;
  let nextRunAt = 0;
  return {
    processNext: async () => {
      if (!retentionEnabled(input.policy)) return { kind: "idle" };
      const current = input.now();
      if (current.getTime() < nextRunAt) return { kind: "idle" };
      nextRunAt = current.getTime() + intervalMs;
      const result = pruneDatabaseFile(input.databasePath, {
        policy: input.policy,
        now: current.toISOString(),
      });
      return { kind: prunedRowCount(result) === 0 ? "idle" : "retention-pruned" };
    },
  };
}
