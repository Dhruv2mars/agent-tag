import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

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
const outboxPayloadSchema = z.object({
  text: z.string(),
  blocks: z.array(z.unknown()).optional(),
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

const taskLookupSchema = z.object({ task_id: nonEmpty });
const outboxIdentitySchema = z.object({ outbox_id: nonEmpty });

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

export interface ClaimedOutboxMessage {
  readonly outboxId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: z.infer<typeof outboxPayloadSchema>;
  readonly attempt: number;
  readonly leaseExpiresAt: string;
}

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
            message_id, payload_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'user-turn', ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          operationId,
          taskId,
          event.deliveryId,
          event.eventKey,
          commandId,
          messageId,
          JSON.stringify(payload),
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
             WHERE (o.status = 'pending' OR (o.status = 'inflight' AND o.lease_expires_at <= ?))
               AND NOT EXISTS (
                 SELECT 1 FROM operations earlier
                 WHERE earlier.task_id = o.task_id
                   AND earlier.status IN ('pending', 'inflight')
                   AND (earlier.created_at < o.created_at OR
                     (earlier.created_at = o.created_at AND earlier.operation_id < o.operation_id))
               )
             ORDER BY o.created_at, o.operation_id
             LIMIT 1`,
          )
          .get(now),
      );
      if (identity === null) return null;
      const updated = this.#database
        .query(
          `UPDATE operations
           SET status = 'inflight', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE operation_id = ? AND (status = 'pending' OR (status = 'inflight' AND lease_expires_at <= ?))`,
        )
        .run(workerId, expiresAt, now, identity.operation_id, now);
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
             WHERE status = 'pending' OR (status = 'inflight' AND lease_expires_at <= ?)
             ORDER BY created_at, outbox_id LIMIT 1`,
          )
          .get(now),
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

  diagnostics(): {
    readonly events: number;
    readonly deliveries: number;
    readonly tasks: number;
    readonly operations: number;
    readonly outbox: number;
    readonly auditRecords: number;
  } {
    const count = (table: string): number => {
      const allowed = new Set([
        "slack_events",
        "slack_deliveries",
        "tasks",
        "operations",
        "slack_outbox",
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
          "SELECT task_id FROM tasks WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ?",
        )
        .get(event.workspaceId, event.conversationId, event.threadTs),
    );
    if (existing !== null) return existing.task_id;
    const taskId = crypto.randomUUID();
    this.#database
      .query(
        `INSERT INTO tasks (
          task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        taskId,
        event.workspaceId,
        event.conversationId,
        event.threadTs,
        event.profileId,
        event.repositoryRoot,
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
