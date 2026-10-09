import type { z } from "zod";

import type { ScheduleRecurrence } from "../routines/cron.ts";
import type { T3ModelSelection } from "../t3/gateway.ts";
import type {
  AuditAction,
  operationPayloadSchema,
  outboxPayloadSchema,
  outboxStatusSchema,
  refreshKindSchema,
  userInputQuestionPromptSchema,
} from "./schema.ts";

// Public types of the store API. Re-exported from store.ts.

export type StoreFaultPoint =
  | "ingest.after-operation"
  | "operation-claim.after-update"
  | "outbox-enqueue.after-insert"
  | "outbox-claim.after-update"
  | "schedule-outcome.after-record";

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
  /** Slack ts of the triggering message; copied into the operation payload. */
  readonly messageTs?: string;
  readonly origin?: "slack" | "schedule";
  /** Thread window seed (first mention in an existing thread); copied into the operation payload. */
  readonly threadContext?: { readonly rootTs: string; readonly beforeTs: string };
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
  /** The model a user chose for this task; null means the route or profile default. */
  readonly desiredModelSelection: T3ModelSelection | null;
  /** The last selection T3 accepted for `threadId`; null before the first turn (or for older tasks). */
  readonly appliedModelSelection: T3ModelSelection | null;
  /** A switch T3 refused for `threadId` since `appliedModelSelection` was recorded; not retried as a default. */
  readonly rejectedModelSelection: T3ModelSelection | null;
  /** A selection column held an unreadable value (read as null); see `clearInvalidModelSelection`. */
  readonly invalidModelSelection: boolean;
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
  /** Milliseconds this turn has already spent being polled, summed over earlier claims. */
  readonly turnActiveMs: number;
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
export type RefreshKind = z.infer<typeof refreshKindSchema>;
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

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
  /** The target operation's status, so a cancel can settle without T3 when nothing is running. */
  readonly operationStatus: "pending" | "inflight" | "succeeded" | "failed";
  /**
   * Why a failed operation failed. A local failure (for example a settlement timeout) does not prove
   * the T3 turn ended, so a cancel still interrupts unless the code records an observed outcome.
   */
  readonly operationErrorCode: string | null;
  /** The T3 user message id the target operation sends, used to find its turn in a thread snapshot. */
  readonly operationMessageId: string;
  /**
   * Whether `thread.turn.start` may have reached T3. True even when every receipt was lost, so a
   * failed operation's turn is reconciled against T3 instead of assumed never started.
   */
  readonly turnDispatched: boolean;
  /** When `thread.turn.start` was last sent (or the start confirmed), or null if it never was. */
  readonly turnDispatchedAt: string | null;
  /** Whether a T3 receipt confirmed the target operation's turn start. */
  readonly turnStarted: boolean;
  /** The T3 turn id once the coordinator has observed it; interrupts pass it when known. */
  readonly turnId: string | null;
  /**
   * T3 request ids of the target operation's user-input questions. A message-mode answer starts a
   * continuation turn from user message `async-answer:<requestId>`, which the operation also owns.
   */
  readonly userInputRequestIds: ReadonlyArray<string>;
  /**
   * Whether any of those questions ever had an answer accepted from Slack (whatever became of its
   * delivery). Only T3 knows whether such an answer started a continuation turn, so a cancel cannot
   * settle from the operation's local outcome alone.
   */
  readonly userInputAnswered: boolean;
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
  | { readonly kind: "expired" }
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
  /** "post" is chat.postMessage; "update" edits the message posted by `target` (chat.update). */
  readonly method: "post" | "update";
  /**
   * Set on refresh rows: the payload is rendered at delivery time for (refreshKind, correlationId) and
   * `payload` is an unsent placeholder. Null on posts and static edits, which send `payload` as-is.
   */
  readonly refreshKind: RefreshKind | null;
  /** The edited message's post row (update rows only): its status and, once delivered, its Slack ts. */
  readonly target: { readonly status: OutboxStatus; readonly slackMessageTs: string | null } | null;
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
  /** Reminders: the Slack user to @mention on delivery. */
  readonly notifyUserId: string | null;
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
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly profileId: string;
  /** The Slack user who created the routine. */
  readonly actorUserId: string;
  /** Zone used to interpret the request; null for CLI-created schedules. */
  readonly timeZone: string | null;
  /** The parser's description, e.g. "every weekday at 09:00 (America/New_York)". */
  readonly humanReadable: string | null;
  /** Reminders: the user to @mention on delivery. */
  readonly notifyUserId: string | null;
  readonly consecutiveFailures: number;
  readonly failureStreakStartedAt: string | null;
  readonly endedReason: ScheduleEndedReason | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
}

export type ScheduleEndedReason = "user-cancelled" | "auto-disabled" | "authority-revoked" | "completed";

export type ScheduleRunOutcome = "succeeded" | "failed" | "cancelled" | "skipped";

export type AmbientDecision =
  | { readonly kind: "triggered" }
  | { readonly kind: "quiet"; readonly reason: "unchanged" | "cooldown" | "hourly-limit" };

/** A bot, non-allowlisted or edit update in a bound thread, shown on the next human turn. */
export interface ThreadNote {
  readonly noteId: string;
  readonly kind: "message" | "edit";
  readonly speakerKind: "human" | "bot";
  /** A user ID for humans, a bot ID for bots. */
  readonly speakerId: string;
  /** Bots only: `bot_profile.name ?? username`, unsanitized. */
  readonly speakerLabel: string | null;
  readonly steeringAllowed: boolean;
  readonly messageTs: string;
  /** Raw Slack markup, capped on insert. For edits, the text after the edit. */
  readonly text: string;
  /** Edits only: the text before the edit; null when it is unknown. */
  readonly previousText: string | null;
}
