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
  expect(STORE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  for (const startingVersion of STORE_MIGRATIONS.map((migration) => migration.version)) {
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
      for (let version = 2; version <= startingVersion; version += 1) {
        applyMigration(historical, version);
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
          }, []>("SELECT source_order_key, blocked_until, resolved_text FROM operations")
          .get(),
      ).toEqual({ source_order_key: createdAt, blocked_until: null, resolved_text: null });
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
