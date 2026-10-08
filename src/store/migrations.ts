export interface StoreMigration {
  readonly version: number;
  readonly sql: string;
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE slack_events (
        workspace_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        canonical_delivery_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_key)
      );

      CREATE TABLE slack_deliveries (
        delivery_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        canonical_operation_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'duplicate')),
        received_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        t3_project_id TEXT,
        t3_thread_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, conversation_id, thread_ts)
      );

      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        source_delivery_id TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user-turn')),
        command_id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'inflight', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        result_sequence INTEGER,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX operations_claim_idx ON operations(status, lease_expires_at, created_at);
      CREATE INDEX operations_task_idx ON operations(task_id, created_at, operation_id);

      CREATE TABLE slack_outbox (
        outbox_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        correlation_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        client_message_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'inflight', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        slack_message_ts TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX slack_outbox_claim_idx ON slack_outbox(status, lease_expires_at, created_at);

      CREATE TABLE audit_log (
        audit_id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_log_correlation_idx ON audit_log(correlation_id, created_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE operations ADD COLUMN source_order_key TEXT NOT NULL DEFAULT '';
      UPDATE operations SET source_order_key = created_at WHERE source_order_key = '';
      CREATE INDEX operations_task_order_idx
        ON operations(task_id, source_order_key, operation_id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE tasks ADD COLUMN t3_thread_started_at TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE operations ADD COLUMN blocked_until TEXT;

      CREATE TABLE interactions (
        interaction_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        thread_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('approval', 'user-input', 'cancel')),
        prompt_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'response-pending', 'inflight', 'resolved', 'failed')),
        response_command_id TEXT NOT NULL UNIQUE,
        response_json TEXT,
        response_actor_id TEXT,
        source_action_id TEXT UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (thread_id, request_id, kind)
      );

      CREATE INDEX interactions_claim_idx ON interactions(state, lease_expires_at, created_at);
      CREATE INDEX interactions_operation_idx ON interactions(operation_id, created_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE memory_entries (
        memory_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('shared', 'profile', 'task', 'private')),
        profile_id TEXT,
        task_id TEXT REFERENCES tasks(task_id),
        owner_user_id TEXT,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'forgotten')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        expires_at TEXT NOT NULL,
        forgotten_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'shared' AND profile_id IS NULL AND task_id IS NULL AND owner_user_id IS NULL) OR
          (scope = 'profile' AND profile_id IS NOT NULL AND task_id IS NULL AND owner_user_id IS NULL) OR
          (scope = 'task' AND profile_id IS NULL AND task_id IS NOT NULL AND owner_user_id IS NULL) OR
          (scope = 'private' AND profile_id IS NOT NULL AND task_id IS NULL AND owner_user_id IS NOT NULL)
        )
      );

      CREATE INDEX memory_entries_visibility_idx
        ON memory_entries(workspace_id, state, scope, profile_id, task_id, owner_user_id, expires_at);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE operations ADD COLUMN resolved_text TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE schedules (
        schedule_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'reminder')),
        prompt TEXT NOT NULL,
        cadence_seconds INTEGER CHECK (cadence_seconds IS NULL OR cadence_seconds >= 60),
        missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('run-once', 'skip')),
        misfire_grace_seconds INTEGER NOT NULL CHECK (misfire_grace_seconds >= 0),
        overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('skip', 'queue')),
        state TEXT NOT NULL CHECK (state IN ('active', 'cancelled', 'completed')),
        next_run_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX schedules_due_idx ON schedules(state, next_run_at, lease_expires_at);

      CREATE TABLE schedule_runs (
        run_id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
        due_at TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (
          disposition IN ('dispatched', 'missed-skipped', 'overlap-skipped')
        ),
        operation_id TEXT REFERENCES operations(operation_id),
        created_at TEXT NOT NULL,
        UNIQUE (schedule_id, due_at)
      );

      CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, due_at);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE ambient_decisions (
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('triggered', 'quiet')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_key)
      );

      CREATE INDEX ambient_decisions_bounds_idx
        ON ambient_decisions(workspace_id, conversation_id, disposition, created_at);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE tasks ADD COLUMN conversation_type TEXT NOT NULL DEFAULT 'channel'
        CHECK (conversation_type IN ('channel', 'dm'));
      ALTER TABLE tasks ADD COLUMN owner_user_id TEXT;
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE interactions ADD COLUMN partial_response_json TEXT;
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE schedules ADD COLUMN recurrence_json TEXT;
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE slack_outbox ADD COLUMN blocked_until TEXT;
      ALTER TABLE slack_outbox ADD COLUMN render_mode TEXT NOT NULL DEFAULT 'rich'
        CHECK (render_mode IN ('rich', 'plain'));
      CREATE INDEX slack_outbox_thread_idx
        ON slack_outbox(conversation_id, thread_ts, status, created_at);
      CREATE TABLE slack_rate_limits (
        scope TEXT PRIMARY KEY,
        blocked_until TEXT NOT NULL,
        error_code TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // Independent of 13 (another branch): only adds a column, so it applies in any order relative to it.
    version: 14,
    sql: `
      ALTER TABLE operations ADD COLUMN turn_active_ms INTEGER NOT NULL DEFAULT 0
        CHECK (turn_active_ms >= 0);
    `,
  },
  {
    // Routines (PR-J1): request source and time zone, run outcomes, failure streaks and end reasons.
    // "Disabled" is state = 'cancelled' with ended_reason = 'auto-disabled', so the state CHECK is unchanged.
    version: 15,
    sql: `
      ALTER TABLE schedules ADD COLUMN time_zone TEXT;
      ALTER TABLE schedules ADD COLUMN human_readable TEXT;
      ALTER TABLE schedules ADD COLUMN source_event_key TEXT;
      ALTER TABLE schedules ADD COLUMN notify_user_id TEXT;
      ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0
        CHECK (consecutive_failures >= 0);
      ALTER TABLE schedules ADD COLUMN failure_streak_started_at TEXT;
      ALTER TABLE schedules ADD COLUMN ended_reason TEXT CHECK (ended_reason IS NULL OR
        ended_reason IN ('user-cancelled', 'auto-disabled', 'authority-revoked', 'completed'));
      ALTER TABLE schedules ADD COLUMN ended_at TEXT;
      CREATE UNIQUE INDEX schedules_source_event_idx ON schedules(workspace_id, source_event_key)
        WHERE source_event_key IS NOT NULL;
      CREATE INDEX schedules_conversation_idx
        ON schedules(workspace_id, conversation_id, state, created_at);
      ALTER TABLE schedule_runs ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR
        outcome IN ('succeeded', 'failed', 'cancelled', 'skipped'));
      ALTER TABLE schedule_runs ADD COLUMN outcome_at TEXT;
      ALTER TABLE schedule_runs ADD COLUMN outcome_error_code TEXT;
      CREATE INDEX schedule_runs_pending_outcome_idx ON schedule_runs(created_at) WHERE outcome IS NULL;
      -- Runs dispatched before outcome tracking existed still get an outcome for history, but never
      -- count toward an auto-disable streak: an upgrade must not disable a routine for failures that
      -- happened before the policy shipped. Only runs recorded from here on start at legacy = 0.
      ALTER TABLE schedule_runs ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1));
      UPDATE schedule_runs SET legacy = 1;
      UPDATE schedule_runs SET outcome = 'skipped', outcome_at = created_at WHERE disposition <> 'dispatched';
      UPDATE schedules SET ended_reason = CASE state WHEN 'completed' THEN 'completed' ELSE 'user-cancelled' END,
        ended_at = updated_at WHERE state <> 'active';
    `,
  },
];
