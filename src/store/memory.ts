// Scoped memory entries with versioned edits, forgetting and retention expiry.
import type { Database } from "bun:sqlite";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { isoDateTime, memoryContent, memoryRowSchema } from "./schema.ts";
import type { MemoryRecord, MemoryScope } from "./types.ts";

const MEMORY_COLUMNS = `memory_id, workspace_id, scope, profile_id, task_id, owner_user_id, conversation_id,
  content, source_type, source_id, version, expires_at, created_by, updated_by, created_at, updated_at`;

function projectMemoryRow(raw: unknown): MemoryRecord {
  const row = memoryRowSchema.parse(raw);
  return {
    memoryId: row.memory_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    profileId: row.profile_id,
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateMemoryInput {
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly profileId?: string;
  readonly taskId?: string;
  readonly ownerUserId?: string;
  readonly conversationId?: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly actorUserId: string;
  readonly expiresAt: string;
  readonly now: string;
}

const SCOPE_DIMENSIONS: Readonly<Record<MemoryScope, readonly string[]>> = {
  shared: [],
  profile: ["profileId"],
  task: ["taskId"],
  private: ["profileId", "ownerUserId"],
  channel: ["conversationId"],
};

export function createMemory(database: Database, input: CreateMemoryInput): MemoryRecord {
  const now = isoDateTime.parse(input.now);
  const expiresAt = isoDateTime.parse(input.expiresAt);
  const memoryId = crypto.randomUUID();
  const dimensions = {
    profileId: input.profileId === undefined ? null : requiredId(input.profileId, "profileId"),
    taskId: input.taskId === undefined ? null : requiredId(input.taskId, "taskId"),
    ownerUserId: input.ownerUserId === undefined ? null : requiredId(input.ownerUserId, "ownerUserId"),
    conversationId: input.conversationId === undefined ? null : requiredId(input.conversationId, "conversationId"),
  };
  // Mirrors the table CHECK, so a caller gets a clear error rather than a constraint failure.
  const required = SCOPE_DIMENSIONS[input.scope];
  for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
    if ((dimensions[key] !== null) !== required.includes(key)) {
      throw new Error(`${input.scope} memory ${required.includes(key) ? "requires" : "must not set"} ${key}`);
    }
  }
  const create = database.transaction((): MemoryRecord => {
    database
      .query(
        `INSERT INTO memory_entries (
          memory_id, workspace_id, scope, profile_id, task_id, owner_user_id, conversation_id, content,
          source_type, source_id, state, expires_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        requiredId(input.workspaceId, "workspaceId"),
        input.scope,
        dimensions.profileId,
        dimensions.taskId,
        dimensions.ownerUserId,
        dimensions.conversationId,
        memoryContent.parse(input.content),
        requiredId(input.sourceType, "sourceType"),
        requiredId(input.sourceId, "sourceId"),
        expiresAt,
        requiredId(input.actorUserId, "actorUserId"),
        now,
        now,
      );
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: `memory:${input.scope}`,
      source: input.sourceId,
      target: memoryId,
      action: "memory.created",
      result: "active",
      correlationId: memoryId,
      metadata: {
        scope: input.scope,
        sourceType: input.sourceType,
        expiresAt,
        ...(dimensions.conversationId === null ? {} : { conversationId: dimensions.conversationId }),
      },
      createdAt: now,
    });
    return projectMemoryRow(
      database
        .query(
          `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE memory_id = ?`,
        )
        .get(memoryId),
    );
  });
  return create.immediate();
}

export function getMemory(database: Database, memoryId: string): MemoryRecord | null {
  const raw = database
    .query(
      `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE memory_id = ? AND state = 'active'`,
    )
    .get(requiredId(memoryId, "memoryId"));
  return raw === null ? null : projectMemoryRow(raw);
}

export interface ListVisibleMemoryInput {
  readonly workspaceId: string;
  readonly profileId: string;
  /** The Slack conversation; `channel` notes are read only here. Omitted reads no channel notes. */
  readonly conversationId?: string;
  readonly taskId?: string;
  /** The actor; used only for `private` notes. */
  readonly ownerUserId: string;
  readonly includeShared: boolean;
  readonly includePrivate: boolean;
  /** False in DMs, which keep their notes as `private`. */
  readonly includeChannel: boolean;
  readonly now: string;
  readonly limit?: number;
}

/** Active, unexpired notes visible in one conversation: channel/DM first, then operator and task, then workspace; newest first. */
export function listVisibleMemory(database: Database, input: ListVisibleMemoryInput): ReadonlyArray<MemoryRecord> {
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("memory list limit must be between 1 and 500");
  }
  const taskId = input.taskId === undefined ? "" : requiredId(input.taskId, "taskId");
  return database
    .query(
      `SELECT ${MEMORY_COLUMNS}
       FROM memory_entries
       WHERE workspace_id = ? AND state = 'active' AND expires_at > ? AND (
         (scope = 'shared' AND ? = 1) OR
         (scope = 'profile' AND profile_id = ?) OR
         (scope = 'task' AND task_id = ?) OR
         (scope = 'private' AND profile_id = ? AND owner_user_id = ? AND ? = 1) OR
         (scope = 'channel' AND conversation_id = ? AND ? = 1)
       )
       ORDER BY CASE scope WHEN 'channel' THEN 0 WHEN 'private' THEN 0 WHEN 'profile' THEN 1 WHEN 'task' THEN 1 ELSE 2 END,
         updated_at DESC, memory_id
       LIMIT ?`,
    )
    .all(
      requiredId(input.workspaceId, "workspaceId"),
      isoDateTime.parse(input.now),
      input.includeShared ? 1 : 0,
      requiredId(input.profileId, "profileId"),
      taskId,
      input.profileId,
      requiredId(input.ownerUserId, "ownerUserId"),
      input.includePrivate ? 1 : 0,
      input.conversationId === undefined ? "" : requiredId(input.conversationId, "conversationId"),
      input.includeChannel && input.conversationId !== undefined ? 1 : 0,
      limit,
    )
    .map(projectMemoryRow);
}

// The first 4 to 36 characters of a memory ID (a UUID, dashes included).
const MEMORY_REF = /^[0-9a-f](?:[0-9a-f-]){3,35}$/;

/** Normalizes a user-typed ref (`#A1B2c3d4`, `a1b2c3d4`) to a lowercase ID prefix, or null when malformed. */
export function normalizeMemoryRef(ref: string): string | null {
  const normalized = ref.trim().replace(/^#/, "").toLowerCase();
  return MEMORY_REF.test(normalized) ? normalized : null;
}

export interface FindMemoryByRefInput {
  readonly workspaceId: string;
  readonly refPrefix: string;
  readonly now: string;
}

/**
 * Active, unexpired notes whose ID starts with the ref. No visibility filter: the caller filters, so
 * a note it cannot see and a missing note look the same.
 */
export function findMemoryByRef(database: Database, input: FindMemoryByRefInput): ReadonlyArray<MemoryRecord> {
  const prefix = normalizeMemoryRef(input.refPrefix);
  if (prefix === null) return [];
  return database
    .query(
      `SELECT ${MEMORY_COLUMNS} FROM memory_entries
       WHERE workspace_id = ? AND state = 'active' AND expires_at > ? AND substr(memory_id, 1, ?) = ?
       ORDER BY memory_id`,
    )
    .all(requiredId(input.workspaceId, "workspaceId"), isoDateTime.parse(input.now), prefix.length, prefix)
    .map(projectMemoryRow);
}

/** One store of notes: a scope plus the dimensions that key it (as in the table CHECK). */
export interface MemoryStoreKey {
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly profileId?: string;
  readonly taskId?: string;
  readonly ownerUserId?: string;
  readonly conversationId?: string;
}

function storeKeyClause(key: MemoryStoreKey): { readonly sql: string; readonly values: (string | null)[] } {
  return {
    sql: `workspace_id = ? AND scope = ? AND profile_id IS ? AND task_id IS ? AND owner_user_id IS ? AND conversation_id IS ?`,
    values: [
      requiredId(key.workspaceId, "workspaceId"),
      key.scope,
      key.profileId ?? null,
      key.taskId ?? null,
      key.ownerUserId ?? null,
      key.conversationId ?? null,
    ],
  };
}

/** The active note in the same store whose trimmed, case-folded content matches, if any. */
export function findDuplicateMemory(
  database: Database,
  input: MemoryStoreKey & { readonly content: string; readonly now: string },
): MemoryRecord | null {
  const key = storeKeyClause(input);
  const raw = database
    .query(
      `SELECT ${MEMORY_COLUMNS} FROM memory_entries
       WHERE ${key.sql} AND state = 'active' AND expires_at > ? AND lower(trim(content)) = lower(trim(?))
       ORDER BY created_at, memory_id LIMIT 1`,
    )
    .get(...key.values, isoDateTime.parse(input.now), input.content);
  return raw === null ? null : projectMemoryRow(raw);
}

/** Active, unexpired notes in one store; used for the per-store caps. */
export function countActiveMemory(database: Database, input: MemoryStoreKey & { readonly now: string }): number {
  const key = storeKeyClause(input);
  return database
    .query<{ count: number }, (string | null)[]>(
      `SELECT COUNT(*) AS count FROM memory_entries WHERE ${key.sql} AND state = 'active' AND expires_at > ?`,
    )
    .get(...key.values, isoDateTime.parse(input.now))?.count ?? 0;
}

/** Whether a conversation has any active channel note (PR-V: intro skip and ambient gating). */
export function hasConversationMemory(
  database: Database,
  input: { readonly workspaceId: string; readonly conversationId: string; readonly now: string },
): boolean {
  return database
    .query(
      `SELECT 1 FROM memory_entries
       WHERE workspace_id = ? AND scope = 'channel' AND conversation_id = ? AND state = 'active' AND expires_at > ?
       LIMIT 1`,
    )
    .get(
      requiredId(input.workspaceId, "workspaceId"),
      requiredId(input.conversationId, "conversationId"),
      isoDateTime.parse(input.now),
    ) !== null;
}

/** The memory digest the task's last frozen turn showed; null before any turn or when it showed none. */
export function getTaskMemoryDigest(database: Database, taskId: string): string | null {
  const row = database
    .query<{ memory_digest: string | null }, [string]>("SELECT memory_digest FROM tasks WHERE task_id = ?")
    .get(requiredId(taskId, "taskId"));
  if (row === null) throw new Error("task not found");
  return row.memory_digest;
}

export interface UpdateMemoryInput {
  readonly memoryId: string;
  readonly actorUserId: string;
  readonly content: string;
  /** A new retention deadline; an edit from Slack refreshes retention. Omitted keeps it. */
  readonly expiresAt?: string;
  readonly now: string;
}

export function updateMemory(database: Database, input: UpdateMemoryInput): MemoryRecord {
  const now = isoDateTime.parse(input.now);
  const expiresAt = input.expiresAt === undefined ? null : isoDateTime.parse(input.expiresAt);
  const update = database.transaction(() => {
    const result = database
      .query(
        `UPDATE memory_entries
         SET content = ?, version = version + 1, updated_by = ?, expires_at = COALESCE(?, expires_at), updated_at = ?
         WHERE memory_id = ? AND state = 'active' AND expires_at > ?`,
      )
      .run(
        memoryContent.parse(input.content),
        requiredId(input.actorUserId, "actorUserId"),
        expiresAt,
        now,
        requiredId(input.memoryId, "memoryId"),
        now,
      );
    if (result.changes !== 1) throw new Error("active memory not found");
    const record = getMemory(database, input.memoryId);
    if (record === null) throw new Error("updated memory not found");
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "memory-edit",
      source: input.memoryId,
      target: input.memoryId,
      action: "memory.updated",
      result: "active",
      correlationId: input.memoryId,
      metadata: { scope: record.scope, version: record.version },
      createdAt: now,
    });
    return record;
  });
  return update.immediate();
}

export interface ForgetMemoryInput {
  readonly memoryId: string;
  readonly actorUserId: string;
  readonly now: string;
}

export function forgetMemory(database: Database, input: ForgetMemoryInput): void {
  const now = isoDateTime.parse(input.now);
  const forget = database.transaction(() => {
    const memory = getMemory(database, input.memoryId);
    if (memory === null) throw new Error("active memory not found");
    database
      .query(
        `UPDATE memory_entries SET state = 'forgotten', forgotten_at = ?, updated_by = ?, updated_at = ?
         WHERE memory_id = ? AND state = 'active'`,
      )
      .run(now, requiredId(input.actorUserId, "actorUserId"), now, memory.memoryId);
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "memory-forget",
      source: input.memoryId,
      target: input.memoryId,
      action: "memory.forgotten",
      result: "forgotten",
      correlationId: input.memoryId,
      metadata: { scope: memory.scope },
      createdAt: now,
    });
  });
  forget.immediate();
}

export function expireMemory(database: Database, nowInput: string): number {
  const now = isoDateTime.parse(nowInput);
  const expire = database.transaction(() => {
    const rows = database
      .query<{ memory_id: string }, [string]>(
        "SELECT memory_id FROM memory_entries WHERE state = 'active' AND expires_at <= ?",
      )
      .all(now);
    for (const row of rows) {
      const memoryId = requiredId(row.memory_id, "memoryId");
      database
        .query(
          `UPDATE memory_entries SET state = 'forgotten', forgotten_at = ?, updated_at = ?
           WHERE memory_id = ? AND state = 'active'`,
        )
        .run(now, now, memoryId);
      writeAudit(database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "memory-retention",
        source: memoryId,
        target: memoryId,
        action: "memory.expired",
        result: "forgotten",
        correlationId: memoryId,
        metadata: {},
        createdAt: now,
      });
    }
    return rows.length;
  });
  return expire.immediate();
}

export interface RecordMemoryDenialInput {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly workspaceId: string;
  readonly now: string;
}

export function recordMemoryDenial(database: Database, input: RecordMemoryDenialInput): void {
  const now = isoDateTime.parse(input.now);
  writeAudit(database, {
    actorType: "slack-user",
    actorId: requiredId(input.actorUserId, "actorUserId"),
    authority: "memory-policy",
    source: requiredId(input.sourceId, "sourceId"),
    target: requiredId(input.workspaceId, "workspaceId"),
    action: "memory.denied",
    result: requiredId(input.reason, "reason"),
    correlationId: input.sourceId,
    metadata: {},
    createdAt: now,
  });
}
