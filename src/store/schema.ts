import { z } from "zod";

import { scheduleRecurrenceSchema, type ScheduleRecurrence } from "../routines/cron.ts";

// Zod schemas for store inputs, stored JSON and the rows read back from SQLite.
export const nonEmpty = z.string().min(1);
export const isoDateTime = z.iso.datetime();
export const operationPayloadSchema = z.object({
  text: z.string(),
  actorUserId: nonEmpty,
  conversationId: nonEmpty,
  threadTs: nonEmpty,
  profileId: nonEmpty,
  repositoryRoot: nonEmpty,
});
export const plainTextObjectSchema = z.object({ type: z.literal("plain_text"), text: z.string(), emoji: z.boolean().optional() });
export const mrkdwnObjectSchema = z.object({ type: z.literal("mrkdwn"), text: z.string() });
export const buttonElementSchema = z.object({
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
export const slackBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), text: z.union([plainTextObjectSchema, mrkdwnObjectSchema]) }),
  z.object({ type: z.literal("actions"), block_id: nonEmpty.optional(), elements: z.array(buttonElementSchema).min(1) }),
  z.object({ type: z.literal("context"), elements: z.array(z.union([plainTextObjectSchema, mrkdwnObjectSchema])).min(1) }),
]);
export const outboxPayloadSchema = z.object({
  text: z.string(),
  blocks: z.array(slackBlockSchema).optional(),
});

export const operationRowSchema = z.object({
  operation_id: nonEmpty,
  task_id: nonEmpty,
  command_id: nonEmpty,
  message_id: nonEmpty,
  payload_json: nonEmpty,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
  turn_active_ms: z.number().int().nonnegative(),
});

export const outboxRowSchema = z.object({
  outbox_id: nonEmpty,
  task_id: nonEmpty,
  correlation_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  client_message_id: nonEmpty,
  payload_json: nonEmpty,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
  render_mode: z.enum(["rich", "plain"]),
});

export const deliveryLookupSchema = z.object({
  canonical_operation_id: nonEmpty,
});

export const canonicalEventSchema = z.object({
  operation_id: nonEmpty,
});

export const operationIdentitySchema = z.object({
  operation_id: nonEmpty,
  task_id: nonEmpty,
  command_id: nonEmpty,
  message_id: nonEmpty,
});

export const taskLookupSchema = z.object({
  task_id: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
  t3_project_id: nonEmpty.nullable(),
  t3_thread_id: nonEmpty.nullable(),
  conversation_type: z.enum(["channel", "dm"]),
  owner_user_id: nonEmpty.nullable(),
});
export const outboxIdentitySchema = z.object({ outbox_id: nonEmpty });
export const taskExecutionSchema = z.object({
  task_id: nonEmpty,
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
  t3_project_id: nonEmpty,
  t3_thread_id: nonEmpty,
  t3_thread_started_at: isoDateTime.nullable(),
  conversation_type: z.enum(["channel", "dm"]),
  owner_user_id: nonEmpty.nullable(),
  created_at: isoDateTime,
});
export const interactionIdentitySchema = z.object({ interaction_id: nonEmpty });
export const interactionRowSchema = z.object({
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
export const userInputQuestionPromptSchema = z.object({
  id: nonEmpty,
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
  allowCustomAnswer: z.boolean().optional(),
});
export const userInputPromptSchema = z.object({ questions: z.array(userInputQuestionPromptSchema).min(1) });
export const userInputAnswerSchema = z.union([z.string().min(1), z.array(z.string()).min(1)]);
export const partialUserInputSchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      answer: userInputAnswerSchema,
      actorUserId: nonEmpty,
      sourceActionId: nonEmpty,
      answeredAt: isoDateTime,
    }),
  ),
  sourceActionIds: z.array(nonEmpty),
});
export const auditRowSchema = z.object({
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
export const auditMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export const AUDIT_ACTIONS = [
  "ambient.decided",
  "interaction.approval.requested",
  "interaction.cancel.requested",
  "interaction.expired",
  "interaction.closed",
  "interaction.adopted",
  "interaction.response.claimed",
  "interaction.response.completed",
  "interaction.response.failed",
  "interaction.response.submitted",
  "interaction.user-input.answer-recorded",
  "interaction.user-input.requested",
  "memory.created",
  "memory.denied",
  "memory.expired",
  "memory.forgotten",
  "memory.updated",
  "operation.cancelled",
  "operation.claimed",
  "operation.completed",
  "operation.deferred",
  "operation.failed",
  "operation.released",
  "operation.turn-text.resolved",
  "schedule.cancelled",
  "schedule.authority-revoked",
  "schedule.claimed",
  "schedule.created",
  "schedule.denied",
  "schedule.run.settled",
  "slack.delivery.duplicate",
  "slack.event.ingested",
  "slack.outbox.claimed",
  "slack.outbox.delivered",
  "slack.outbox.enqueued",
  "slack.outbox.failed",
  "slack.outbox.fallback-scheduled",
  "slack.outbox.quarantined",
  "slack.outbox.retry-exhausted",
  "slack.outbox.retry-scheduled",
  "task.cancellation.requested",
  "task.t3-bound",
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;
export const auditWriteSchema = z.object({
  actorType: nonEmpty,
  actorId: nonEmpty,
  authority: nonEmpty,
  source: nonEmpty,
  target: nonEmpty,
  action: auditActionSchema,
  result: nonEmpty,
  correlationId: nonEmpty,
  metadata: auditMetadataSchema,
  createdAt: isoDateTime,
});
export const memoryRowSchema = z.object({
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
export const memoryContent = z.string().trim().min(1).max(2_000);
export const resolvedOperationTextSchema = z.object({ resolved_text: z.string().nullable() });
export const schedulePrompt = z.string().trim().min(1).max(4_000);
export const recurrenceJson = z
  .string()
  .nullable()
  .transform((raw, context): ScheduleRecurrence | null => {
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      context.addIssue({ code: "custom", message: "recurrence_json is not valid JSON" });
      return z.NEVER;
    }
    const parsed = scheduleRecurrenceSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "recurrence_json is invalid" });
      return z.NEVER;
    }
    return parsed.data;
  });
export const scheduleRowSchema = z.object({
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
  recurrence_json: recurrenceJson,
  missed_run_policy: z.enum(["run-once", "skip"]),
  misfire_grace_seconds: z.number().int().nonnegative(),
  overlap_policy: z.enum(["skip", "queue"]),
  next_run_at: isoDateTime,
  attempts: z.number().int().nonnegative(),
  lease_expires_at: isoDateTime,
});
export const scheduleTargetSchema = z.object({
  workspace_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  profile_id: nonEmpty,
  repository_root: nonEmpty,
});
export const ambientDecisionSchema = z.object({
  disposition: z.enum(["triggered", "quiet"]),
  reason: nonEmpty,
});
