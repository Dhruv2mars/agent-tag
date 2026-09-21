import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { STORE_MIGRATIONS } from "./migrations.ts";

const nonEmpty = z.string().min(1);
const isoDateTime = z.iso.datetime();
const operationPayloadSchema = z.object({
  text: z.string(),
  actorUserId: nonEmpty,
  conversationId: nonEmpty,
  threadTs: nonEmpty,
  profileId: nonEmpty,
  repositoryRoot: nonEmpty,
});
const plainTextObjectSchema = z.object({ type: z.literal("plain_text"), text: z.string(), emoji: z.boolean().optional() });
const mrkdwnObjectSchema = z.object({ type: z.literal("mrkdwn"), text: z.string() });
const buttonElementSchema = z.object({
  type: z.literal("button"),
  text: plainTextObjectSchema,
  action_id: nonEmpty,
  value: nonEmpty,
  style: z.enum(["primary", "danger"]).optional(),
  confirm: z
    .object({
      title: plainTextObjectSchema,
      text: z.union([plainTextObjectSchema, mrkdwnObjectSchema]),
      confirm: plainTextObjectSchema,
      deny: plainTextObjectSchema,
      style: z.enum(["primary", "danger"]).optional(),
    })
    .optional(),
});
const slackBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), text: z.union([plainTextObjectSchema, mrkdwnObjectSchema]) }),
  z.object({ type: z.literal("actions"), block_id: nonEmpty.optional(), elements: z.array(buttonElementSchema).min(1) }),
  z.object({ type: z.literal("context"), elements: z.array(z.union([plainTextObjectSchema, mrkdwnObjectSchema])).min(1) }),
]);
const outboxPayloadSchema = z.object({
  text: z.string(),
  blocks: z.array(slackBlockSchema).optional(),
});

const operationRowSchema = z.object({
  operation_id: nonEmpty,
  task_id: nonEmpty,
  command_id: nonEmpty,
  message_id: nonEmpty,
  payload_json: nonEmpty,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
});

const outboxRowSchema = z.object({
  outbox_id: nonEmpty,
  task_id: nonEmpty,
  correlation_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  client_message_id: nonEmpty,
  payload_json: nonEmpty,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
});

const deliveryLookupSchema = z.object({
  canonical_operation_id: nonEmpty,
});

const canonicalEventSchema = z.object({
  operation_id: nonEmpty,
});

const operationIdentitySchema = z.object({
  operation_id: nonEmpty,
  task_id: nonEmpty,
  command_id: nonEmpty,
  message_id: nonEmpty,
});

const taskLookupSchema = z.object({
  task_id: nonEmpty,
  t3_project_id: nonEmpty.nullable(),
  t3_thread_id: nonEmpty.nullable(),
});
const outboxIdentitySchema = z.object({ outbox_id: nonEmpty });
const taskExecutionSchema = z.object({
  task_id: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
  t3_project_id: nonEmpty,
  t3_thread_id: nonEmpty,
  t3_thread_started_at: isoDateTime.nullable(),
  created_at: isoDateTime,
});
const interactionIdentitySchema = z.object({ interaction_id: nonEmpty });
const interactionRowSchema = z.object({
  interaction_id: nonEmpty,
  task_id: nonEmpty,
  operation_id: nonEmpty,
  thread_id: nonEmpty,
  request_id: nonEmpty,
  kind: z.enum(["approval", "user-input", "cancel"]),
  response_command_id: nonEmpty,
  response_json: nonEmpty,
  response_actor_id: nonEmpty,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
});
const auditRowSchema = z.object({
  audit_id: nonEmpty,
  actor_type: nonEmpty,
  actor_id: nonEmpty,
  authority: nonEmpty,
  source: nonEmpty,
  target: nonEmpty,
  action: nonEmpty,
  result: nonEmpty,
  correlation_id: nonEmpty,
  metadata_json: z.string(),
  created_at: isoDateTime,
});
const auditMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
const memoryRowSchema = z.object({
  memory_id: nonEmpty,
  workspace_id: nonEmpty,
  scope: z.enum(["shared", "profile", "task", "private"]),
  profile_id: nonEmpty.nullable(),
  task_id: nonEmpty.nullable(),
  owner_user_id: nonEmpty.nullable(),
  content: z.string().min(1).max(2_000),
  source_type: nonEmpty,
  source_id: nonEmpty,
  version: z.number().int().positive(),
  expires_at: isoDateTime,
  created_by: nonEmpty,
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
const memoryContent = z.string().trim().min(1).max(2_000);
const resolvedOperationTextSchema = z.object({ resolved_text: z.string().nullable() });
const schedulePrompt = z.string().trim().min(1).max(4_000);
const scheduleRowSchema = z.object({
  schedule_id: nonEmpty,
  task_id: nonEmpty,
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  actor_user_id: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
  kind: z.enum(["agent", "reminder"]),
  prompt: schedulePrompt,
  cadence_seconds: z.number().int().min(60).nullable(),
  missed_run_policy: z.enum(["run-once", "skip"]),
  misfire_grace_seconds: z.number().int().nonnegative(),
  overlap_policy: z.enum(["skip", "queue"]),
  next_run_at: isoDateTime,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
});
const scheduleTargetSchema = z.object({
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
});
const ambientDecisionSchema = z.object({
  disposition: z.enum(["triggered", "quiet"]),
  reason: nonEmpty,
});

export type StoreFaultPoint =
  | "ingest.after-operation"
  | "operation-claim.after-update"
  | "outbox-enqueue.after-insert"
  | "outbox-claim.after-update";

export interface StoreOpenOptions {
  readonly faultInjector?: (point: StoreFaultPoint) => void;
}

export interface SlackEventInput {
  readonly deliveryId: string;
  readonly eventKey: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly sourceOrderKey?: string;
}

export interface ActiveTaskBinding {
  readonly taskId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
}

export interface TaskExecutionBinding {
  readonly taskId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadStarted: boolean;
  readonly createdAt: string;
}

export interface IngestReceipt {
  readonly kind: "accepted" | "duplicate";
  readonly deliveryId: string;
  readonly operationId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly messageId: string;
}

export interface ClaimedOperation {
  readonly operationId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly payload: z.infer<typeof operationPayloadSchema>;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

export interface SlackOutboxInput {
  readonly taskId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: z.infer<typeof outboxPayloadSchema>;
  readonly createdAt: string;
}

export type SlackOutboxPayload = z.infer<typeof outboxPayloadSchema>;

export interface ClaimedInteractionResponse {
  readonly interactionId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly kind: "approval" | "user-input" | "cancel";
  readonly commandId: string;
  readonly actorUserId: string;
  readonly response: unknown;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

export interface ClaimedOutboxMessage {
  readonly outboxId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: SlackOutboxPayload;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

export interface AuditRecord {
  readonly auditId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly authority: string;
  readonly source: string;
  readonly target: string;
  readonly action: string;
  readonly result: string;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: string;
}

export interface AuditCursor {
  readonly createdAt: string;
  readonly auditId: string;
}

export interface MemoryRecord {
  readonly memoryId: string;
  readonly workspaceId: string;
  readonly scope: "shared" | "profile" | "task" | "private";
  readonly profileId: string | null;
  readonly taskId: string | null;
  readonly ownerUserId: string | null;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimedSchedule {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly kind: "agent" | "reminder";
  readonly prompt: string;
  readonly cadenceSeconds: number | null;
  readonly missedRunPolicy: "run-once" | "skip";
  readonly misfireGraceSeconds: number;
  readonly overlapPolicy: "skip" | "queue";
  readonly dueAt: string;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

export interface ScheduleSummary {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly kind: "agent" | "reminder";
  readonly prompt: string;
  readonly state: "active" | "cancelled" | "completed";
  readonly nextRunAt: string;
  readonly cadenceSeconds: number | null;
  readonly missedRunPolicy: "run-once" | "skip";
  readonly overlapPolicy: "skip" | "queue";
}

export type AmbientDecision =
  | { readonly kind: "triggered" }
  | { readonly kind: "quiet"; readonly reason: "unchanged" | "cooldown" | "hourly-limit" };

function requiredId(value: string, name: string): string {
  const parsed = nonEmpty.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must not be empty`);
  return parsed.data;
}

function leaseExpiry(now: string, leaseMs: number): string {
  const parsedNow = isoDateTime.parse(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
  return new Date(new Date(parsedNow).getTime() + leaseMs).toISOString();
}

function parseStoredJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

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

async function requirePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`backup parent is not a directory: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`backup parent must not grant group or world access: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`backup parent must be owned by the Agent Tag user: ${path}`);
  }
}

function verifyDatabaseFile(path: string): void {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const row = z.object({ quick_check: z.literal("ok") }).parse(
      database.query("PRAGMA quick_check").get(),
    );
    if (row.quick_check !== "ok") throw new Error("backup integrity check failed");
  } finally {
    database.close();
  }
}

function temporarySibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
}

async function installPrivateFile(input: {
  readonly temporaryPath: string;
  readonly destinationPath: string;
}): Promise<void> {
  try {
    await chmod(input.temporaryPath, 0o600);
    verifyDatabaseFile(input.temporaryPath);
    const file = await open(input.temporaryPath, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await link(input.temporaryPath, input.destinationPath);
  } finally {
    await rm(input.temporaryPath, { force: true });
  }
}

function writeAudit(
  database: Database,
  input: {
    readonly actorType: string;
    readonly actorId: string;
    readonly authority: string;
    readonly source: string;
    readonly target: string;
    readonly action: string;
    readonly result: string;
    readonly correlationId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    readonly createdAt: string;
  },
): void {
  database
    .query(
      `INSERT INTO audit_log (
        audit_id, actor_type, actor_id, authority, source, target, action, result,
        correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      input.actorType,
      input.actorId,
      input.authority,
      input.source,
      input.target,
      input.action,
      input.result,
      input.correlationId,
      JSON.stringify(input.metadata),
      input.createdAt,
    );
}

export class AgentTagStore {
  readonly #database: Database;
  readonly #faultInjector: (point: StoreFaultPoint) => void;

  private constructor(database: Database, options: StoreOpenOptions) {
    this.#database = database;
    this.#faultInjector = options.faultInjector ?? (() => {});
  }

  static async open(path: string, options: StoreOpenOptions = {}): Promise<AgentTagStore> {
    if (!isAbsolute(path)) throw new Error("store path must be absolute");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const database = new Database(path, { create: true, strict: true });
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const applied = new Set(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations")
          .all()
          .map((row) => row.version),
      );
      for (const migration of STORE_MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        const apply = database.transaction(() => {
          database.exec(migration.sql);
          database
            .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
        });
        apply.immediate();
      }
      await chmod(path, 0o600);
      return new AgentTagStore(database, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  async backupTo(path: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error("backup path must be absolute");
    await requirePrivateDirectory(dirname(path));
    const temporaryPath = temporarySibling(path);
    try {
      this.#database.query("VACUUM INTO ?").run(temporaryPath);
      await installPrivateFile({ temporaryPath, destinationPath: path });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  static async restoreBackup(input: {
    readonly backupPath: string;
    readonly destinationPath: string;
  }): Promise<void> {
    if (!isAbsolute(input.backupPath)) throw new Error("backup path must be absolute");
    if (!isAbsolute(input.destinationPath)) throw new Error("destination path must be absolute");
    verifyDatabaseFile(input.backupPath);
    await requirePrivateDirectory(dirname(input.destinationPath));
    const temporaryPath = temporarySibling(input.destinationPath);
    try {
      await copyFile(input.backupPath, temporaryPath, constants.COPYFILE_EXCL);
      await installPrivateFile({ temporaryPath, destinationPath: input.destinationPath });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  listAuditRecords(input: { readonly after?: AuditCursor; readonly limit?: number } = {}): ReadonlyArray<AuditRecord> {
    const limit = input.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("audit export limit must be between 1 and 10000");
    }
    const afterCreatedAt = input.after === undefined
      ? "0000-01-01T00:00:00.000Z"
      : isoDateTime.parse(input.after.createdAt);
    const afterAuditId = input.after === undefined ? "" : requiredId(input.after.auditId, "auditId");
    return this.#database
      .query(
        `SELECT audit_id, actor_type, actor_id, authority, source, target, action, result,
                correlation_id, metadata_json, created_at
         FROM audit_log
         WHERE created_at > ? OR (created_at = ? AND audit_id > ?)
         ORDER BY created_at, audit_id LIMIT ?`,
      )
      .all(afterCreatedAt, afterCreatedAt, afterAuditId, limit)
      .map((raw) => {
        const row = auditRowSchema.parse(raw);
        return {
          auditId: row.audit_id,
          actorType: row.actor_type,
          actorId: row.actor_id,
          authority: row.authority,
          source: row.source,
          target: row.target,
          action: row.action,
          result: row.result,
          correlationId: row.correlation_id,
          metadata: auditMetadataSchema.parse(parseStoredJson(row.metadata_json)),
          createdAt: row.created_at,
        };
      });
  }

  createMemory(input: {
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
  }): MemoryRecord {
    const now = isoDateTime.parse(input.now);
    const expiresAt = isoDateTime.parse(input.expiresAt);
    const memoryId = crypto.randomUUID();
    const dimensions = {
      profileId: input.profileId === undefined ? null : requiredId(input.profileId, "profileId"),
      taskId: input.taskId === undefined ? null : requiredId(input.taskId, "taskId"),
      ownerUserId: input.ownerUserId === undefined ? null : requiredId(input.ownerUserId, "ownerUserId"),
    };
    const create = this.#database.transaction((): MemoryRecord => {
      this.#database
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
      writeAudit(this.#database, {
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
        this.#database
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

  getMemory(memoryId: string): MemoryRecord | null {
    const raw = this.#database
      .query(
        `SELECT memory_id, workspace_id, scope, profile_id, task_id, owner_user_id,
                content, source_type, source_id, version, expires_at, created_by, created_at, updated_at
         FROM memory_entries WHERE memory_id = ? AND state = 'active'`,
      )
      .get(requiredId(memoryId, "memoryId"));
    return raw === null ? null : projectMemoryRow(raw);
  }

  listMemory(input: {
    readonly workspaceId: string;
    readonly profileId: string;
    readonly taskId?: string;
    readonly ownerUserId: string;
    readonly includeShared: boolean;
    readonly includePrivate: boolean;
    readonly now: string;
    readonly limit?: number;
  }): ReadonlyArray<MemoryRecord> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("memory list limit must be between 1 and 100");
    }
    const taskId = input.taskId === undefined ? "" : requiredId(input.taskId, "taskId");
    return this.#database
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

  updateMemory(input: {
    readonly memoryId: string;
    readonly actorUserId: string;
    readonly content: string;
    readonly now: string;
  }): MemoryRecord {
    const now = isoDateTime.parse(input.now);
    const update = this.#database.transaction(() => {
      const result = this.#database
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
      writeAudit(this.#database, {
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
      const record = this.getMemory(input.memoryId);
      if (record === null) throw new Error("updated memory not found");
      return record;
    });
    return update.immediate();
  }

  forgetMemory(input: {
    readonly memoryId: string;
    readonly actorUserId: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const forget = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE memory_entries SET state = 'forgotten', forgotten_at = ?, updated_at = ?
           WHERE memory_id = ? AND state = 'active'`,
        )
        .run(now, now, requiredId(input.memoryId, "memoryId"));
      if (result.changes !== 1) throw new Error("active memory not found");
      writeAudit(this.#database, {
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

  expireMemory(nowInput: string): number {
    const now = isoDateTime.parse(nowInput);
    const expire = this.#database.transaction(() => {
      const rows = this.#database
        .query<{ memory_id: string }, [string]>(
          "SELECT memory_id FROM memory_entries WHERE state = 'active' AND expires_at <= ?",
        )
        .all(now);
      for (const row of rows) {
        const memoryId = requiredId(row.memory_id, "memoryId");
        this.#database
          .query(
            `UPDATE memory_entries SET state = 'forgotten', forgotten_at = ?, updated_at = ?
             WHERE memory_id = ? AND state = 'active'`,
          )
          .run(now, now, memoryId);
        writeAudit(this.#database, {
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

  taskBelongsToContext(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly profileId: string;
  }): boolean {
    const row = this.#database
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE task_id = ? AND workspace_id = ? AND profile_id = ? AND state = 'active'`,
      )
      .get(
        requiredId(input.taskId, "taskId"),
        requiredId(input.workspaceId, "workspaceId"),
        requiredId(input.profileId, "profileId"),
      );
    if (row === null) throw new Error("failed to check task memory context");
    return row.count === 1;
  }

  recordMemoryDenial(input: {
    readonly actorUserId: string;
    readonly sourceId: string;
    readonly reason: string;
    readonly workspaceId: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    writeAudit(this.#database, {
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

  resolveOperationTurnText(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly proposedText: string;
    readonly now: string;
  }): string {
    const now = isoDateTime.parse(input.now);
    const resolve = this.#database.transaction(() => {
      const operationId = requiredId(input.operationId, "operationId");
      const prior = resolvedOperationTextSchema.parse(
        this.#database
          .query(
            `SELECT resolved_text FROM operations
             WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
          )
          .get(operationId, requiredId(input.workerId, "workerId"), now),
      );
      if (prior.resolved_text !== null) return prior.resolved_text;
      const result = this.#database
        .query(
          `UPDATE operations SET resolved_text = ?, updated_at = ?
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ?
             AND lease_expires_at > ? AND resolved_text IS NULL`,
        )
        .run(input.proposedText, now, operationId, input.workerId, now);
      if (result.changes !== 1) throw new Error("operation turn text could not be resolved");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: operationId,
        target: operationId,
        action: "operation.turn-text.resolved",
        result: "immutable",
        correlationId: operationId,
        metadata: {},
        createdAt: now,
      });
      return input.proposedText;
    });
    return resolve.immediate();
  }

  countActiveSchedules(workspaceId: string): number {
    const row = this.#database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM schedules WHERE workspace_id = ? AND state = 'active'",
      )
      .get(requiredId(workspaceId, "workspaceId"));
    if (row === null) throw new Error("failed to count active schedules");
    return row.count;
  }

  createSchedule(input: {
    readonly taskId: string;
    readonly actorUserId: string;
    readonly kind: "agent" | "reminder";
    readonly prompt: string;
    readonly runAt: string;
    readonly cadenceSeconds?: number;
    readonly missedRunPolicy: "run-once" | "skip";
    readonly misfireGraceSeconds: number;
    readonly overlapPolicy: "skip" | "queue";
    readonly now: string;
  }): ScheduleSummary {
    const now = isoDateTime.parse(input.now);
    const runAt = isoDateTime.parse(input.runAt);
    if (
      input.cadenceSeconds !== undefined &&
      (!Number.isSafeInteger(input.cadenceSeconds) || input.cadenceSeconds < 60)
    ) {
      throw new Error("schedule cadence must be at least 60 seconds");
    }
    if (
      !Number.isSafeInteger(input.misfireGraceSeconds) ||
      input.misfireGraceSeconds < 0 ||
      input.misfireGraceSeconds > 86_400
    ) {
      throw new Error("schedule misfire grace must be between 0 and 86400 seconds");
    }
    const create = this.#database.transaction((): ScheduleSummary => {
      const taskId = requiredId(input.taskId, "taskId");
      const target = scheduleTargetSchema.parse(
        this.#database
          .query(
            `SELECT workspace_id, conversation_id, thread_ts, profile_id, repository_root
             FROM tasks WHERE task_id = ? AND state = 'active'`,
          )
          .get(taskId),
      );
      const scheduleId = crypto.randomUUID();
      this.#database
        .query(
          `INSERT INTO schedules (
            schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id,
            profile_id, repository_root, kind, prompt, cadence_seconds, missed_run_policy,
            misfire_grace_seconds, overlap_policy, state, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          scheduleId,
          taskId,
          target.workspace_id,
          target.conversation_id,
          target.thread_ts,
          requiredId(input.actorUserId, "actorUserId"),
          target.profile_id,
          target.repository_root,
          input.kind,
          schedulePrompt.parse(input.prompt),
          input.cadenceSeconds ?? null,
          input.missedRunPolicy,
          input.misfireGraceSeconds,
          input.overlapPolicy,
          runAt,
          now,
          now,
        );
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: input.actorUserId,
        authority: "schedule-create",
        source: taskId,
        target: scheduleId,
        action: "schedule.created",
        result: "active",
        correlationId: scheduleId,
        metadata: {
          kind: input.kind,
          recurring: input.cadenceSeconds !== undefined,
          missedRunPolicy: input.missedRunPolicy,
          overlapPolicy: input.overlapPolicy,
        },
        createdAt: now,
      });
      return {
        scheduleId,
        taskId,
        kind: input.kind,
        prompt: input.prompt.trim(),
        state: "active",
        nextRunAt: runAt,
        cadenceSeconds: input.cadenceSeconds ?? null,
        missedRunPolicy: input.missedRunPolicy,
        overlapPolicy: input.overlapPolicy,
      };
    });
    return create.immediate();
  }

  listSchedules(taskId: string): ReadonlyArray<ScheduleSummary> {
    const schema = z.object({
      schedule_id: nonEmpty,
      task_id: nonEmpty,
      kind: z.enum(["agent", "reminder"]),
      prompt: schedulePrompt,
      state: z.enum(["active", "cancelled", "completed"]),
      next_run_at: isoDateTime,
      cadence_seconds: z.number().int().min(60).nullable(),
      missed_run_policy: z.enum(["run-once", "skip"]),
      overlap_policy: z.enum(["skip", "queue"]),
    });
    return this.#database
      .query(
        `SELECT schedule_id, task_id, kind, prompt, state, next_run_at, cadence_seconds,
                missed_run_policy, overlap_policy
         FROM schedules WHERE task_id = ? ORDER BY created_at, schedule_id`,
      )
      .all(requiredId(taskId, "taskId"))
      .map((raw) => {
        const row = schema.parse(raw);
        return {
          scheduleId: row.schedule_id,
          taskId: row.task_id,
          kind: row.kind,
          prompt: row.prompt,
          state: row.state,
          nextRunAt: row.next_run_at,
          cadenceSeconds: row.cadence_seconds,
          missedRunPolicy: row.missed_run_policy,
          overlapPolicy: row.overlap_policy,
        };
      });
  }

  cancelSchedule(input: {
    readonly scheduleId: string;
    readonly taskId: string;
    readonly actorUserId: string;
    readonly now: string;
  }): boolean {
    const now = isoDateTime.parse(input.now);
    const cancel = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE schedules SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE schedule_id = ? AND task_id = ? AND state = 'active'`,
        )
        .run(
          now,
          requiredId(input.scheduleId, "scheduleId"),
          requiredId(input.taskId, "taskId"),
        );
      if (result.changes === 0) return false;
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: input.actorUserId,
        authority: "schedule-cancel",
        source: input.scheduleId,
        target: input.scheduleId,
        action: "schedule.cancelled",
        result: "cancelled",
        correlationId: input.scheduleId,
        metadata: {},
        createdAt: now,
      });
      return true;
    });
    return cancel.immediate();
  }

  claimDueSchedule(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): ClaimedSchedule | null {
    const now = isoDateTime.parse(input.now);
    const workerId = requiredId(input.workerId, "workerId");
    const expiresAt = leaseExpiry(now, input.leaseMs);
    const claim = this.#database.transaction(() => {
      const identity = z.object({ schedule_id: nonEmpty }).nullable().parse(
        this.#database
          .query(
            `SELECT schedule_id FROM schedules
             WHERE state = 'active' AND next_run_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY next_run_at, schedule_id LIMIT 1`,
          )
          .get(now, now),
      );
      if (identity === null) return null;
      const result = this.#database
        .query(
          `UPDATE schedules SET attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE schedule_id = ? AND state = 'active'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(workerId, expiresAt, now, identity.schedule_id, now);
      if (result.changes !== 1) return null;
      const row = scheduleRowSchema.parse(
        this.#database
          .query(
            `SELECT schedule_id, task_id, workspace_id, conversation_id, thread_ts, actor_user_id,
                    profile_id, repository_root, kind, prompt, cadence_seconds, missed_run_policy,
                    misfire_grace_seconds, overlap_policy, next_run_at, attempts, lease_expires_at
             FROM schedules WHERE schedule_id = ?`,
          )
          .get(identity.schedule_id),
      );
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: workerId,
        authority: "schedule-dispatch",
        source: row.schedule_id,
        target: row.task_id,
        action: "schedule.claimed",
        result: "inflight",
        correlationId: row.schedule_id,
        metadata: { attempt: row.attempts, dueAt: row.next_run_at },
        createdAt: now,
      });
      return {
        scheduleId: row.schedule_id,
        taskId: row.task_id,
        workspaceId: row.workspace_id,
        conversationId: row.conversation_id,
        threadTs: row.thread_ts,
        actorUserId: row.actor_user_id,
        profileId: row.profile_id,
        repositoryRoot: row.repository_root,
        kind: row.kind,
        prompt: row.prompt,
        cadenceSeconds: row.cadence_seconds,
        missedRunPolicy: row.missed_run_policy,
        misfireGraceSeconds: row.misfire_grace_seconds,
        overlapPolicy: row.overlap_policy,
        dueAt: row.next_run_at,
        attempt: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
    return claim.immediate();
  }

  hasOpenScheduleOperation(scheduleId: string): boolean {
    const row = this.#database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM schedule_runs r JOIN operations o ON o.operation_id = r.operation_id
         WHERE r.schedule_id = ? AND o.status IN ('pending', 'inflight')`,
      )
      .get(requiredId(scheduleId, "scheduleId"));
    if (row === null) throw new Error("failed to check schedule overlap");
    return row.count > 0;
  }

  settleScheduleRun(input: {
    readonly scheduleId: string;
    readonly workerId: string;
    readonly dueAt: string;
    readonly disposition: "dispatched" | "missed-skipped" | "overlap-skipped";
    readonly operationId?: string;
    readonly nextRunAt?: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const dueAt = isoDateTime.parse(input.dueAt);
    const nextRunAt = input.nextRunAt === undefined ? null : isoDateTime.parse(input.nextRunAt);
    const settle = this.#database.transaction(() => {
      this.#database
        .query(
          `INSERT INTO schedule_runs (run_id, schedule_id, due_at, disposition, operation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${input.scheduleId}:${dueAt}`,
          requiredId(input.scheduleId, "scheduleId"),
          dueAt,
          input.disposition,
          input.operationId ?? null,
          now,
        );
      const result = this.#database
        .query(
          `UPDATE schedules SET state = ?, next_run_at = COALESCE(?, next_run_at),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE schedule_id = ? AND state = 'active' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          nextRunAt === null ? "completed" : "active",
          nextRunAt,
          now,
          input.scheduleId,
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("schedule lease is missing, expired, or cancelled");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "schedule-dispatch",
        source: input.scheduleId,
        target: input.operationId ?? input.scheduleId,
        action: "schedule.run.settled",
        result: input.disposition,
        correlationId: input.scheduleId,
        metadata: { dueAt, recurring: nextRunAt !== null },
        createdAt: now,
      });
    });
    settle.immediate();
  }

  recordScheduleDenial(input: {
    readonly actorUserId: string;
    readonly sourceId: string;
    readonly reason: string;
    readonly workspaceId: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    writeAudit(this.#database, {
      actorType: "slack-user",
      actorId: requiredId(input.actorUserId, "actorUserId"),
      authority: "schedule-policy",
      source: requiredId(input.sourceId, "sourceId"),
      target: requiredId(input.workspaceId, "workspaceId"),
      action: "schedule.denied",
      result: requiredId(input.reason, "reason"),
      correlationId: input.sourceId,
      metadata: {},
      createdAt: now,
    });
  }

  evaluateAmbient(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly eventKey: string;
    readonly actorUserId: string;
    readonly text: string;
    readonly cooldownSeconds: number;
    readonly maxTurnsPerHour: number;
    readonly now: string;
  }): AmbientDecision {
    const now = isoDateTime.parse(input.now);
    if (!Number.isSafeInteger(input.cooldownSeconds) || input.cooldownSeconds < 60) {
      throw new Error("ambient cooldown must be at least 60 seconds");
    }
    if (!Number.isSafeInteger(input.maxTurnsPerHour) || input.maxTurnsPerHour <= 0) {
      throw new Error("ambient hourly limit must be positive");
    }
    const workspaceId = requiredId(input.workspaceId, "workspaceId");
    const conversationId = requiredId(input.conversationId, "conversationId");
    const eventKey = requiredId(input.eventKey, "eventKey");
    const normalized = input.text.trim().replaceAll(/\s+/g, " ").toLowerCase();
    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    const evaluate = this.#database.transaction((): AmbientDecision => {
      const prior = ambientDecisionSchema.nullable().parse(
        this.#database
          .query(
            "SELECT disposition, reason FROM ambient_decisions WHERE workspace_id = ? AND event_key = ?",
          )
          .get(workspaceId, eventKey),
      );
      if (prior !== null) {
        return prior.disposition === "triggered"
          ? { kind: "triggered" }
          : {
              kind: "quiet",
              reason: z.enum(["unchanged", "cooldown", "hourly-limit"]).parse(prior.reason),
            };
      }

      const last = z
        .object({ content_fingerprint: nonEmpty, created_at: isoDateTime })
        .nullable()
        .parse(
          this.#database
            .query(
              `SELECT content_fingerprint, created_at FROM ambient_decisions
               WHERE workspace_id = ? AND conversation_id = ? AND disposition = 'triggered'
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(workspaceId, conversationId),
        );
      const cutoff = new Date(new Date(now).getTime() - 3_600_000).toISOString();
      const count = this.#database
        .query<{ count: number }, [string, string, string]>(
          `SELECT COUNT(*) AS count FROM ambient_decisions
           WHERE workspace_id = ? AND conversation_id = ? AND disposition = 'triggered' AND created_at > ?`,
        )
        .get(workspaceId, conversationId, cutoff)?.count;
      if (count === undefined) throw new Error("failed to count ambient turns");

      let decision: AmbientDecision = { kind: "triggered" };
      if (last?.content_fingerprint === fingerprint) {
        decision = { kind: "quiet", reason: "unchanged" };
      } else if (
        last !== null &&
        new Date(now).getTime() < new Date(last.created_at).getTime() + input.cooldownSeconds * 1_000
      ) {
        decision = { kind: "quiet", reason: "cooldown" };
      } else if (count >= input.maxTurnsPerHour) {
        decision = { kind: "quiet", reason: "hourly-limit" };
      }
      const disposition = decision.kind === "triggered" ? "triggered" : "quiet";
      const reason = decision.kind === "triggered" ? "relevant" : decision.reason;
      this.#database
        .query(
          `INSERT INTO ambient_decisions (
            workspace_id, conversation_id, event_key, actor_user_id, content_fingerprint,
            disposition, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          conversationId,
          eventKey,
          requiredId(input.actorUserId, "actorUserId"),
          fingerprint,
          disposition,
          reason,
          now,
        );
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: input.actorUserId,
        authority: "ambient-policy",
        source: eventKey,
        target: conversationId,
        action: "ambient.decided",
        result: disposition,
        correlationId: eventKey,
        metadata: { reason },
        createdAt: now,
      });
      return decision;
    });
    return evaluate.immediate();
  }

  ingestSlackEvent(input: SlackEventInput): IngestReceipt {
    const event = {
      deliveryId: requiredId(input.deliveryId, "deliveryId"),
      eventKey: requiredId(input.eventKey, "eventKey"),
      workspaceId: requiredId(input.workspaceId, "workspaceId"),
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      actorUserId: requiredId(input.actorUserId, "actorUserId"),
      profileId: requiredId(input.profileId, "profileId"),
      repositoryRoot: requiredId(input.repositoryRoot, "repositoryRoot"),
      text: input.text,
      receivedAt: isoDateTime.parse(input.receivedAt),
      sourceOrderKey: requiredId(input.sourceOrderKey ?? input.receivedAt, "sourceOrderKey"),
    };
    const ingest = this.#database.transaction((): IngestReceipt => {
      const priorDelivery = deliveryLookupSchema.nullable().parse(
        this.#database
          .query("SELECT canonical_operation_id FROM slack_deliveries WHERE delivery_id = ?")
          .get(event.deliveryId),
      );
      if (priorDelivery !== null) {
        return this.#receipt("duplicate", event.deliveryId, priorDelivery.canonical_operation_id);
      }

      const canonical = canonicalEventSchema.nullable().parse(
        this.#database
          .query("SELECT operation_id FROM slack_events WHERE workspace_id = ? AND event_key = ?")
          .get(event.workspaceId, event.eventKey),
      );
      if (canonical !== null) {
        this.#insertDelivery(event, canonical.operation_id, "duplicate");
        writeAudit(this.#database, {
          actorType: "slack-user",
          actorId: event.actorUserId,
          authority: event.profileId,
          source: event.deliveryId,
          target: canonical.operation_id,
          action: "slack.delivery.duplicate",
          result: "ignored",
          correlationId: canonical.operation_id,
          metadata: { eventKey: event.eventKey },
          createdAt: event.receivedAt,
        });
        return this.#receipt("duplicate", event.deliveryId, canonical.operation_id);
      }

      const taskId = this.#findOrCreateTask(event);
      const operationId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const payload = operationPayloadSchema.parse({
        text: event.text,
        actorUserId: event.actorUserId,
        conversationId: event.conversationId,
        threadTs: event.threadTs,
        profileId: event.profileId,
        repositoryRoot: event.repositoryRoot,
      });
      this.#database
        .query(
          `INSERT INTO operations (
            operation_id, task_id, source_delivery_id, source_event_key, kind, command_id,
            message_id, payload_json, status, source_order_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'user-turn', ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          operationId,
          taskId,
          event.deliveryId,
          event.eventKey,
          commandId,
          messageId,
          JSON.stringify(payload),
          event.sourceOrderKey,
          event.receivedAt,
          event.receivedAt,
        );
      this.#faultInjector("ingest.after-operation");
      this.#database
        .query(
          `INSERT INTO slack_events (
            workspace_id, event_key, canonical_delivery_id, operation_id, conversation_id,
            thread_ts, actor_user_id, text, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.workspaceId,
          event.eventKey,
          event.deliveryId,
          operationId,
          event.conversationId,
          event.threadTs,
          event.actorUserId,
          event.text,
          event.receivedAt,
        );
      this.#insertDelivery(event, operationId, "accepted");
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: event.actorUserId,
        authority: event.profileId,
        source: event.deliveryId,
        target: taskId,
        action: "slack.event.ingested",
        result: "accepted",
        correlationId: operationId,
        metadata: { eventKey: event.eventKey, operationKind: "user-turn" },
        createdAt: event.receivedAt,
      });
      return { kind: "accepted", deliveryId: event.deliveryId, operationId, taskId, commandId, messageId };
    });
    return ingest.immediate();
  }

  claimNextOperation(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
    readonly maxConcurrentTasks: number;
  }): ClaimedOperation | null {
    const workerId = requiredId(input.workerId, "workerId");
    const now = isoDateTime.parse(input.now);
    if (!Number.isSafeInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks <= 0) {
      throw new Error("maxConcurrentTasks must be positive");
    }
    const expiresAt = leaseExpiry(now, input.leaseMs);
    const claim = this.#database.transaction((): ClaimedOperation | null => {
      const active = this.#database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(DISTINCT task_id) AS count FROM operations WHERE status = 'inflight' AND lease_expires_at > ?",
        )
        .get(now)?.count;
      if (active === undefined) throw new Error("failed to count active operation leases");
      if (active >= input.maxConcurrentTasks) return null;

      const identity = operationIdentitySchema.nullable().parse(
        this.#database
          .query(
            `SELECT o.operation_id, o.task_id, o.command_id, o.message_id
             FROM operations o
             WHERE ((o.status = 'pending' AND (o.blocked_until IS NULL OR o.blocked_until <= ?))
                OR (o.status = 'inflight' AND o.lease_expires_at <= ?))
               AND NOT EXISTS (
                 SELECT 1 FROM operations earlier
                 WHERE earlier.task_id = o.task_id
                   AND earlier.status IN ('pending', 'inflight')
                   AND (earlier.source_order_key < o.source_order_key OR
                     (earlier.source_order_key = o.source_order_key AND earlier.operation_id < o.operation_id))
               )
             ORDER BY o.source_order_key, o.operation_id
             LIMIT 1`,
          )
          .get(now, now),
      );
      if (identity === null) return null;
      const updated = this.#database
        .query(
          `UPDATE operations
           SET status = 'inflight', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE operation_id = ? AND ((status = 'pending' AND (blocked_until IS NULL OR blocked_until <= ?))
             OR (status = 'inflight' AND lease_expires_at <= ?))`,
        )
        .run(workerId, expiresAt, now, identity.operation_id, now, now);
      if (updated.changes !== 1) return null;
      this.#faultInjector("operation-claim.after-update");
      const row = operationRowSchema.parse(
        this.#database
          .query(
            `SELECT operation_id, task_id, command_id, message_id, payload_json,
                    attempts, lease_expires_at
             FROM operations WHERE operation_id = ?`,
          )
          .get(identity.operation_id),
      );
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: workerId,
        authority: "operation-dispatch",
        source: row.operation_id,
        target: row.task_id,
        action: "operation.claimed",
        result: "inflight",
        correlationId: row.operation_id,
        metadata: { attempt: row.attempts },
        createdAt: now,
      });
      return {
        operationId: row.operation_id,
        taskId: row.task_id,
        commandId: row.command_id,
        messageId: row.message_id,
        payload: operationPayloadSchema.parse(parseStoredJson(row.payload_json)),
        attempt: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
    return claim.immediate();
  }

  completeOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly resultSequence: number;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    if (!Number.isSafeInteger(input.resultSequence) || input.resultSequence < 0) {
      throw new Error("resultSequence must be a non-negative integer");
    }
    const complete = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE operations SET status = 'succeeded', result_sequence = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          input.resultSequence,
          now,
          requiredId(input.operationId, "operationId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: input.operationId,
        target: input.operationId,
        action: "operation.completed",
        result: "succeeded",
        correlationId: input.operationId,
        metadata: { resultSequence: input.resultSequence },
        createdAt: now,
      });
    });
    complete.immediate();
  }

  completeOperationWithOutbox(input: {
    readonly operationId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly resultSequence: number;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly text: string;
    readonly now: string;
  }): string {
    const now = isoDateTime.parse(input.now);
    if (!Number.isSafeInteger(input.resultSequence) || input.resultSequence < 0) {
      throw new Error("resultSequence must be a non-negative integer");
    }
    const complete = this.#database.transaction(() => {
      const operationId = requiredId(input.operationId, "operationId");
      const taskId = requiredId(input.taskId, "taskId");
      const result = this.#database
        .query(
          `UPDATE operations SET status = 'succeeded', result_sequence = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND task_id = ? AND status = 'inflight'
             AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          input.resultSequence,
          now,
          operationId,
          taskId,
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");

      const clientMessageId = `${operationId}:final`;
      const prior = outboxIdentitySchema.nullable().parse(
        this.#database
          .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
          .get(clientMessageId),
      );
      const outboxId = prior?.outbox_id ?? crypto.randomUUID();
      if (prior === null) {
        this.#database
          .query(
            `INSERT INTO slack_outbox (
              outbox_id, task_id, correlation_id, conversation_id, thread_ts,
              client_message_id, payload_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            outboxId,
            taskId,
            operationId,
            requiredId(input.conversationId, "conversationId"),
            requiredId(input.threadTs, "threadTs"),
            clientMessageId,
            JSON.stringify(outboxPayloadSchema.parse({ text: input.text })),
            now,
            now,
          );
      }
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: operationId,
        target: taskId,
        action: "operation.completed",
        result: "succeeded",
        correlationId: operationId,
        metadata: { resultSequence: input.resultSequence },
        createdAt: now,
      });
      writeAudit(this.#database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "slack-write",
        source: operationId,
        target: outboxId,
        action: "slack.outbox.enqueued",
        result: "pending",
        correlationId: operationId,
        metadata: { clientMessageId },
        createdAt: now,
      });
      return outboxId;
    });
    return complete.immediate();
  }

  cancelOperationWithOutbox(input: {
    readonly operationId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly now: string;
  }): string {
    const now = isoDateTime.parse(input.now);
    const cancel = this.#database.transaction(() => {
      const operationId = requiredId(input.operationId, "operationId");
      const taskId = requiredId(input.taskId, "taskId");
      const result = this.#database
        .query(
          `UPDATE operations SET status = 'failed', last_error_code = 'user-cancelled',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND task_id = ? AND status = 'inflight'
             AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          now,
          operationId,
          taskId,
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");
      const clientMessageId = `${operationId}:cancelled`;
      const outboxId = crypto.randomUUID();
      this.#database
        .query(
          `INSERT INTO slack_outbox (
            outbox_id, task_id, correlation_id, conversation_id, thread_ts,
            client_message_id, payload_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          outboxId,
          taskId,
          operationId,
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          clientMessageId,
          JSON.stringify(outboxPayloadSchema.parse({ text: "Cancelled." })),
          now,
          now,
        );
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: operationId,
        target: taskId,
        action: "operation.cancelled",
        result: "failed",
        correlationId: operationId,
        metadata: { errorCode: "user-cancelled" },
        createdAt: now,
      });
      return outboxId;
    });
    return cancel.immediate();
  }

  renewOperationLease(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): string {
    const now = isoDateTime.parse(input.now);
    const expiresAt = leaseExpiry(now, input.leaseMs);
    const result = this.#database
      .query(
        `UPDATE operations SET lease_expires_at = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(
        expiresAt,
        now,
        requiredId(input.operationId, "operationId"),
        requiredId(input.workerId, "workerId"),
        now,
      );
    if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");
    return expiresAt;
  }

  deferOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly blockedUntil: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const blockedUntil = isoDateTime.parse(input.blockedUntil);
    const defer = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE operations SET status = 'pending', blocked_until = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          blockedUntil,
          now,
          requiredId(input.operationId, "operationId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: input.operationId,
        target: input.operationId,
        action: "operation.deferred",
        result: "pending-interaction",
        correlationId: input.operationId,
        metadata: { blockedUntil },
        createdAt: now,
      });
    });
    defer.immediate();
  }

  failOperation(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const status = input.retryable ? "pending" : "failed";
    const fail = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE operations SET status = ?, last_error_code = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          status,
          requiredId(input.errorCode, "errorCode"),
          now,
          requiredId(input.operationId, "operationId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("operation lease is missing, expired, or owned by another worker");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "operation-dispatch",
        source: input.operationId,
        target: input.operationId,
        action: "operation.failed",
        result: status,
        correlationId: input.operationId,
        metadata: { errorCode: input.errorCode, retryable: input.retryable },
        createdAt: now,
      });
    });
    fail.immediate();
  }

  bindT3Task(input: {
    readonly taskId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const bind = this.#database.transaction(() => {
      const result = this.#database
        .query(
          "UPDATE tasks SET t3_project_id = ?, t3_thread_id = ?, updated_at = ? WHERE task_id = ? AND state = 'active'",
        )
        .run(
          requiredId(input.projectId, "projectId"),
          requiredId(input.threadId, "threadId"),
          now,
          requiredId(input.taskId, "taskId"),
        );
      if (result.changes !== 1) throw new Error("active task not found");
      writeAudit(this.#database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "t3-orchestration",
        source: input.taskId,
        target: input.threadId,
        action: "task.t3-bound",
        result: "active",
        correlationId: input.taskId,
        metadata: { projectId: input.projectId },
        createdAt: now,
      });
    });
    bind.immediate();
  }

  findActiveTask(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly threadTs: string;
  }): ActiveTaskBinding | null {
    const schema = z.object({
      task_id: nonEmpty,
      profile_id: nonEmpty,
      repository_root: nonEmpty,
    });
    const row = schema.nullable().parse(
      this.#database
        .query(
          `SELECT task_id, profile_id, repository_root FROM tasks
           WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ? AND state = 'active'`,
        )
        .get(
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
        ),
    );
    if (row === null) return null;
    return { taskId: row.task_id, profileId: row.profile_id, repositoryRoot: row.repository_root };
  }

  getTaskExecution(taskIdInput: string): TaskExecutionBinding {
    const row = taskExecutionSchema.parse(
      this.#database
        .query(
          `SELECT task_id, profile_id, repository_root, t3_project_id, t3_thread_id,
                  t3_thread_started_at, created_at
           FROM tasks WHERE task_id = ? AND state = 'active'`,
        )
        .get(requiredId(taskIdInput, "taskId")),
    );
    return {
      taskId: row.task_id,
      profileId: row.profile_id,
      repositoryRoot: row.repository_root,
      projectId: row.t3_project_id,
      threadId: row.t3_thread_id,
      threadStarted: row.t3_thread_started_at !== null,
      createdAt: row.created_at,
    };
  }

  markT3ThreadStarted(input: { readonly taskId: string; readonly now: string }): void {
    const now = isoDateTime.parse(input.now);
    const result = this.#database
      .query(
        `UPDATE tasks SET t3_thread_started_at = COALESCE(t3_thread_started_at, ?), updated_at = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(now, now, requiredId(input.taskId, "taskId"));
    if (result.changes !== 1) throw new Error("active task not found");
  }

  recordPendingInteraction(input: {
    readonly taskId: string;
    readonly operationId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly kind: "approval" | "user-input";
    readonly prompt: unknown;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly message: (interactionId: string) => SlackOutboxPayload;
    readonly now: string;
  }): { readonly kind: "accepted" | "duplicate"; readonly interactionId: string; readonly outboxId: string } {
    const now = isoDateTime.parse(input.now);
    const record = this.#database.transaction(() => {
      const prior = interactionIdentitySchema.nullable().parse(
        this.#database
          .query(
            "SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = ?",
          )
          .get(
            requiredId(input.threadId, "threadId"),
            requiredId(input.requestId, "requestId"),
            input.kind,
          ),
      );
      if (prior !== null) {
        const outbox = outboxIdentitySchema.parse(
          this.#database
            .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
            .get(`${prior.interaction_id}:prompt`),
        );
        return { kind: "duplicate" as const, interactionId: prior.interaction_id, outboxId: outbox.outbox_id };
      }

      const interactionId = crypto.randomUUID();
      const responseCommandId = crypto.randomUUID();
      const outboxId = crypto.randomUUID();
      const message = outboxPayloadSchema.parse(input.message(interactionId));
      this.#database
        .query(
          `INSERT INTO interactions (
            interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
            state, response_command_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          interactionId,
          requiredId(input.taskId, "taskId"),
          requiredId(input.operationId, "operationId"),
          input.threadId,
          input.requestId,
          input.kind,
          JSON.stringify(input.prompt),
          responseCommandId,
          now,
          now,
        );
      this.#database
        .query(
          `INSERT INTO slack_outbox (
            outbox_id, task_id, correlation_id, conversation_id, thread_ts,
            client_message_id, payload_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          outboxId,
          input.taskId,
          interactionId,
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          `${interactionId}:prompt`,
          JSON.stringify(message),
          now,
          now,
        );
      writeAudit(this.#database, {
        actorType: "provider",
        actorId: "t3",
        authority: "interaction-request",
        source: input.requestId,
        target: interactionId,
        action: `interaction.${input.kind}.requested`,
        result: "pending",
        correlationId: input.operationId,
        metadata: {},
        createdAt: now,
      });
      return { kind: "accepted" as const, interactionId, outboxId };
    });
    return record.immediate();
  }

  submitInteractionResponse(input: {
    readonly interactionId: string;
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly actorUserId: string;
    readonly sourceActionId: string;
    readonly response: unknown;
    readonly now: string;
  }):
    | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
    | { readonly kind: "denied" } {
    const now = isoDateTime.parse(input.now);
    const submit = this.#database.transaction(() => {
      const rowSchema = z.object({
        interaction_id: nonEmpty,
        response_command_id: nonEmpty,
        source_action_id: nonEmpty.nullable(),
        state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
      });
      const row = rowSchema.nullable().parse(
        this.#database
          .query(
            `SELECT i.interaction_id, i.response_command_id, i.source_action_id, i.state
             FROM interactions i JOIN tasks t ON t.task_id = i.task_id
             WHERE i.interaction_id = ? AND t.workspace_id = ? AND t.conversation_id = ?
               AND t.thread_ts = ? AND t.state = 'active'`,
          )
          .get(
            requiredId(input.interactionId, "interactionId"),
            requiredId(input.workspaceId, "workspaceId"),
            requiredId(input.conversationId, "conversationId"),
            requiredId(input.threadTs, "threadTs"),
          ),
      );
      if (row === null) return { kind: "denied" as const };
      if (row.source_action_id === input.sourceActionId || row.state !== "pending") {
        return { kind: "duplicate" as const, commandId: row.response_command_id };
      }
      const updated = this.#database
        .query(
          `UPDATE interactions SET state = 'response-pending', response_json = ?,
             response_actor_id = ?, source_action_id = ?, updated_at = ?
           WHERE interaction_id = ? AND state = 'pending'`,
        )
        .run(
          JSON.stringify(input.response),
          requiredId(input.actorUserId, "actorUserId"),
          requiredId(input.sourceActionId, "sourceActionId"),
          now,
          row.interaction_id,
        );
      if (updated.changes !== 1) {
        return { kind: "duplicate" as const, commandId: row.response_command_id };
      }
      this.#database
        .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
        .run(now, row.interaction_id);
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: input.actorUserId,
        authority: "interaction-response",
        source: input.sourceActionId,
        target: row.interaction_id,
        action: "interaction.response.submitted",
        result: "response-pending",
        correlationId: row.interaction_id,
        metadata: {},
        createdAt: now,
      });
      return { kind: "accepted" as const, commandId: row.response_command_id };
    });
    return submit.immediate();
  }

  requestTaskCancellation(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly actorUserId: string;
    readonly sourceActionId: string;
    readonly now: string;
  }):
    | { readonly kind: "accepted" | "duplicate"; readonly interactionId: string; readonly commandId: string }
    | { readonly kind: "denied" } {
    const now = isoDateTime.parse(input.now);
    const request = this.#database.transaction(() => {
      const targetSchema = z.object({ operation_id: nonEmpty, thread_id: nonEmpty });
      const target = targetSchema.nullable().parse(
        this.#database
          .query(
            `SELECT o.operation_id, t.t3_thread_id AS thread_id
             FROM tasks t JOIN operations o ON o.task_id = t.task_id
             WHERE t.task_id = ? AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ?
               AND t.state = 'active' AND o.status IN ('pending', 'inflight')
             ORDER BY CASE o.status WHEN 'inflight' THEN 0 ELSE 1 END, o.source_order_key, o.operation_id
             LIMIT 1`,
          )
          .get(
            requiredId(input.taskId, "taskId"),
            requiredId(input.workspaceId, "workspaceId"),
            requiredId(input.conversationId, "conversationId"),
            requiredId(input.threadTs, "threadTs"),
          ),
      );
      if (target === null) return { kind: "denied" as const };
      const requestId = `cancel:${target.operation_id}`;
      const prior = interactionIdentitySchema.nullable().parse(
        this.#database
          .query("SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'")
          .get(target.thread_id, requestId),
      );
      if (prior !== null) {
        const command = z.object({ response_command_id: nonEmpty }).parse(
          this.#database
            .query("SELECT response_command_id FROM interactions WHERE interaction_id = ?")
            .get(prior.interaction_id),
        );
        return { kind: "duplicate" as const, interactionId: prior.interaction_id, commandId: command.response_command_id };
      }
      const interactionId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      this.#database
        .query(
          `INSERT INTO interactions (
            interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
            state, response_command_id, response_json, response_actor_id, source_action_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'cancel', '{}', 'response-pending', ?, '{}', ?, ?, ?, ?)`,
        )
        .run(
          interactionId,
          input.taskId,
          target.operation_id,
          target.thread_id,
          requestId,
          commandId,
          requiredId(input.actorUserId, "actorUserId"),
          requiredId(input.sourceActionId, "sourceActionId"),
          now,
          now,
        );
      writeAudit(this.#database, {
        actorType: "slack-user",
        actorId: input.actorUserId,
        authority: "task-cancel",
        source: input.sourceActionId,
        target: target.operation_id,
        action: "task.cancellation.requested",
        result: "response-pending",
        correlationId: target.operation_id,
        metadata: {},
        createdAt: now,
      });
      return { kind: "accepted" as const, interactionId, commandId };
    });
    return request.immediate();
  }

  claimNextInteractionResponse(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): ClaimedInteractionResponse | null {
    const workerId = requiredId(input.workerId, "workerId");
    const now = isoDateTime.parse(input.now);
    const expiresAt = leaseExpiry(now, input.leaseMs);
    const claim = this.#database.transaction((): ClaimedInteractionResponse | null => {
      const candidate = interactionIdentitySchema.nullable().parse(
        this.#database
          .query(
            `SELECT interaction_id FROM interactions
             WHERE state = 'response-pending' OR (state = 'inflight' AND lease_expires_at <= ?)
             ORDER BY created_at, interaction_id LIMIT 1`,
          )
          .get(now),
      );
      if (candidate === null) return null;
      const updated = this.#database
        .query(
          `UPDATE interactions SET state = 'inflight', attempts = attempts + 1,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE interaction_id = ? AND (state = 'response-pending' OR (state = 'inflight' AND lease_expires_at <= ?))`,
        )
        .run(workerId, expiresAt, now, candidate.interaction_id, now);
      if (updated.changes !== 1) return null;
      const row = interactionRowSchema.parse(
        this.#database
          .query(
            `SELECT interaction_id, task_id, operation_id, thread_id, request_id, kind,
                    response_command_id, response_json, response_actor_id, attempts, lease_expires_at
             FROM interactions WHERE interaction_id = ?`,
          )
          .get(candidate.interaction_id),
      );
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: workerId,
        authority: "interaction-response",
        source: row.interaction_id,
        target: row.thread_id,
        action: "interaction.response.claimed",
        result: "inflight",
        correlationId: row.operation_id,
        metadata: { attempt: row.attempts },
        createdAt: now,
      });
      return {
        interactionId: row.interaction_id,
        taskId: row.task_id,
        operationId: row.operation_id,
        threadId: row.thread_id,
        requestId: row.request_id,
        kind: row.kind,
        commandId: row.response_command_id,
        actorUserId: row.response_actor_id,
        response: parseStoredJson(row.response_json),
        attempt: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
    return claim.immediate();
  }

  completeInteractionResponse(input: {
    readonly interactionId: string;
    readonly workerId: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const complete = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE interactions SET state = 'resolved', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE interaction_id = ? AND state = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          now,
          requiredId(input.interactionId, "interactionId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("interaction lease is missing, expired, or owned by another worker");
      this.#database
        .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
        .run(now, input.interactionId);
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "interaction-response",
        source: input.interactionId,
        target: input.interactionId,
        action: "interaction.response.completed",
        result: "resolved",
        correlationId: input.interactionId,
        metadata: {},
        createdAt: now,
      });
    });
    complete.immediate();
  }

  failInteractionResponse(input: {
    readonly interactionId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const state = input.retryable ? "response-pending" : "failed";
    const fail = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE interactions SET state = ?, last_error_code = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE interaction_id = ? AND state = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          state,
          requiredId(input.errorCode, "errorCode"),
          now,
          requiredId(input.interactionId, "interactionId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) throw new Error("interaction lease is missing, expired, or owned by another worker");
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "interaction-response",
        source: input.interactionId,
        target: input.interactionId,
        action: "interaction.response.failed",
        result: state,
        correlationId: input.interactionId,
        metadata: { errorCode: input.errorCode, retryable: input.retryable },
        createdAt: now,
      });
    });
    fail.immediate();
  }

  enqueueOutbox(input: SlackOutboxInput): { readonly kind: "accepted" | "duplicate"; readonly outboxId: string } {
    const payload = outboxPayloadSchema.parse(input.payload);
    const createdAt = isoDateTime.parse(input.createdAt);
    const enqueue = this.#database.transaction(() => {
      const prior = outboxIdentitySchema.nullable().parse(
        this.#database
          .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
          .get(requiredId(input.clientMessageId, "clientMessageId")),
      );
      if (prior !== null) return { kind: "duplicate" as const, outboxId: prior.outbox_id };
      const outboxId = crypto.randomUUID();
      this.#database
        .query(
          `INSERT INTO slack_outbox (
            outbox_id, task_id, correlation_id, conversation_id, thread_ts,
            client_message_id, payload_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          outboxId,
          requiredId(input.taskId, "taskId"),
          requiredId(input.correlationId, "correlationId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          input.clientMessageId,
          JSON.stringify(payload),
          createdAt,
          createdAt,
        );
      this.#faultInjector("outbox-enqueue.after-insert");
      writeAudit(this.#database, {
        actorType: "service",
        actorId: "agent-tag",
        authority: "slack-write",
        source: input.correlationId,
        target: outboxId,
        action: "slack.outbox.enqueued",
        result: "pending",
        correlationId: input.correlationId,
        metadata: { clientMessageId: input.clientMessageId },
        createdAt,
      });
      return { kind: "accepted" as const, outboxId };
    });
    return enqueue.immediate();
  }

  claimNextOutbox(input: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
  }): ClaimedOutboxMessage | null {
    const workerId = requiredId(input.workerId, "workerId");
    const now = isoDateTime.parse(input.now);
    const expiresAt = leaseExpiry(now, input.leaseMs);
    const claim = this.#database.transaction((): ClaimedOutboxMessage | null => {
      const candidate = outboxIdentitySchema.nullable().parse(
        this.#database
          .query(
            `SELECT outbox_id FROM slack_outbox
             WHERE status = 'pending'
             ORDER BY created_at, correlation_id,
               CASE WHEN client_message_id LIKE '%:started' THEN 0 ELSE 1 END,
               outbox_id
             LIMIT 1`,
          )
          .get(),
      );
      if (candidate === null) return null;
      const updated = this.#database
        .query(
          `UPDATE slack_outbox SET status = 'inflight', attempts = attempts + 1,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE outbox_id = ? AND (status = 'pending' OR (status = 'inflight' AND lease_expires_at <= ?))`,
        )
        .run(workerId, expiresAt, now, candidate.outbox_id, now);
      if (updated.changes !== 1) return null;
      this.#faultInjector("outbox-claim.after-update");
      const row = outboxRowSchema.parse(
        this.#database
          .query(
            `SELECT outbox_id, task_id, correlation_id, conversation_id, thread_ts,
                    client_message_id, payload_json, attempts, lease_expires_at
             FROM slack_outbox WHERE outbox_id = ?`,
          )
          .get(candidate.outbox_id),
      );
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: workerId,
        authority: "slack-write",
        source: row.outbox_id,
        target: row.conversation_id,
        action: "slack.outbox.claimed",
        result: "inflight",
        correlationId: row.correlation_id,
        metadata: { attempt: row.attempts },
        createdAt: now,
      });
      return {
        outboxId: row.outbox_id,
        taskId: row.task_id,
        correlationId: row.correlation_id,
        conversationId: row.conversation_id,
        threadTs: row.thread_ts,
        clientMessageId: row.client_message_id,
        payload: outboxPayloadSchema.parse(parseStoredJson(row.payload_json)),
        attempt: row.attempts,
        leaseExpiresAt: row.lease_expires_at,
      };
    });
    return claim.immediate();
  }

  markOutboxDelivered(input: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly slackMessageTs: string;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const deliver = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE slack_outbox SET status = 'delivered', slack_message_ts = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE outbox_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          requiredId(input.slackMessageTs, "slackMessageTs"),
          now,
          requiredId(input.outboxId, "outboxId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) {
        throw new Error("outbox lease is missing, expired, or owned by another worker");
      }
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "slack-write",
        source: input.outboxId,
        target: input.slackMessageTs,
        action: "slack.outbox.delivered",
        result: "delivered",
        correlationId: input.outboxId,
        metadata: {},
        createdAt: now,
      });
    });
    deliver.immediate();
  }

  failOutbox(input: {
    readonly outboxId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryable: boolean;
    readonly now: string;
  }): void {
    const now = isoDateTime.parse(input.now);
    const status = input.retryable ? "pending" : "failed";
    const fail = this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE slack_outbox SET status = ?, last_error_code = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
           WHERE outbox_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(
          status,
          requiredId(input.errorCode, "errorCode"),
          now,
          requiredId(input.outboxId, "outboxId"),
          requiredId(input.workerId, "workerId"),
          now,
        );
      if (result.changes !== 1) {
        throw new Error("outbox lease is missing, expired, or owned by another worker");
      }
      writeAudit(this.#database, {
        actorType: "worker",
        actorId: input.workerId,
        authority: "slack-write",
        source: input.outboxId,
        target: input.outboxId,
        action: "slack.outbox.failed",
        result: status,
        correlationId: input.outboxId,
        metadata: { errorCode: input.errorCode, retryable: input.retryable },
        createdAt: now,
      });
    });
    fail.immediate();
  }

  quarantineExpiredOutbox(nowInput: string): number {
    const now = isoDateTime.parse(nowInput);
    const quarantine = this.#database.transaction(() => {
      const expired = this.#database
        .query<{ outbox_id: string; correlation_id: string }, [string]>(
          `SELECT outbox_id, correlation_id FROM slack_outbox
           WHERE status = 'inflight' AND lease_expires_at <= ?`,
        )
        .all(now);
      for (const row of expired) {
        const outboxId = requiredId(row.outbox_id, "outboxId");
        const correlationId = requiredId(row.correlation_id, "correlationId");
        this.#database
          .query(
            `UPDATE slack_outbox SET status = 'failed', last_error_code = 'delivery-outcome-unknown',
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE outbox_id = ? AND status = 'inflight'`,
          )
          .run(now, outboxId);
        writeAudit(this.#database, {
          actorType: "service",
          actorId: "agent-tag",
          authority: "slack-write",
          source: outboxId,
          target: outboxId,
          action: "slack.outbox.quarantined",
          result: "delivery-outcome-unknown",
          correlationId,
          metadata: {},
          createdAt: now,
        });
      }
      return expired.length;
    });
    return quarantine.immediate();
  }

  diagnostics(): {
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
  } {
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
      const value = this.#database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
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

  #findOrCreateTask(event: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly profileId: string;
    readonly repositoryRoot: string;
    readonly receivedAt: string;
  }): string {
    const existing = taskLookupSchema.nullable().parse(
      this.#database
        .query(
          `SELECT task_id, t3_project_id, t3_thread_id FROM tasks
           WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ?`,
        )
        .get(event.workspaceId, event.conversationId, event.threadTs),
    );
    if (existing !== null) {
      if (existing.t3_project_id === null || existing.t3_thread_id === null) {
        this.#database
          .query(
            `UPDATE tasks SET t3_project_id = COALESCE(t3_project_id, ?),
               t3_thread_id = COALESCE(t3_thread_id, ?), updated_at = ? WHERE task_id = ?`,
          )
          .run(
            `agent-tag-project-${crypto.randomUUID()}`,
            `agent-tag-thread-${crypto.randomUUID()}`,
            event.receivedAt,
            existing.task_id,
          );
      }
      return existing.task_id;
    }
    const taskId = crypto.randomUUID();
    const projectId = `agent-tag-project-${crypto.randomUUID()}`;
    const threadId = `agent-tag-thread-${crypto.randomUUID()}`;
    this.#database
      .query(
        `INSERT INTO tasks (
          task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
          t3_project_id, t3_thread_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        taskId,
        event.workspaceId,
        event.conversationId,
        event.threadTs,
        event.profileId,
        event.repositoryRoot,
        projectId,
        threadId,
        event.receivedAt,
        event.receivedAt,
      );
    return taskId;
  }

  #insertDelivery(
    event: {
      readonly deliveryId: string;
      readonly workspaceId: string;
      readonly eventKey: string;
      readonly receivedAt: string;
    },
    operationId: string,
    disposition: "accepted" | "duplicate",
  ): void {
    this.#database
      .query(
        `INSERT INTO slack_deliveries (
          delivery_id, workspace_id, event_key, canonical_operation_id, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.deliveryId,
        event.workspaceId,
        event.eventKey,
        operationId,
        disposition,
        event.receivedAt,
      );
  }

  #receipt(kind: IngestReceipt["kind"], deliveryId: string, operationId: string): IngestReceipt {
    const identity = operationIdentitySchema.parse(
      this.#database
        .query("SELECT operation_id, task_id, command_id, message_id FROM operations WHERE operation_id = ?")
        .get(operationId),
    );
    return {
      kind,
      deliveryId,
      operationId: identity.operation_id,
      taskId: identity.task_id,
      commandId: identity.command_id,
      messageId: identity.message_id,
    };
  }
}
