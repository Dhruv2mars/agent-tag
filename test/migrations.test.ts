import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_MIGRATIONS } from "../src/store/migrations.ts";
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
  // 13 belongs to an independent branch; 14 must apply whether or not it is present.
  const versions = STORE_MIGRATIONS.map((migration) => migration.version);
  expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15]);

  for (const startingVersion of versions) {
    const directory = await mkdtemp(join(tmpdir(), `agent-tag-migration-v${startingVersion}-`));
    const path = join(directory, "agent-tag.sqlite");
    try {
      const historical = new Database(path, { create: true, strict: true });
      historical.exec("PRAGMA foreign_keys = ON");
      historical.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      applyMigration(historical, 1);
      seedVersionOne(historical);
      for (const version of versions) {
        if (version > 1 && version <= startingVersion) applyMigration(historical, version);
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
          .query<{ status: string; blocked_until: string | null; render_mode: string }, []>(
            "SELECT status, blocked_until, render_mode FROM slack_outbox",
          )
          .get(),
      ).toEqual({ status: "pending", blocked_until: null, render_mode: "rich" });
      expect(
        upgraded.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM slack_rate_limits").get(),
      ).toEqual({ count: 0 });
      expect(
        upgraded.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
      ).toBe("ok");
      upgraded.close();
    } finally {
      if (!directory.startsWith(`${tmpdir()}/agent-tag-migration-v${startingVersion}-`)) {
        throw new Error(`refusing to remove unexpected migration fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
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
      if (version > 1 && version < 15) applyMigration(historical, version);
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
