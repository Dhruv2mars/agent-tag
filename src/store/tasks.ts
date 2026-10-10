// Slack event ingest (idempotent per delivery and event key) and task/T3 bindings.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { type T3ModelSelection, t3ModelSelectionSchema } from "../t3/gateway.ts";
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
                t3_thread_started_at, conversation_type, owner_user_id, created_at, model_selection_json,
                t3_model_selection_json, t3_rejected_model_selection_json
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
    desiredModelSelection: storedModelSelection(row.model_selection_json),
    appliedModelSelection: storedModelSelection(row.t3_model_selection_json),
    rejectedModelSelection: storedModelSelection(row.t3_rejected_model_selection_json),
    invalidModelSelection: TASK_MODEL_COLUMNS.some((column) => row[column] !== null && storedModelSelection(row[column]) === null),
  };
}

/**
 * A stored selection column. Unparseable or invalid JSON reads as NULL (the default) rather than
 * failing the task; the binding flags it so the coordinator clears and audits it
 * (`clearInvalidModelSelection`) and re-records the applied selection on the next turn.
 */
function storedModelSelection(json: string | null): T3ModelSelection | null {
  if (json === null) return null;
  try {
    const parsed = t3ModelSelectionSchema.safeParse(JSON.parse(json));
    if (parsed.success) return { instanceId: parsed.data.instanceId, model: parsed.data.model };
  } catch {
    // Not JSON: treated as unset.
  }
  return null;
}

function selectionJson(selection: T3ModelSelection | null): string | null {
  if (selection === null) return null;
  const parsed = t3ModelSelectionSchema.parse(selection);
  return JSON.stringify({ instanceId: parsed.instanceId, model: parsed.model });
}

function selectionMetadata(
  selection: T3ModelSelection | null,
  previous: T3ModelSelection | null,
  code?: string,
): Record<string, string | null> {
  return {
    instanceId: selection?.instanceId ?? null,
    model: selection?.model ?? null,
    ...(previous === null ? {} : { previousInstanceId: previous.instanceId, previousModel: previous.model }),
    ...(code === undefined ? {} : { code }),
  };
}

function sameStoredSelection(left: T3ModelSelection | null, right: T3ModelSelection | null): boolean {
  return left === right
    || (left !== null && right !== null && left.instanceId === right.instanceId && left.model === right.model);
}

function taskModelRow(database: Database, taskId: string): {
  readonly desired: T3ModelSelection | null;
  readonly applied: T3ModelSelection | null;
  readonly rejected: T3ModelSelection | null;
  readonly threadId: string;
} {
  const row = z.object({
    model_selection_json: z.string().nullable(),
    t3_model_selection_json: z.string().nullable(),
    t3_rejected_model_selection_json: z.string().nullable(),
    t3_thread_id: nonEmpty,
  }).nullable().parse(
    database
      .query(
        `SELECT model_selection_json, t3_model_selection_json, t3_rejected_model_selection_json, t3_thread_id
         FROM tasks WHERE task_id = ? AND state = 'active'`,
      )
      .get(taskId),
  );
  if (row === null) throw new Error("active task not found");
  return {
    desired: storedModelSelection(row.model_selection_json),
    applied: storedModelSelection(row.t3_model_selection_json),
    rejected: storedModelSelection(row.t3_rejected_model_selection_json),
    threadId: row.t3_thread_id,
  };
}

export interface SetTaskModelSelectionInput {
  readonly taskId: string;
  /** The selection the user chose; null returns the task to the route or profile default. */
  readonly selection: T3ModelSelection | null;
  readonly selectedBy: string;
  readonly now: string;
}

/** Records a user's model choice for a task's next turns, audited as `task.model.selected`. */
export function setTaskModelSelection(database: Database, input: SetTaskModelSelectionInput): void {
  const taskId = requiredId(input.taskId, "taskId");
  const selectedBy = requiredId(input.selectedBy, "selectedBy");
  const now = isoDateTime.parse(input.now);
  const json = selectionJson(input.selection);
  database.transaction(() => {
    const current = taskModelRow(database, taskId);
    database
      .query(
        `UPDATE tasks SET model_selection_json = ?, model_selected_by = ?, model_selected_at = ?, updated_at = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(json, selectedBy, now, now, taskId);
    writeAudit(database, {
      actorType: "slack-user",
      actorId: selectedBy,
      authority: "task-model",
      source: "slack",
      target: taskId,
      action: "task.model.selected",
      result: "accepted",
      correlationId: taskId,
      metadata: selectionMetadata(input.selection, current.desired),
      createdAt: now,
    });
  }).immediate();
}

export interface RecordAppliedModelSelectionInput {
  readonly taskId: string;
  /** The T3 thread the selection was sent to; a task since moved to another thread is left alone. */
  readonly threadId: string;
  readonly selection: T3ModelSelection;
  readonly now: string;
}

/**
 * Records the selection T3 accepted for the task's current thread. Returns whether it was written.
 * A changed applied selection clears the recorded rejection, which was relative to the old one.
 */
export function recordAppliedModelSelection(database: Database, input: RecordAppliedModelSelectionInput): boolean {
  const now = isoDateTime.parse(input.now);
  const result = database
    .query(
      `UPDATE tasks SET t3_model_selection_json = ?, t3_rejected_model_selection_json = NULL, updated_at = ?
       WHERE task_id = ? AND t3_thread_id = ? AND state = 'active'
         AND t3_model_selection_json IS NOT ?`,
    )
    .run(
      selectionJson(input.selection),
      now,
      requiredId(input.taskId, "taskId"),
      requiredId(input.threadId, "threadId"),
      selectionJson(input.selection),
    );
  return result.changes === 1;
}

export type ModelRevertReason = "revoked" | "refused";

/** A reverted desired selection: what it was and what it is now (null = route or profile default). */
export interface ModelRevert {
  readonly previous: T3ModelSelection | null;
  readonly next: T3ModelSelection | null;
}

export interface RevertDesiredModelSelectionInput {
  readonly taskId: string;
  /**
   * `revoked`: config no longer allows the desired model, so the task returns to its default (NULL).
   * `refused`: T3 cannot move the thread there, so the desired model becomes the applied one and
   * the thread keeps what it has. (A switch T3 itself rejected goes through `recordModelRejection`.)
   */
  readonly reason: ModelRevertReason;
  /** A stable refusal code (`SwitchRefusalCode` or a failure code) for the audit row. */
  readonly code: string;
  readonly correlationId: string;
  readonly now: string;
}

/**
 * Drops a desired selection that cannot be honoured, audited as `task.model.reverted`. Returns the
 * change, or null when there was nothing to revert (already reverted, or no choice made).
 */
export function revertDesiredModelSelection(
  database: Database,
  input: RevertDesiredModelSelectionInput,
): ModelRevert | null {
  const taskId = requiredId(input.taskId, "taskId");
  const now = isoDateTime.parse(input.now);
  return database.transaction(() => {
    const current = taskModelRow(database, taskId);
    if (current.desired === null) return null;
    const next = input.reason === "revoked" ? null : current.applied;
    if (sameStoredSelection(next, current.desired)) return null;
    database
      .query("UPDATE tasks SET model_selection_json = ?, updated_at = ? WHERE task_id = ? AND state = 'active'")
      .run(selectionJson(next), now, taskId);
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "task-model",
      source: input.reason,
      target: taskId,
      action: "task.model.reverted",
      result: input.reason,
      correlationId: requiredId(input.correlationId, "correlationId"),
      metadata: selectionMetadata(next, current.desired, requiredId(input.code, "code")),
      createdAt: now,
    });
    return { previous: current.desired, next };
  }).immediate();
}

export interface RecordModelRejectionInput {
  readonly taskId: string;
  /** The thread T3 refused to move; a task since moved to another thread is left alone. */
  readonly threadId: string;
  /** The selection T3 refused for the thread. */
  readonly rejected: T3ModelSelection;
  readonly code: string;
  readonly correlationId: string;
  readonly now: string;
}

/**
 * Records a switch T3 refused for the task's thread, audited once as `task.model.reverted`
 * (`t3-rejected`). The thread keeps its applied selection: a desired selection equal to the rejected
 * one reverts to it (a newer choice is kept), and a
 * route or profile default equal to the rejected one is not retried until the default or the applied
 * selection changes (the coordinator reads `rejectedModelSelection`). Returns whether it was written.
 */
export function recordModelRejection(database: Database, input: RecordModelRejectionInput): boolean {
  const taskId = requiredId(input.taskId, "taskId");
  const now = isoDateTime.parse(input.now);
  return database.transaction(() => {
    const current = taskModelRow(database, taskId);
    if (current.threadId !== requiredId(input.threadId, "threadId")) return false;
    // Only the choice this rejection was for reverts; a newer one (made while it awaited replay) stays.
    const desired = sameStoredSelection(current.desired, input.rejected) ? current.applied : current.desired;
    if (sameStoredSelection(current.rejected, input.rejected) && sameStoredSelection(desired, current.desired)) {
      return false;
    }
    database
      .query(
        `UPDATE tasks SET t3_rejected_model_selection_json = ?, model_selection_json = ?, updated_at = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(selectionJson(input.rejected), selectionJson(desired), now, taskId);
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "task-model",
      source: "t3-rejected",
      target: taskId,
      action: "task.model.reverted",
      result: "t3-rejected",
      correlationId: requiredId(input.correlationId, "correlationId"),
      metadata: selectionMetadata(current.applied, input.rejected, requiredId(input.code, "code")),
      createdAt: now,
    });
    return true;
  }).immediate();
}

const TASK_MODEL_COLUMNS = ["model_selection_json", "t3_model_selection_json", "t3_rejected_model_selection_json"] as const;

export type TaskModelColumn = (typeof TASK_MODEL_COLUMNS)[number];

export interface ClearInvalidModelSelectionInput {
  readonly taskId: string;
  readonly correlationId: string;
  readonly now: string;
}

/**
 * Resets selection columns holding an unreadable value to NULL, audited as `task.model.reverted`
 * (result `invalid`) naming the columns but never their contents. Returns the columns it cleared.
 */
export function clearInvalidModelSelection(
  database: Database,
  input: ClearInvalidModelSelectionInput,
): readonly TaskModelColumn[] {
  const taskId = requiredId(input.taskId, "taskId");
  const now = isoDateTime.parse(input.now);
  return database.transaction(() => {
    const row = z.object({
      model_selection_json: z.string().nullable(),
      t3_model_selection_json: z.string().nullable(),
      t3_rejected_model_selection_json: z.string().nullable(),
    }).nullable().parse(
      database
        .query(`SELECT ${TASK_MODEL_COLUMNS.join(", ")} FROM tasks WHERE task_id = ? AND state = 'active'`)
        .get(taskId),
    );
    if (row === null) return [];
    const columns = TASK_MODEL_COLUMNS.filter(
      (column) => row[column] !== null && storedModelSelection(row[column]) === null,
    );
    if (columns.length === 0) return [];
    database
      .query(`UPDATE tasks SET ${columns.map((column) => `${column} = NULL`).join(", ")}, updated_at = ? WHERE task_id = ?`)
      .run(now, taskId);
    writeAudit(database, {
      actorType: "service",
      actorId: "agent-tag",
      authority: "task-model",
      source: "store",
      target: taskId,
      action: "task.model.reverted",
      result: "invalid",
      correlationId: requiredId(input.correlationId, "correlationId"),
      metadata: { columns: columns.join(",") },
      createdAt: now,
    });
    return columns;
  }).immediate();
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
