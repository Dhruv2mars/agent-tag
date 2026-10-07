import type { z } from "zod";

import type { ScheduleRecurrence } from "../routines/cron.ts";
import type {
  AuditAction,
  operationPayloadSchema,
  outboxPayloadSchema,
  userInputQuestionPromptSchema,
} from "./schema.ts";

// Public types of the store API. Re-exported from store.ts.

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
  readonly conversationType: "channel" | "dm";
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
  readonly conversationType: "channel" | "dm";
  readonly ownerUserId: string | null;
}

export interface TaskExecutionBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly projectId: string;
  readonly projectOwnerTaskId: string;
  readonly projectCreatedAt: string;
  readonly threadId: string;
  readonly threadStarted: boolean;
  readonly conversationType: "channel" | "dm";
  readonly ownerUserId: string | null;
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

export interface OperationalStatus {
  readonly asOf: string;
  readonly operations: {
    readonly ready: number;
    readonly deferred: number;
    readonly activeLease: number;
    readonly expiredLease: number;
    readonly stalledRetry: number;
    readonly stalledFailed: number;
    readonly oldestReadyAt: string | null;
  };
  readonly interactions: {
    readonly awaitingHuman: number;
    readonly responseQueued: number;
  };
  readonly outbox: {
    readonly pending: number;
    readonly activeLease: number;
    readonly expiredLease: number;
    /** Pending rows waiting out a retry backoff (blocked_until in the future). */
    readonly retryBlocked: number;
    /** End of the active Slack rate-limit cooldown that pauses every outbox send, or null. */
    readonly rateLimitedUntil: string | null;
    readonly outcomeUnknown: number;
  };
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

export type UserInputQuestionPrompt = z.infer<typeof userInputQuestionPromptSchema>;

/** A person's choice for one question: option indexes or labels from the prompt, and/or free text. */
export interface UserInputSelection {
  readonly optionIndexes?: ReadonlyArray<number>;
  readonly optionLabels?: ReadonlyArray<string>;
  readonly text?: string;
}

export type UserInputAnswerResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | { readonly kind: "partial"; readonly commandId: string; readonly answered: number; readonly total: number }
  | { readonly kind: "invalid" }
  | { readonly kind: "denied" };

export interface ClaimedOutboxMessage {
  readonly outboxId: string;
  readonly taskId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly clientMessageId: string;
  readonly payload: SlackOutboxPayload;
  /** "plain" once a deterministic block/length rejection scheduled the one plain-text fallback. */
  readonly renderMode: "rich" | "plain";
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
  readonly action: AuditAction;
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
  readonly recurrence: ScheduleRecurrence | null;
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
  readonly recurrence: ScheduleRecurrence | null;
  readonly missedRunPolicy: "run-once" | "skip";
  readonly overlapPolicy: "skip" | "queue";
}

export type AmbientDecision =
  | { readonly kind: "triggered" }
  | { readonly kind: "quiet"; readonly reason: "unchanged" | "cooldown" | "hourly-limit" };
