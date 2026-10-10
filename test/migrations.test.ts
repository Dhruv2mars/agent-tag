import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_MIGRATIONS } from "../src/store/migrations.ts";
import { operationPayloadSchema } from "../src/store/schema.ts";
import { AgentTagStore } from "../src/store/store.ts";

const createdAt = "2026-09-21T00:00:00.000Z";

function applyMigration(database: Database, version: number): void {
  const migration = STORE_MIGRATIONS.find((candidate) => candidate.version === version);
  if (migration === undefined) throw new Error(`missing fixture migration ${version}`);
  database.transaction(() => {
    database.exec(migration.sql);
    database
      .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, createdAt);
  }).immediate();
}

function seedVersionOne(database: Database): void {
  database
    .query(
      `INSERT INTO tasks (
        task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
        t3_project_id, t3_thread_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?)`,
    )
    .run("task-1", "T1", "C1", "1000.000001", "engineering", "/srv/repos/example", createdAt, createdAt);
  database
    .query(
      `INSERT INTO operations (
        operation_id, task_id, source_delivery_id, source_event_key, kind, command_id,
        message_id, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'user-turn', ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      "operation-1",
      "task-1",
      "delivery-1",
      "C1:1000.000001",
      "command-1",
      "message-1",
      JSON.stringify({
        text: "preserve me",
        actorUserId: "U1",
        conversationId: "C1",
        threadTs: "1000.000001",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
      }),
      createdAt,
      createdAt,
    );
  database
    .query(
      `INSERT INTO slack_events (
        workspace_id, event_key, canonical_delivery_id, operation_id, conversation_id,
        thread_ts, actor_user_id, text, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("T1", "C1:1000.000001", "delivery-1", "operation-1", "C1", "1000.000001", "U1", "preserve me", createdAt);
  database
    .query(
      `INSERT INTO slack_deliveries (
        delivery_id, workspace_id, event_key, canonical_operation_id, disposition, received_at
      ) VALUES (?, ?, ?, ?, 'accepted', ?)`,
    )
    .run("delivery-1", "T1", "C1:1000.000001", "operation-1", createdAt);
  database
    .query(
      `INSERT INTO slack_outbox (
        outbox_id, task_id, correlation_id, conversation_id, thread_ts, client_message_id,
        payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run("outbox-1", "task-1", "operation-1", "C1", "1000.000001", "operation-1:started", '{"text":"working"}', createdAt, createdAt);
  database
    .query(
      `INSERT INTO audit_log (
        audit_id, actor_type, actor_id, authority, source, target, action, result,
        correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run("audit-1", "slack-user", "U1", "engineering", "delivery-1", "task-1", "slack.event.ingested", "accepted", "operation-1", createdAt);
}

test("upgrades every historical SQLite schema while preserving existing work", async () => {
  const versions = STORE_MIGRATIONS.map((migration) => migration.version);
  expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  // Each historical prefix, plus a store that applied 14 (from main) before 13 existed: applied
  // versions are tracked as a set, so 13 must still apply on top of it.
  const startingSets: ReadonlyArray<{ readonly label: string; readonly applied: ReadonlyArray<number> }> = [
    ...versions.map((startingVersion) => ({
      label: `v${startingVersion}`,
      applied: versions.filter((version) => version <= startingVersion),
    })),
    { label: "v14-without-13", applied: versions.filter((version) => version !== 13) },
  ];

  for (const { label, applied } of startingSets) {
    const directory = await mkdtemp(join(tmpdir(), `agent-tag-migration-${label}-`));
    const path = join(directory, "agent-tag.sqlite");
    try {
      const historical = new Database(path, { create: true, strict: true });
      historical.exec("PRAGMA foreign_keys = ON");
      historical.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      applyMigration(historical, 1);
      seedVersionOne(historical);
      for (const version of applied) {
        if (version > 1) applyMigration(historical, version);
      }
      historical.close();

      const store = await AgentTagStore.open(path);
      expect(store.diagnostics()).toMatchObject({
        events: 1,
        deliveries: 1,
        tasks: 1,
        operations: 1,
        outbox: 1,
        auditRecords: 1,
      });
      store.close();

      const upgraded = new Database(path, { readonly: true, strict: true });
      expect(
        upgraded.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count,
      ).toBe(STORE_MIGRATIONS.length);
      expect(
        upgraded
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'thread_context_notes%' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["thread_context_notes", "thread_context_notes_pending_idx"]);
      expect(
        upgraded
          .query<{
            source_order_key: string;
            blocked_until: string | null;
            resolved_text: string | null;
            turn_active_ms: number;
          }, []>("SELECT source_order_key, blocked_until, resolved_text, turn_active_ms FROM operations")
          .get(),
      ).toEqual({ source_order_key: createdAt, blocked_until: null, resolved_text: null, turn_active_ms: 0 });
      expect(
        upgraded
          .query<{ conversation_type: string; owner_user_id: string | null }, []>(
            "SELECT conversation_type, owner_user_id FROM tasks",
          )
          .get(),
      ).toEqual({ conversation_type: "channel", owner_user_id: null });
      expect(
        upgraded
          .query<{
            status: string;
            blocked_until: string | null;
            render_mode: string;
            method: string;
            target_outbox_id: string | null;
            refresh_kind: string | null;
          }, []>("SELECT status, blocked_until, render_mode, method, target_outbox_id, refresh_kind FROM slack_outbox")
          .get(),
      ).toEqual({
        status: "pending", blocked_until: null, render_mode: "rich", method: "post", target_outbox_id: null, refresh_kind: null,
      });
      expect(
        upgraded.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM slack_rate_limits").get(),
      ).toEqual({ count: 0 });
      expect(
        upgraded
          .query<{ t3_turn_started_at: string | null; t3_turn_dispatched_at: string | null; t3_turn_id: string | null }, []>(
            "SELECT t3_turn_started_at, t3_turn_dispatched_at, t3_turn_id FROM operations",
          )
          .get(),
      ).toEqual({
        // The seeded pending operation already posted its "working" message, so its turn started.
        t3_turn_started_at: createdAt,
        t3_turn_dispatched_at: createdAt,
        t3_turn_id: null,
      });
      expect(
        upgraded
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('interactions') WHERE name = 'blocked_until'")
          .get()?.name,
      ).toBe("blocked_until");
      expect(
        upgraded.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
      ).toBe("ok");
      upgraded.close();
    } finally {
      if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-${label}-`)) {
        throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  }
});

test("backfills started and dispatched turn markers for unfinished and failed operations from persisted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-turn-markers-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    const historical = new Database(path, { create: true, strict: true });
    historical.exec("PRAGMA foreign_keys = ON");
    historical.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of STORE_MIGRATIONS) {
      if (migration.version < 13) applyMigration(historical, migration.version);
    }
    historical
      .query(
        `INSERT INTO tasks (
          task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
          t3_project_id, t3_thread_id, state, created_at, updated_at
        ) VALUES ('task-1', 'T1', 'C1', '1000.000001', 'engineering', '/srv/repos/example', NULL, NULL, 'active', ?, ?)`,
      )
      .run(createdAt, createdAt);
    const claimedAt = "2026-09-21T00:05:00.000Z";
    const insertOperation = (operationId: string, status: string, attempts: number): void => {
      historical
        .query(
          `INSERT INTO operations (
            operation_id, task_id, source_delivery_id, source_event_key, kind, command_id,
            message_id, payload_json, status, attempts, created_at, updated_at
          ) VALUES (?, 'task-1', ?, ?, 'user-turn', ?, ?, '{}', ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          `delivery-${operationId}`,
          `C1:${operationId}`,
          `command-${operationId}`,
          `message-${operationId}`,
          status,
          attempts,
          createdAt,
          claimedAt,
        );
    };
    // Deferred while T3 waits for an approval: the recorded request proves the turn started.
    insertOperation("awaiting-approval", "pending", 1);
    historical
      .query(
        `INSERT INTO interactions (
          interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json, state,
          response_command_id, created_at, updated_at
        ) VALUES ('interaction-1', 'task-1', 'awaiting-approval', 'thread-1', 'request-1', 'approval', '{}',
          'pending', 'response-1', ?, ?)`,
      )
      .run("2026-09-21T00:06:00.000Z", "2026-09-21T00:06:00.000Z");
    // Claimed and retried with no evidence of the outcome: the turn may be running in T3.
    insertOperation("retrying", "pending", 2);
    // Never claimed: nothing reached T3.
    insertOperation("queued", "pending", 0);
    // Finished work keeps its markers empty; nothing will cancel it.
    insertOperation("finished", "succeeded", 1);
    // Failed only locally after its "working" message posted: the T3 turn may still be running.
    insertOperation("stalled", "failed", 1);
    historical
      .query(
        `INSERT INTO slack_outbox (
          outbox_id, task_id, correlation_id, conversation_id, thread_ts, client_message_id,
          payload_json, status, created_at, updated_at
        ) VALUES ('outbox-stalled', 'task-1', 'stalled', 'C1', '1000.000001', 'stalled:started', '{}',
          'delivered', ?, ?)`,
      )
      .run("2026-09-21T00:07:00.000Z", "2026-09-21T00:07:00.000Z");
    // Failed after repeated service errors with no start evidence: the claim may have dispatched it.
    insertOperation("service-failed", "failed", 3);
    historical.close();

    const store = await AgentTagStore.open(path);
    store.close();
    const upgraded = new Database(path, { readonly: true, strict: true });
    expect(
      upgraded
        .query<{ operation_id: string; t3_turn_started_at: string | null; t3_turn_dispatched_at: string | null }, []>(
          "SELECT operation_id, t3_turn_started_at, t3_turn_dispatched_at FROM operations ORDER BY operation_id",
        )
        .all(),
    ).toEqual([
      {
        operation_id: "awaiting-approval",
        t3_turn_started_at: "2026-09-21T00:06:00.000Z",
        t3_turn_dispatched_at: "2026-09-21T00:06:00.000Z",
      },
      { operation_id: "finished", t3_turn_started_at: null, t3_turn_dispatched_at: null },
      { operation_id: "queued", t3_turn_started_at: null, t3_turn_dispatched_at: null },
      { operation_id: "retrying", t3_turn_started_at: null, t3_turn_dispatched_at: claimedAt },
      { operation_id: "service-failed", t3_turn_started_at: null, t3_turn_dispatched_at: claimedAt },
      {
        operation_id: "stalled",
        t3_turn_started_at: "2026-09-21T00:07:00.000Z",
        t3_turn_dispatched_at: "2026-09-21T00:07:00.000Z",
      },
    ]);
    upgraded.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-turn-markers-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("the message-edit migration enforces the outbox method and target reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-edits-"));
  try {
    const path = join(directory, "agent-tag.sqlite");
    const store = await AgentTagStore.open(path);
    store.close();
    const database = new Database(path, { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database
      .query(
        `INSERT INTO tasks (
          task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
          t3_project_id, t3_thread_id, state, created_at, updated_at
        ) VALUES ('task-1', 'T1', 'C1', '1.1', 'engineering', '/srv', NULL, NULL, 'active', ?, ?)`,
      )
      .run(createdAt, createdAt);
    const insert = (id: string, method: string, target: string | null) =>
      database
        .query(
          `INSERT INTO slack_outbox (
            outbox_id, task_id, correlation_id, conversation_id, thread_ts, client_message_id,
            payload_json, status, created_at, updated_at, method, target_outbox_id
          ) VALUES (?, 'task-1', 'c', 'C1', '1.1', ?, '{"text":""}', 'pending', ?, ?, ?, ?)`,
        )
        .run(id, id, createdAt, createdAt, method, target);
    insert("post-1", "post", null);
    insert("edit-1", "update", "post-1");
    expect(() => insert("edit-2", "delete", "post-1")).toThrow("CHECK constraint failed");
    expect(() => insert("edit-3", "update", "missing")).toThrow("FOREIGN KEY constraint failed");
    database.close();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("routine migration backfills run outcomes and end reasons from the previous schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-routines-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    const historical = new Database(path, { create: true, strict: true });
    historical.exec("PRAGMA foreign_keys = ON");
    historical.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    applyMigration(historical, 1);
    seedVersionOne(historical);
    for (const { version } of STORE_MIGRATIONS) {
      if (version > 1 && version < 16) applyMigration(historical, version);
    }
    const insertSchedule = historical.query(
      `INSERT INTO schedules (
        schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id, profile_id,
        repository_root, kind, prompt, cadence_seconds, missed_run_policy, misfire_grace_seconds,
        overlap_policy, state, next_run_at, created_at, updated_at
      ) VALUES (?, 'task-1', 'T1', 'C1', '1000.000001', 'U1', 'engineering', '/srv/repos/example', 'agent',
        ?, 3600, 'skip', 60, 'skip', ?, ?, ?, ?)`,
    );
    insertSchedule.run("s-active", "hourly check", "active", createdAt, createdAt, createdAt);
    insertSchedule.run("s-cancelled", "old check", "cancelled", createdAt, createdAt, "2026-09-22T00:00:00.000Z");
    insertSchedule.run("s-completed", "one check", "completed", createdAt, createdAt, "2026-09-23T00:00:00.000Z");
    const insertRun = historical.query(
      `INSERT INTO schedule_runs (run_id, schedule_id, due_at, disposition, operation_id, created_at)
       VALUES (?, 's-active', ?, ?, ?, ?)`,
    );
    insertRun.run("s-active:a", "2026-09-21T01:00:00.000Z", "dispatched", "operation-1", "2026-09-21T01:00:01.000Z");
    insertRun.run("s-active:b", "2026-09-21T02:00:00.000Z", "missed-skipped", null, "2026-09-21T02:00:01.000Z");
    insertRun.run("s-active:c", "2026-09-21T03:00:00.000Z", "overlap-skipped", null, "2026-09-21T03:00:01.000Z");
    historical.close();

    (await AgentTagStore.open(path)).close();

    const upgraded = new Database(path, { strict: true });
    expect(
      upgraded
        .query("SELECT run_id, outcome, outcome_at FROM schedule_runs ORDER BY run_id")
        .all(),
    ).toEqual([
      { run_id: "s-active:a", outcome: null, outcome_at: null },
      { run_id: "s-active:b", outcome: "skipped", outcome_at: "2026-09-21T02:00:01.000Z" },
      { run_id: "s-active:c", outcome: "skipped", outcome_at: "2026-09-21T03:00:01.000Z" },
    ]);
    expect(
      upgraded
        .query(
          `SELECT schedule_id, prompt, ended_reason, ended_at, consecutive_failures, failure_streak_started_at,
                  source_event_key FROM schedules ORDER BY schedule_id`,
        )
        .all(),
    ).toEqual([
      { schedule_id: "s-active", prompt: "hourly check", ended_reason: null, ended_at: null, consecutive_failures: 0, failure_streak_started_at: null, source_event_key: null },
      { schedule_id: "s-cancelled", prompt: "old check", ended_reason: "user-cancelled", ended_at: "2026-09-22T00:00:00.000Z", consecutive_failures: 0, failure_streak_started_at: null, source_event_key: null },
      { schedule_id: "s-completed", prompt: "one check", ended_reason: "completed", ended_at: "2026-09-23T00:00:00.000Z", consecutive_failures: 0, failure_streak_started_at: null, source_event_key: null },
    ]);
    // The source key is unique per workspace only when set; NULLs (CLI schedules) never collide.
    upgraded.exec("UPDATE schedules SET source_event_key = 'C1:1.000001' WHERE schedule_id = 's-active'");
    expect(() =>
      upgraded.exec("UPDATE schedules SET source_event_key = 'C1:1.000001' WHERE schedule_id = 's-cancelled'"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      upgraded.exec("UPDATE schedules SET ended_reason = 'bogus' WHERE schedule_id = 's-cancelled'"),
    ).toThrow(/CHECK/);
    expect(
      upgraded.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
    ).toBe("ok");
    upgraded.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-routines-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("runs dispatched before the routine migration never count toward an auto-disable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-legacy-runs-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    const historical = new Database(path, { create: true, strict: true });
    historical.exec("PRAGMA foreign_keys = ON");
    historical.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    applyMigration(historical, 1);
    seedVersionOne(historical);
    for (const { version } of STORE_MIGRATIONS) {
      if (version > 1 && version < 16) applyMigration(historical, version);
    }
    historical.exec("UPDATE operations SET status = 'failed', last_error_code = 'T3TurnFailed'");
    historical
      .query(
        `INSERT INTO schedules (
          schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id, profile_id,
          repository_root, kind, prompt, cadence_seconds, missed_run_policy, misfire_grace_seconds,
          overlap_policy, state, next_run_at, created_at, updated_at
        ) VALUES ('s-legacy', 'task-1', 'T1', 'C1', '1000.000001', 'U1', 'engineering', '/srv/repos/example',
          'agent', 'hourly check', 3600, 'skip', 60, 'skip', 'active', ?, ?, ?)`,
      )
      .run(createdAt, createdAt, createdAt);
    // Five failed hourly runs from before outcome tracking: well past 3 failures over an hour.
    for (let hour = 1; hour <= 5; hour += 1) {
      const dueAt = `2026-09-21T0${hour}:00:00.000Z`;
      historical
        .query(
          `INSERT INTO schedule_runs (run_id, schedule_id, due_at, disposition, operation_id, created_at)
           VALUES (?, 's-legacy', ?, 'dispatched', 'operation-1', ?)`,
        )
        .run(`s-legacy:${dueAt}`, dueAt, dueAt);
    }
    historical.close();

    const store = await AgentTagStore.open(path);
    try {
      const result = store.reconcileScheduleRunOutcomes({
        now: "2026-09-21T06:00:00.000Z",
        consecutiveFailures: 3,
        minFailureSpanSeconds: 3_600,
        renderAutoDisabledNotice: () => ({ text: "unexpected" }),
      });
      // Outcomes are recorded for history, but the routine stays on with no streak.
      expect(result).toEqual({ recorded: 5, autoDisabled: [] });
      expect(store.getSchedule("s-legacy")).toMatchObject({
        state: "active",
        endedReason: null,
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
      });
    } finally {
      store.close();
    }
    const upgraded = new Database(path, { strict: true });
    expect(
      upgraded.query("SELECT DISTINCT legacy, outcome FROM schedule_runs WHERE schedule_id = 's-legacy'").all(),
    ).toEqual([{ legacy: 1, outcome: "failed" }]);
    upgraded.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-legacy-runs-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("routine migration recovers authority revocations from the audit log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-revoked-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    const historical = new Database(path, { create: true, strict: true });
    historical.exec("PRAGMA foreign_keys = ON");
    historical.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    applyMigration(historical, 1);
    seedVersionOne(historical);
    for (const { version } of STORE_MIGRATIONS) {
      if (version > 1 && version < 16) applyMigration(historical, version);
    }
    const insertSchedule = historical.query(
      `INSERT INTO schedules (
        schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id, profile_id,
        repository_root, kind, prompt, cadence_seconds, missed_run_policy, misfire_grace_seconds,
        overlap_policy, state, next_run_at, created_at, updated_at
      ) VALUES (?, 'task-1', 'T1', 'C1', '1000.000001', 'U1', 'engineering', '/srv/repos/example', 'agent',
        'hourly check', 3600, 'skip', 60, 'skip', 'cancelled', ?, ?, ?)`,
    );
    const insertAudit = historical.query(
      `INSERT INTO audit_log (
        audit_id, actor_type, actor_id, authority, source, target, action, result,
        correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, '{}', ?)`,
    );
    // Exactly the rows the previous revokeClaimedSchedule and cancelSchedule wrote.
    insertSchedule.run("s-revoked", createdAt, createdAt, "2026-09-22T00:00:00.000Z");
    insertAudit.run("audit-revoked", "worker", "schedule-worker", "schedule-dispatch", "s-revoked", "s-revoked",
      "schedule.authority-revoked", "s-revoked", "2026-09-22T00:00:00.000Z");
    insertSchedule.run("s-user", createdAt, createdAt, "2026-09-23T00:00:00.000Z");
    insertAudit.run("audit-user", "slack-user", "U1", "schedule-cancel", "s-user", "s-user",
      "schedule.cancelled", "s-user", "2026-09-23T00:00:00.000Z");
    // Audit rows pruned by retention: nothing to recover, so it stays attributed to the user.
    insertSchedule.run("s-pruned", createdAt, createdAt, "2026-09-24T00:00:00.000Z");
    historical.close();

    (await AgentTagStore.open(path)).close();

    const upgraded = new Database(path, { strict: true });
    expect(
      upgraded.query("SELECT schedule_id, ended_reason, ended_at FROM schedules ORDER BY schedule_id").all(),
    ).toEqual([
      { schedule_id: "s-pruned", ended_reason: "user-cancelled", ended_at: "2026-09-24T00:00:00.000Z" },
      { schedule_id: "s-revoked", ended_reason: "authority-revoked", ended_at: "2026-09-22T00:00:00.000Z" },
      { schedule_id: "s-user", ended_reason: "user-cancelled", ended_at: "2026-09-23T00:00:00.000Z" },
    ]);
    upgraded.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-revoked-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("D12: a fresh store creates the thread context notes table and its pending index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-notes-fresh-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    (await AgentTagStore.open(path)).close();

    const fresh = new Database(path, { readonly: true, strict: true });
    expect(
      fresh
        .query<{ type: string; name: string; tbl_name: string }, []>(
          `SELECT type, name, tbl_name FROM sqlite_master
           WHERE name IN ('thread_context_notes', 'thread_context_notes_pending_idx') ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { type: "table", name: "thread_context_notes", tbl_name: "thread_context_notes" },
      { type: "index", name: "thread_context_notes_pending_idx", tbl_name: "thread_context_notes" },
    ]);
    expect(
      fresh
        .query<{ name: string }, []>("SELECT name FROM pragma_index_info('thread_context_notes_pending_idx') ORDER BY seqno")
        .all()
        .map((row) => row.name),
    ).toEqual(["task_id", "consumed_by_operation_id", "source_order_key"]);
    expect(
      fresh.query<{ version: number }, []>("SELECT version FROM schema_migrations WHERE version = 17").get(),
    ).toEqual({ version: 17 });
    fresh.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-notes-fresh-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("D12: an operation payload written before messageTs, origin and threadContext still parses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-legacy-payload-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    // Version 1 wrote payloads without the fields added later (seedVersionOne's JSON has none of them).
    const historical = new Database(path, { create: true, strict: true });
    historical.exec("PRAGMA foreign_keys = ON");
    historical.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    applyMigration(historical, 1);
    seedVersionOne(historical);
    for (const { version } of STORE_MIGRATIONS) {
      if (version > 1) applyMigration(historical, version);
    }
    historical.close();

    const reader = new Database(path, { readonly: true, strict: true });
    const legacyJson = reader
      .query<{ payload_json: string }, []>("SELECT payload_json FROM operations WHERE operation_id = 'operation-1'")
      .get()?.payload_json;
    reader.close();
    if (legacyJson === undefined) throw new Error("legacy operation fixture is missing");
    expect(JSON.parse(legacyJson)).not.toHaveProperty("messageTs");
    expect(JSON.parse(legacyJson)).not.toHaveProperty("origin");
    expect(JSON.parse(legacyJson)).not.toHaveProperty("threadContext");

    const legacyPayload = {
      text: "preserve me",
      actorUserId: "U1",
      conversationId: "C1",
      threadTs: "1000.000001",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
    };
    expect(operationPayloadSchema.parse(JSON.parse(legacyJson))).toEqual(legacyPayload);

    const store = await AgentTagStore.open(path);
    try {
      const claimed = store.claimNextOperation({
        workerId: "worker-a",
        now: "2026-09-21T00:00:01.000Z",
        leaseMs: 10_000,
        maxConcurrentTasks: 1,
      });
      expect(claimed?.operationId).toBe("operation-1");
      // Claiming fills what the legacy payload lacks: origin "slack" and messageTs from the event key
      // (withDerivedOrigin). threadContext has no legacy source, so it stays absent.
      expect(claimed?.payload).toEqual({ ...legacyPayload, origin: "slack", messageTs: "1000.000001" });
      expect(claimed?.payload.threadContext).toBeUndefined();
    } finally {
      store.close();
    }
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-legacy-payload-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("H1: migration 20 adds the command ledger without a command_kind CHECK and the thread controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-migration-commands-"));
  const path = join(directory, "agent-tag.sqlite");
  try {
    (await AgentTagStore.open(path)).close();
    // Reopening re-runs nothing.
    (await AgentTagStore.open(path)).close();

    const database = new Database(path, { strict: true });
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 20").get(),
    ).toEqual({ count: 1 });
    const insertCommand = database.query(
      `INSERT INTO slack_command_events (workspace_id, event_key, delivery_id, conversation_id, thread_ts, actor_user_id,
         command_kind, task_id, outcome, reason, memory_id, received_at, updated_at)
       VALUES ('T1', ?, 'd', 'C1', NULL, 'U1', ?, NULL, 'started', NULL, NULL, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z')`,
    );
    // A later lane's command kind needs no table rebuild.
    insertCommand.run("C1:1.1", "some-future-command");
    expect(() => insertCommand.run("C1:1.1", "help")).toThrow();
    expect(
      database
        .query<{ name: string }, []>("SELECT name FROM pragma_index_list('slack_command_events') ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toContain("slack_command_events_actor_idx");

    const insertControl = database.query(
      `INSERT INTO slack_thread_controls (workspace_id, conversation_id, thread_ts, muted_at, muted_by, mute_source, updated_at)
       VALUES ('T1', 'C1', ?, ?, ?, ?, '2026-09-21T00:00:00.000Z')`,
    );
    insertControl.run("1.1", "2026-09-21T00:00:00.000Z", "U1", "command");
    insertControl.run("1.2", null, null, null);
    expect(() => insertControl.run("1.3", "2026-09-21T00:00:00.000Z", "U1", "other")).toThrow();
    expect(() => insertControl.run("1.4", "2026-09-21T00:00:00.000Z", null, "command")).toThrow();
    database.close();
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-commands-`)) {
      throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});
