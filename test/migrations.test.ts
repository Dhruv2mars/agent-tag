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
  const versions = STORE_MIGRATIONS.map((migration) => migration.version);
  expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
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
