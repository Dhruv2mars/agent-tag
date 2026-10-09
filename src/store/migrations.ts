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
    version: 13,
    sql: `
      ALTER TABLE interactions ADD COLUMN blocked_until TEXT;
      ALTER TABLE operations ADD COLUMN t3_turn_started_at TEXT;
      ALTER TABLE operations ADD COLUMN t3_turn_id TEXT;
      ALTER TABLE operations ADD COLUMN t3_turn_dispatched_at TEXT;

      -- Unfinished or failed operations from before these markers existed: a posted "working"
      -- message or a recorded T3 approval/user-input request proves the turn started, and any claim
      -- may have dispatched it. Cancellation must interrupt these in T3 rather than drop them
      -- locally. A local failure (settlement timeout, service errors) leaves the T3 turn running,
      -- so failed operations are backfilled too; the worker settles those whose failure code
      -- records an observed T3 outcome without contacting T3.
      UPDATE operations SET t3_turn_started_at = COALESCE(
          (SELECT MIN(created_at) FROM slack_outbox
           WHERE client_message_id = operations.operation_id || ':started'),
          (SELECT MIN(created_at) FROM interactions
           WHERE operation_id = operations.operation_id AND kind IN ('approval', 'user-input')))
      WHERE status IN ('pending', 'inflight', 'failed');
      UPDATE operations SET t3_turn_dispatched_at = COALESCE(t3_turn_started_at, updated_at)
      WHERE status IN ('pending', 'inflight', 'failed') AND (
        t3_turn_started_at IS NOT NULL OR attempts > 0 OR EXISTS (
          SELECT 1 FROM audit_log
          WHERE correlation_id = operations.operation_id AND action = 'operation.claimed'));

      -- A response that failed only because transient errors exhausted its retry budget. A fresh
      -- Slack cancel may requeue such a cancellation once T3 recovers; terminal failures stay final.
      ALTER TABLE interactions ADD COLUMN retries_exhausted INTEGER NOT NULL DEFAULT 0
        CHECK (retries_exhausted IN (0, 1));
      -- Slack action ids a requeue superseded on an interaction's source_action_id, kept so a late
      -- redelivery of any accepted action stays deduplicated instead of targeting a newer operation.
      CREATE TABLE interaction_source_actions (
        source_action_id TEXT PRIMARY KEY,
        interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX interaction_source_actions_interaction_idx ON interaction_source_actions(interaction_id);
    `,
  },
  {
    // Independent of 13: only adds a column, so it applies in any order relative to it (a store that
    // ran 14 before 13 existed still picks up 13, since applied versions are tracked as a set).
    version: 14,
    sql: `
      ALTER TABLE operations ADD COLUMN turn_active_ms INTEGER NOT NULL DEFAULT 0
        CHECK (turn_active_ms >= 0);
    `,
  },
  {
    // Message edits (chat.update): an 'update' row edits the message its target 'post' row posted.
    // refresh_kind is validated in zod, not a CHECK, so new kinds need no table rebuild.
    version: 15,
    sql: `
      ALTER TABLE slack_outbox ADD COLUMN method TEXT NOT NULL DEFAULT 'post'
        CHECK (method IN ('post', 'update'));
      ALTER TABLE slack_outbox ADD COLUMN target_outbox_id TEXT REFERENCES slack_outbox(outbox_id);
      ALTER TABLE slack_outbox ADD COLUMN refresh_kind TEXT;
      CREATE INDEX slack_outbox_refresh_idx ON slack_outbox(target_outbox_id, status) WHERE method = 'update';
    `,
  },
  {
    // Routines (PR-J1): request source and time zone, run outcomes, failure streaks and end reasons.
    // "Disabled" is state = 'cancelled' with ended_reason = 'auto-disabled', so the state CHECK is unchanged.
    version: 16,
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
      -- End reasons for schedules that ended before this migration. Before it, only three paths ended a
      -- schedule: settling a one-shot's run ('completed', the only writer of that state), a user cancel
      -- (audit 'schedule.cancelled') and a claimed run losing execution authority (audit
      -- 'schedule.authority-revoked'); both cancel paths set state 'cancelled' and only from 'active',
      -- so a schedule has at most one of those rows. The earliest such row decides. Where retention
      -- pruned it, the reason is unrecoverable and defaults to 'user-cancelled'. updated_at is the end
      -- time: nothing touched an ended schedule after that transition.
      UPDATE schedules SET ended_reason = CASE
          WHEN state = 'completed' THEN 'completed'
          WHEN (SELECT a.action FROM audit_log a
                WHERE a.correlation_id = schedules.schedule_id AND a.target = schedules.schedule_id
                  AND a.action IN ('schedule.cancelled', 'schedule.authority-revoked')
                ORDER BY a.created_at, a.audit_id LIMIT 1) = 'schedule.authority-revoked'
            THEN 'authority-revoked'
          ELSE 'user-cancelled' END,
        ended_at = updated_at WHERE state <> 'active';
    `,
  },
  {
    // Thread context notes (PR-G3): bot, non-allowlisted and edit updates in a bound thread, shown on
    // the next human turn and consumed by it. Independent table, so it applies in any order relative
    // to other new versions.
    version: 17,
    sql: `
      CREATE TABLE thread_context_notes (
        note_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        source_event_key TEXT NOT NULL,
        source_delivery_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'edit')),
        speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('human', 'bot')),
        speaker_id TEXT NOT NULL,
        speaker_label TEXT,
        steering_allowed INTEGER NOT NULL CHECK (steering_allowed IN (0, 1)),
        message_ts TEXT NOT NULL,
        text TEXT NOT NULL,
        previous_text TEXT,
        source_order_key TEXT NOT NULL,
        consumed_by_operation_id TEXT REFERENCES operations(operation_id),
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, source_event_key)
      );
      CREATE INDEX thread_context_notes_pending_idx
        ON thread_context_notes(task_id, consumed_by_operation_id, source_order_key);
    `,
  },
  {
    // Draft PR workflow (PR-M2): one pull request per task and the push/PR jobs that keep it current.
    // github_repo, head_branch and base_branch come from config (never from a repository's git config).
    // A job is keyed by the operation whose completed turn recorded it, so a replay inserts nothing.
    version: 18,
    sql: `
      CREATE TABLE task_pull_requests (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        github_repo TEXT NOT NULL,
        head_branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        pr_number INTEGER CHECK (pr_number IS NULL OR pr_number > 0),
        pr_url TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'open', 'closed', 'merged')),
        draft INTEGER NOT NULL DEFAULT 1 CHECK (draft IN (0, 1)),
        last_pushed_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state = 'pending') = (pr_number IS NULL))
      );
      CREATE TABLE pr_sync_jobs (
        job_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
        conversation_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        github_repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        branch TEXT,
        sha TEXT,
        mirror_ref TEXT,
        ahead_count INTEGER CHECK (ahead_count IS NULL OR ahead_count >= 0),
        request_text TEXT,
        summary_text TEXT,
        status TEXT NOT NULL CHECK (status IN
          ('awaiting-approval', 'pending', 'inflight', 'succeeded', 'skipped', 'blocked', 'failed')),
        result_code TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        blocked_until TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status <> 'inflight' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
      );
      CREATE INDEX pr_sync_jobs_claim_idx ON pr_sync_jobs(status, blocked_until, created_at);
      CREATE INDEX pr_sync_jobs_task_idx ON pr_sync_jobs(task_id, status, created_at);
    `,
  },
];
