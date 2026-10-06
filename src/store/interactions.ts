// Approval and cancel interactions: recording prompts, human responses, and response delivery to T3.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId, parseStoredJson } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { insertOutboxMessage } from "./outbox.ts";
import {
  interactionIdentitySchema,
  interactionRowSchema,
  isoDateTime,
  nonEmpty,
  outboxIdentitySchema,
  outboxPayloadSchema,
} from "./schema.ts";
import type { ClaimedInteractionResponse, SlackOutboxPayload } from "./types.ts";

export type RecordPendingInteractionResult = {
  readonly kind: "accepted" | "duplicate";
  readonly interactionId: string;
  readonly outboxId: string;
};

export type SubmitInteractionResponseResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | { readonly kind: "denied" };

export type RequestTaskCancellationResult =
  | { readonly kind: "accepted" | "duplicate"; readonly interactionId: string; readonly commandId: string }
  | { readonly kind: "denied" };

export interface RecordPendingInteractionInput {
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
}

export function recordPendingInteraction(
  database: Database,
  input: RecordPendingInteractionInput,
): RecordPendingInteractionResult {
  const now = isoDateTime.parse(input.now);
  const record = database.transaction(() => {
    const prior = interactionIdentitySchema.nullable().parse(
      database
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
        database
          .query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?")
          .get(`${prior.interaction_id}:prompt`),
      );
      return { kind: "duplicate" as const, interactionId: prior.interaction_id, outboxId: outbox.outbox_id };
    }

    const interactionId = crypto.randomUUID();
    const responseCommandId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const message = outboxPayloadSchema.parse(input.message(interactionId));
    database
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
    insertOutboxMessage(database, {
      outboxId,
      taskId: input.taskId,
      correlationId: interactionId,
      conversationId: requiredId(input.conversationId, "conversationId"),
      threadTs: requiredId(input.threadTs, "threadTs"),
      clientMessageId: `${interactionId}:prompt`,
      payload: message,
      createdAt: now,
    });
    writeAudit(database, {
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

export interface SubmitInteractionResponseInput {
  readonly interactionId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly sourceActionId: string;
  readonly response: unknown;
  readonly now: string;
}

export function submitInteractionResponse(
  database: Database,
  input: SubmitInteractionResponseInput,
): SubmitInteractionResponseResult {
  const now = isoDateTime.parse(input.now);
  const submit = database.transaction(() => {
    const rowSchema = z.object({
      interaction_id: nonEmpty,
      response_command_id: nonEmpty,
      source_action_id: nonEmpty.nullable(),
      state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
    });
    const row = rowSchema.nullable().parse(
      database
        .query(
          `SELECT i.interaction_id, i.response_command_id, i.source_action_id, i.state
           FROM interactions i JOIN tasks t ON t.task_id = i.task_id
           WHERE i.interaction_id = ? AND t.workspace_id = ? AND t.conversation_id = ?
             AND t.thread_ts = ? AND t.state = 'active'
             AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)`,
        )
        .get(
          requiredId(input.interactionId, "interactionId"),
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          requiredId(input.actorUserId, "actorUserId"),
        ),
    );
    if (row === null) return { kind: "denied" as const };
    if (row.source_action_id === input.sourceActionId || row.state !== "pending") {
      return { kind: "duplicate" as const, commandId: row.response_command_id };
    }
    const updated = database
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
    database
      .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
      .run(now, row.interaction_id);
    writeAudit(database, {
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

export interface RequestTaskCancellationInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly sourceActionId: string;
  readonly now: string;
}

export function requestTaskCancellation(
  database: Database,
  input: RequestTaskCancellationInput,
): RequestTaskCancellationResult {
  const now = isoDateTime.parse(input.now);
  const request = database.transaction(() => {
    const targetSchema = z.object({ operation_id: nonEmpty, thread_id: nonEmpty });
    const target = targetSchema.nullable().parse(
      database
        .query(
          `SELECT o.operation_id, t.t3_thread_id AS thread_id
           FROM tasks t JOIN operations o ON o.task_id = t.task_id
           WHERE t.task_id = ? AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ?
             AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)
             AND t.state = 'active' AND o.status IN ('pending', 'inflight')
           ORDER BY CASE o.status WHEN 'inflight' THEN 0 ELSE 1 END, o.source_order_key, o.operation_id
           LIMIT 1`,
        )
        .get(
          requiredId(input.taskId, "taskId"),
          requiredId(input.workspaceId, "workspaceId"),
          requiredId(input.conversationId, "conversationId"),
          requiredId(input.threadTs, "threadTs"),
          requiredId(input.actorUserId, "actorUserId"),
        ),
    );
    if (target === null) return { kind: "denied" as const };
    const requestId = `cancel:${target.operation_id}`;
    const prior = interactionIdentitySchema.nullable().parse(
      database
        .query("SELECT interaction_id FROM interactions WHERE thread_id = ? AND request_id = ? AND kind = 'cancel'")
        .get(target.thread_id, requestId),
    );
    if (prior !== null) {
      const command = z.object({ response_command_id: nonEmpty }).parse(
        database
          .query("SELECT response_command_id FROM interactions WHERE interaction_id = ?")
          .get(prior.interaction_id),
      );
      return { kind: "duplicate" as const, interactionId: prior.interaction_id, commandId: command.response_command_id };
    }
    const interactionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    database
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
    writeAudit(database, {
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

export interface ClaimNextInteractionResponseInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseMs: number;
}

export function claimNextInteractionResponse(
  database: Database,
  input: ClaimNextInteractionResponseInput,
): ClaimedInteractionResponse | null {
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedInteractionResponse | null => {
    const candidate = interactionIdentitySchema.nullable().parse(
      database
        .query(
          `SELECT interaction_id FROM interactions
           WHERE state = 'response-pending' OR (state = 'inflight' AND lease_expires_at <= ?)
           ORDER BY created_at, interaction_id LIMIT 1`,
        )
        .get(now),
    );
    if (candidate === null) return null;
    const updated = database
      .query(
        `UPDATE interactions SET state = 'inflight', attempts = attempts + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE interaction_id = ? AND (state = 'response-pending' OR (state = 'inflight' AND lease_expires_at <= ?))`,
      )
      .run(workerId, expiresAt, now, candidate.interaction_id, now);
    if (updated.changes !== 1) return null;
    const row = interactionRowSchema.parse(
      database
        .query(
          `SELECT interaction_id, task_id, operation_id, thread_id, request_id, kind,
                  response_command_id, response_json, response_actor_id, attempts, lease_expires_at
           FROM interactions WHERE interaction_id = ?`,
        )
        .get(candidate.interaction_id),
    );
    writeAudit(database, {
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

export interface CompleteInteractionResponseInput {
  readonly interactionId: string;
  readonly workerId: string;
  readonly now: string;
}

export function completeInteractionResponse(
  database: Database,
  input: CompleteInteractionResponseInput,
): void {
  const now = isoDateTime.parse(input.now);
  const complete = database.transaction(() => {
    const result = database
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
    requireLeaseHeld(result, "interaction");
    database
      .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
      .run(now, input.interactionId);
    writeAudit(database, {
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

export interface FailInteractionResponseInput {
  readonly interactionId: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly now: string;
}

export function failInteractionResponse(database: Database, input: FailInteractionResponseInput): void {
  const now = isoDateTime.parse(input.now);
  const state = input.retryable ? "response-pending" : "failed";
  const fail = database.transaction(() => {
    const result = database
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
    requireLeaseHeld(result, "interaction");
    writeAudit(database, {
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
