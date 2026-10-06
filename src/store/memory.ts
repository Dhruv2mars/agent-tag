import type { Database } from "bun:sqlite";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { isoDateTime, memoryContent, memoryRowSchema } from "./schema.ts";
import type { MemoryRecord } from "./types.ts";

function projectMemoryRow(raw: unknown): MemoryRecord {
  const row = memoryRowSchema.parse(raw);
  return {
    memoryId: row.memory_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    profileId: row.profile_id,
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateMemoryInput {
  readonly workspaceId: string;
  readonly scope: "shared" | "profile" | "task" | "private";
  readonly profileId?: string;
  readonly taskId?: string;
  readonly ownerUserId?: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly actorUserId: string;
  readonly expiresAt: string;
  readonly now: string;
}

export function createMemory(database: Database, input: CreateMemoryInput): MemoryRecord {
  const now = isoDateTime.parse(input.now);
  const expiresAt = isoDateTime.parse(input.expiresAt);
  const memoryId = crypto.randomUUID();
  const dimensions = {
    profileId: input.profileId === undefined ? null : requiredId(input.profileId, "profileId"),
    taskId: input.taskId === undefined ? null : requiredId(input.taskId, "taskId"),
    ownerUserId: input.ownerUserId === undefined ? null : requiredId(input.ownerUserId, "ownerUserId"),
  };
  const create = database.transaction((): MemoryRecord => {
    database
      .query(
        `INSERT INTO memory_entries (
          memory_id, workspace_id, scope, profile_id, task_id, owner_user_id, content,
          source_type, source_id, state, expires_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        requiredId(input.workspaceId, "workspaceId"),
        input.scope,
        dimensions.profileId,
        dimensions.taskId,
        dimensions.ownerUserId,
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
      metadata: { scope: input.scope, sourceType: input.sourceType, expiresAt },
      createdAt: now,
    });
    return projectMemoryRow(
      database
        .query(
          `SELECT memory_id, workspace_id, scope, profile_id, task_id, owner_user_id,
                  content, source_type, source_id, version, expires_at, created_by, created_at, updated_at
           FROM memory_entries WHERE memory_id = ?`,
        )
        .get(memoryId),
    );
  });
  return create.immediate();
}

export function getMemory(database: Database, memoryId: string): MemoryRecord | null {
  const raw = database
    .query(
      `SELECT memory_id, workspace_id, scope, profile_id, task_id, owner_user_id,
              content, source_type, source_id, version, expires_at, created_by, created_at, updated_at
       FROM memory_entries WHERE memory_id = ? AND state = 'active'`,
    )
    .get(requiredId(memoryId, "memoryId"));
  return raw === null ? null : projectMemoryRow(raw);
}

export interface ListMemoryInput {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly taskId?: string;
  readonly ownerUserId: string;
  readonly includeShared: boolean;
  readonly includePrivate: boolean;
  readonly now: string;
  readonly limit?: number;
}

export function listMemory(database: Database, input: ListMemoryInput): ReadonlyArray<MemoryRecord> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("memory list limit must be between 1 and 100");
  }
  const taskId = input.taskId === undefined ? "" : requiredId(input.taskId, "taskId");
  return database
    .query(
      `SELECT memory_id, workspace_id, scope, profile_id, task_id, owner_user_id,
              content, source_type, source_id, version, expires_at, created_by, created_at, updated_at
       FROM memory_entries
       WHERE workspace_id = ? AND state = 'active' AND expires_at > ? AND (
         (scope = 'shared' AND ? = 1) OR
         (scope = 'profile' AND profile_id = ?) OR
         (scope = 'task' AND task_id = ?) OR
         (scope = 'private' AND profile_id = ? AND owner_user_id = ? AND ? = 1)
       )
       ORDER BY updated_at DESC, memory_id LIMIT ?`,
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
      limit,
    )
    .map(projectMemoryRow);
}

export interface UpdateMemoryInput {
  readonly memoryId: string;
  readonly actorUserId: string;
  readonly content: string;
  readonly now: string;
}

export function updateMemory(database: Database, input: UpdateMemoryInput): MemoryRecord {
  const now = isoDateTime.parse(input.now);
  const update = database.transaction(() => {
    const result = database
      .query(
        `UPDATE memory_entries SET content = ?, version = version + 1, updated_at = ?
         WHERE memory_id = ? AND state = 'active' AND expires_at > ?`,
      )
      .run(
        memoryContent.parse(input.content),
        now,
        requiredId(input.memoryId, "memoryId"),
        now,
      );
    if (result.changes !== 1) throw new Error("active memory not found");
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "memory-edit",
      source: input.memoryId,
      target: input.memoryId,
      action: "memory.updated",
      result: "active",
      correlationId: input.memoryId,
      metadata: {},
      createdAt: now,
    });
    const record = getMemory(database, input.memoryId);
    if (record === null) throw new Error("updated memory not found");
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
    const result = database
      .query(
        `UPDATE memory_entries SET state = 'forgotten', forgotten_at = ?, updated_at = ?
         WHERE memory_id = ? AND state = 'active'`,
      )
      .run(now, now, requiredId(input.memoryId, "memoryId"));
    if (result.changes !== 1) throw new Error("active memory not found");
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "memory-forget",
      source: input.memoryId,
      target: input.memoryId,
      action: "memory.forgotten",
      result: "forgotten",
      correlationId: input.memoryId,
      metadata: {},
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
