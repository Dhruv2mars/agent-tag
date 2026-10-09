// Slack event ingest (idempotent per delivery and event key) and task/T3 bindings.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId } from "./context.ts";
import {
  canonicalEventSchema,
  deliveryLookupSchema,
  isoDateTime,
  nonEmpty,
  operationIdentitySchema,
  operationPayloadSchema,
  taskExecutionSchema,
  taskLookupSchema,
} from "./schema.ts";
import type {
  ActiveTaskBinding,
  IngestReceipt,
  SlackEventInput,
  TaskExecutionBinding,
} from "./types.ts";

export function ingestSlackEvent(context: StoreContext, input: SlackEventInput): IngestReceipt {
  const { database, faultInjector } = context;
  const event = {
    deliveryId: requiredId(input.deliveryId, "deliveryId"),
    eventKey: requiredId(input.eventKey, "eventKey"),
    workspaceId: requiredId(input.workspaceId, "workspaceId"),
    conversationId: requiredId(input.conversationId, "conversationId"),
    threadTs: requiredId(input.threadTs, "threadTs"),
    actorUserId: requiredId(input.actorUserId, "actorUserId"),
    conversationType: z.enum(["channel", "dm"]).parse(input.conversationType),
    profileId: requiredId(input.profileId, "profileId"),
    repositoryRoot: requiredId(input.repositoryRoot, "repositoryRoot"),
    text: input.text,
    receivedAt: isoDateTime.parse(input.receivedAt),
    sourceOrderKey: requiredId(input.sourceOrderKey ?? input.receivedAt, "sourceOrderKey"),
    messageTs: input.messageTs === undefined ? undefined : requiredId(input.messageTs, "messageTs"),
    origin: input.origin === undefined ? undefined : z.enum(["slack", "schedule"]).parse(input.origin),
    threadContext:
      input.threadContext === undefined
        ? undefined
        : {
            rootTs: requiredId(input.threadContext.rootTs, "threadContext.rootTs"),
            beforeTs: requiredId(input.threadContext.beforeTs, "threadContext.beforeTs"),
          },
  };
  const ingest = database.transaction((): IngestReceipt => {
    const priorDelivery = deliveryLookupSchema.nullable().parse(
      database
        .query("SELECT canonical_operation_id FROM slack_deliveries WHERE delivery_id = ?")
        .get(event.deliveryId),
    );
    if (priorDelivery !== null) {
      return receipt(database, "duplicate", event.deliveryId, priorDelivery.canonical_operation_id);
    }

    const canonical = canonicalEventSchema.nullable().parse(
      database
        .query("SELECT operation_id FROM slack_events WHERE workspace_id = ? AND event_key = ?")
        .get(event.workspaceId, event.eventKey),
    );
    if (canonical !== null) {
      insertDelivery(database, event, canonical.operation_id, "duplicate");
      writeAudit(database, {
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
      return receipt(database, "duplicate", event.deliveryId, canonical.operation_id);
    }

    const taskId = findOrCreateTask(database, event);
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
      ...(event.messageTs === undefined ? {} : { messageTs: event.messageTs }),
      ...(event.origin === undefined ? {} : { origin: event.origin }),
      ...(event.threadContext === undefined ? {} : { threadContext: event.threadContext }),
    });
    database
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
    faultInjector("ingest.after-operation");
    database
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
    insertDelivery(database, event, operationId, "accepted");
    writeAudit(database, {
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

export interface TaskBelongsToContextInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly actorUserId: string;
}

export function taskBelongsToContext(database: Database, input: TaskBelongsToContextInput): boolean {
  const row = database
    .query<{ count: number }, [string, string, string, string]>(
      `SELECT COUNT(*) AS count FROM tasks
       WHERE task_id = ? AND workspace_id = ? AND profile_id = ? AND state = 'active'
         AND (conversation_type = 'channel' OR owner_user_id = ?)`,
    )
    .get(
      requiredId(input.taskId, "taskId"),
      requiredId(input.workspaceId, "workspaceId"),
      requiredId(input.profileId, "profileId"),
      requiredId(input.actorUserId, "actorUserId"),
    );
  if (row === null) throw new Error("failed to check task context");
  return row.count === 1;
}

export interface BindT3TaskInput {
  readonly taskId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly now: string;
}

export function bindT3Task(database: Database, input: BindT3TaskInput): void {
  const now = isoDateTime.parse(input.now);
  const bind = database.transaction(() => {
    const result = database
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
    writeAudit(database, {
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

export interface FindActiveTaskInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
}

export function findActiveTask(database: Database, input: FindActiveTaskInput): ActiveTaskBinding | null {
  const schema = z.object({
    task_id: nonEmpty,
    profile_id: nonEmpty,
    repository_root: nonEmpty,
    conversation_type: z.enum(["channel", "dm"]),
    owner_user_id: nonEmpty.nullable(),
  });
  const row = schema.nullable().parse(
    database
      .query(
        `SELECT task_id, profile_id, repository_root, conversation_type, owner_user_id FROM tasks
         WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ? AND state = 'active'`,
      )
      .get(
        requiredId(input.workspaceId, "workspaceId"),
        requiredId(input.conversationId, "conversationId"),
        requiredId(input.threadTs, "threadTs"),
      ),
  );
  if (row === null) return null;
  return {
    taskId: row.task_id,
    profileId: row.profile_id,
    repositoryRoot: row.repository_root,
    conversationType: row.conversation_type,
    ownerUserId: row.owner_user_id,
  };
}

export function getTaskExecution(database: Database, taskIdInput: string): TaskExecutionBinding {
  const row = taskExecutionSchema.parse(
    database
      .query(
        `SELECT task_id, workspace_id, conversation_id, profile_id, repository_root, t3_project_id, t3_thread_id,
                t3_thread_started_at, conversation_type, owner_user_id, created_at
         FROM tasks WHERE task_id = ? AND state = 'active'`,
      )
      .get(requiredId(taskIdInput, "taskId")),
  );
  const projectOwner = z.object({ task_id: nonEmpty, created_at: isoDateTime }).parse(
    database
      .query(
        `SELECT task_id, created_at FROM tasks WHERE t3_project_id = ?
         ORDER BY rowid LIMIT 1`,
      )
      .get(row.t3_project_id),
  );
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    profileId: row.profile_id,
    repositoryRoot: row.repository_root,
    projectId: row.t3_project_id,
    projectOwnerTaskId: projectOwner.task_id,
    projectCreatedAt: projectOwner.created_at,
    threadId: row.t3_thread_id,
    threadStarted: row.t3_thread_started_at !== null,
    conversationType: row.conversation_type,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  };
}

export interface MarkT3ThreadStartedInput {
  readonly taskId: string;
  readonly now: string;
}

export function markT3ThreadStarted(database: Database, input: MarkT3ThreadStartedInput): void {
  const now = isoDateTime.parse(input.now);
  const result = database
    .query(
      `UPDATE tasks SET t3_thread_started_at = COALESCE(t3_thread_started_at, ?), updated_at = ?
       WHERE task_id = ? AND state = 'active'`,
    )
    .run(now, now, requiredId(input.taskId, "taskId"));
  if (result.changes !== 1) throw new Error("active task not found");
}

export interface EnsureTaskForThreadInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly conversationType: "channel" | "dm";
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly now: string;
}

/**
 * Returns the task bound to a Slack thread, creating it if needed, without creating an operation
 * (e.g. so a routine request can bind its schedule to the thread). Idempotent per thread.
 */
export function ensureTaskForThread(database: Database, input: EnsureTaskForThreadInput): string {
  const event = {
    workspaceId: requiredId(input.workspaceId, "workspaceId"),
    conversationId: requiredId(input.conversationId, "conversationId"),
    threadTs: requiredId(input.threadTs, "threadTs"),
    actorUserId: requiredId(input.actorUserId, "actorUserId"),
    conversationType: z.enum(["channel", "dm"]).parse(input.conversationType),
    profileId: requiredId(input.profileId, "profileId"),
    repositoryRoot: requiredId(input.repositoryRoot, "repositoryRoot"),
    receivedAt: isoDateTime.parse(input.now),
  };
  return database.transaction(() => findOrCreateTask(database, event)).immediate();
}

function findOrCreateTask(database: Database, event: {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly conversationType: "channel" | "dm";
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly receivedAt: string;
}): string {
  const existing = taskLookupSchema.nullable().parse(
    database
      .query(
        `SELECT task_id, profile_id, repository_root, t3_project_id, t3_thread_id,
                conversation_type, owner_user_id FROM tasks
         WHERE workspace_id = ? AND conversation_id = ? AND thread_ts = ?`,
      )
      .get(event.workspaceId, event.conversationId, event.threadTs),
  );
  if (existing !== null) {
    const expectedOwner = event.conversationType === "dm" ? event.actorUserId : null;
    if (
      existing.profile_id !== event.profileId ||
      existing.repository_root !== event.repositoryRoot ||
      existing.conversation_type !== event.conversationType ||
      existing.owner_user_id !== expectedOwner
    ) {
      throw new Error("task conversation identity does not match the incoming event");
    }
    if (existing.t3_project_id === null || existing.t3_thread_id === null) {
      database
        .query(
          `UPDATE tasks SET t3_project_id = COALESCE(t3_project_id, ?),
             t3_thread_id = COALESCE(t3_thread_id, ?), updated_at = ? WHERE task_id = ?`,
        )
        .run(
          projectIdForRoot(database, event.repositoryRoot),
          `agent-tag-thread-${crypto.randomUUID()}`,
          event.receivedAt,
          existing.task_id,
        );
    }
    return existing.task_id;
  }
  const taskId = crypto.randomUUID();
  const projectId = projectIdForRoot(database, event.repositoryRoot);
  const threadId = `agent-tag-thread-${crypto.randomUUID()}`;
  database
    .query(
      `INSERT INTO tasks (
        task_id, workspace_id, conversation_id, thread_ts, profile_id, repository_root,
        t3_project_id, t3_thread_id, conversation_type, owner_user_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
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
      event.conversationType,
      event.conversationType === "dm" ? event.actorUserId : null,
      event.receivedAt,
      event.receivedAt,
    );
  return taskId;
}

function projectIdForRoot(database: Database, repositoryRoot: string): string {
  const existing = z.object({ t3_project_id: nonEmpty }).nullable().parse(
    database
      .query(
        `SELECT t3_project_id FROM tasks
         WHERE repository_root = ? AND t3_project_id IS NOT NULL
         ORDER BY rowid LIMIT 1`,
      )
      .get(repositoryRoot),
  );
  return existing?.t3_project_id ?? `agent-tag-project-${crypto.randomUUID()}`;
}

function insertDelivery(
  database: Database,
  event: {
    readonly deliveryId: string;
    readonly workspaceId: string;
    readonly eventKey: string;
    readonly receivedAt: string;
  },
  operationId: string,
  disposition: "accepted" | "duplicate",
): void {
  database
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

function receipt(
  database: Database,
  kind: IngestReceipt["kind"],
  deliveryId: string,
  operationId: string,
): IngestReceipt {
  const identity = operationIdentitySchema.parse(
    database
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
