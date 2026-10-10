/**
 * AgentTagStore is the public facade over the SQLite store. Each domain lives in its own module and
 * owns its SQL and transactions; this class only holds the handle and delegates:
 *
 *   files.ts        open + migrations, backup/restore      tasks.ts        Slack ingest, task bindings
 *   operations.ts   operation leases and outcomes          interactions.ts approvals, cancel, responses
 *   user-input.ts   multi-question user-input answers      outbox.ts       Slack outbox queue
 *   message-edits.ts  chat.update edit/refresh rows (outbox)
 *   interaction-cards.ts  interaction card view, refresh hooks, reconcile
 *   schedules.ts    schedules and runs                     memory.ts       memory entries
 *   ambient.ts      ambient trigger decisions              audit.ts        audit log write/export
 *   diagnostics.ts  counts and operational status          lease.ts        shared lease helpers
 *   waits.ts        human waits, expiry, abandoned turns   schedule-outcomes.ts run outcomes, auto-disable
 *   thread-notes.ts thread context notes (bot, edit, non-allowlisted updates)
 *   pull-requests.ts  task pull requests and draft PR jobs
 *   reactions.ts    Slack reaction queue (instant ack)
 *   schema.ts       zod schemas                            types.ts        public types (re-exported)
 */
import type { Database } from "bun:sqlite";

import type { StoreContext } from "./context.ts";
import type { T3ModelSelection } from "../t3/gateway.ts";
import type {
  ActiveTaskBinding,
  AmbientDecision,
  AuditRecord,
  ClaimedInteractionResponse,
  ClaimedOperation,
  ClaimedOutboxMessage,
  ClaimedSchedule,
  IngestReceipt,
  MemoryRecord,
  OperationalStatus,
  ScheduleSummary,
  SlackEventInput,
  SlackOutboxInput,
  StoreOpenOptions,
  TaskExecutionBinding,
  ThreadNote,
  UserInputAnswerResult,
  UserInputQuestionPrompt,
} from "./types.ts";
import * as files from "./files.ts";
import * as audit from "./audit.ts";
import * as memory from "./memory.ts";
import * as schedules from "./schedules.ts";
import * as scheduleOutcomes from "./schedule-outcomes.ts";
import * as ambient from "./ambient.ts";
import * as diagnostics from "./diagnostics.ts";
import * as tasks from "./tasks.ts";
import * as operations from "./operations.ts";
import * as interactions from "./interactions.ts";
import * as interactionCards from "./interaction-cards.ts";
import * as userInput from "./user-input.ts";
import * as outbox from "./outbox.ts";
import * as messageEdits from "./message-edits.ts";
import * as waits from "./waits.ts";
import * as threadNotes from "./thread-notes.ts";
import * as pullRequests from "./pull-requests.ts";
import * as reactions from "./reactions.ts";

export { AUDIT_ACTIONS, type AuditAction } from "./schema.ts";
export type {
  ClaimedPrSyncJob,
  PrSyncInput,
  PrSyncJobRecord,
  SettlePrSyncJobInput,
  TaskPullRequest,
} from "./pull-requests.ts";
export type {
  ActiveTaskBinding,
  AmbientDecision,
  AuditCursor,
  AuditRecord,
  ClaimedInteractionResponse,
  ClaimedOperation,
  ClaimedOutboxMessage,
  ClaimedSchedule,
  IngestReceipt,
  MemoryRecord,
  OperationalStatus,
  OutboxStatus,
  RefreshKind,
  ScheduleEndedReason,
  ScheduleRunOutcome,
  ScheduleSummary,
  SlackEventInput,
  SlackOutboxInput,
  SlackOutboxPayload,
  StoreFaultPoint,
  StoreOpenOptions,
  TaskExecutionBinding,
  ThreadNote,
  UserInputAnswerResult,
  UserInputQuestionPrompt,
  UserInputSelection,
} from "./types.ts";
export type { StoreDiagnostics } from "./diagnostics.ts";
export type { RestoreBackupInput } from "./files.ts";
export type { ListAuditRecordsInput } from "./audit.ts";
export type {
  CreateMemoryInput,
  ListMemoryInput,
  UpdateMemoryInput,
  ForgetMemoryInput,
  RecordMemoryDenialInput,
} from "./memory.ts";
export type {
  CreateScheduleInput,
  CancelScheduleInput,
  RevokeClaimedScheduleInput,
  ClaimDueScheduleInput,
  SettleScheduleRunInput,
  RecordScheduleDenialInput,
  ScheduleSourceInput,
  ListConversationSchedulesInput,
} from "./schedules.ts";
export type {
  AutoDisabledNoticeInput,
  ReconcileScheduleRunOutcomesInput,
  ReconcileScheduleRunOutcomesResult,
} from "./schedule-outcomes.ts";
export type { EvaluateAmbientInput } from "./ambient.ts";
export type {
  TaskBelongsToContextInput,
  EnsureTaskForThreadInput,
  BindT3TaskInput,
  FindActiveTaskInput,
  MarkT3ThreadStartedInput,
} from "./tasks.ts";
export type {
  ClaimNextOperationInput,
  RenewOperationLeaseInput,
  ResolveOperationTurnTextInput,
  CompleteOperationInput,
  CompleteOperationWithOutboxInput,
  DeferOperationInput,
  MarkOperationTurnDispatchedInput,
  MarkOperationTurnStartedInput,
  ReleaseOperationInput,
  FailOperationInput,
  FailOperationWithOutboxInput,
  CancelOperationWithOutboxInput,
} from "./operations.ts";
export type {
  CancellationDisposition,
  RecordPendingInteractionResult,
  SubmitInteractionResponseResult,
  RequestTaskCancellationResult,
  RecordPendingInteractionInput,
  SubmitInteractionResponseInput,
  RequestTaskCancellationInput,
  ClaimNextInteractionResponseInput,
  CompleteInteractionResponseInput,
  FailInteractionResponseInput,
  QueueTurnInterruptInput,
} from "./interactions.ts";
export type {
  AbandonOperationInput,
  AwaitOperationInteractionsInput,
  AwaitOperationInteractionsResult,
  PendingInteractionRequest,
} from "./waits.ts";
export type { GetPendingUserInputQuestionInput, SubmitUserInputAnswerInput } from "./user-input.ts";
export { RESOLVED_ELSEWHERE } from "./interaction-cards.ts";
export type {
  InteractionCardState,
  InteractionCardView,
  ReconcileThreadInteractionsInput,
} from "./interaction-cards.ts";
export type {
  EnqueueOutboxResult,
  ClaimNextOutboxInput,
  MarkOutboxDeliveredInput,
  OutboxFailureInput,
  RetryOutboxInput,
  ExhaustOutboxRetriesInput,
} from "./outbox.ts";
export { REFRESH_KINDS } from "./message-edits.ts";
export type {
  ClaimedReaction,
  ClaimNextReactionInput,
  ReactionFailureInput,
  RetryReactionInput,
  SettleReactionInput,
} from "./reactions.ts";
export type { EnqueueMessageEditInput, EnqueueMessageRefreshInput, MessageEditResult } from "./message-edits.ts";

export class AgentTagStore {
  readonly #database: Database;
  readonly #context: StoreContext;

  private constructor(database: Database, options: StoreOpenOptions) {
    this.#database = database;
    this.#context = { database, faultInjector: options.faultInjector ?? (() => {}) };
  }

  static async open(path: string, options: StoreOpenOptions = {}): Promise<AgentTagStore> {
    return new AgentTagStore(await files.openDatabase(path), options);
  }

  close(): void {
    this.#database.close();
  }

  backupTo(path: string): Promise<void> {
    return files.backupTo(this.#database, path);
  }

  static restoreBackup(input: files.RestoreBackupInput): Promise<void> {
    return files.restoreBackup(input);
  }

  listAuditRecords(input: audit.ListAuditRecordsInput = {}): ReadonlyArray<AuditRecord> {
    return audit.listAuditRecords(this.#database, input);
  }

  createMemory(input: memory.CreateMemoryInput): MemoryRecord {
    return memory.createMemory(this.#database, input);
  }

  getMemory(memoryId: string): MemoryRecord | null {
    return memory.getMemory(this.#database, memoryId);
  }

  listMemory(input: memory.ListMemoryInput): ReadonlyArray<MemoryRecord> {
    return memory.listMemory(this.#database, input);
  }

  updateMemory(input: memory.UpdateMemoryInput): MemoryRecord {
    return memory.updateMemory(this.#database, input);
  }

  forgetMemory(input: memory.ForgetMemoryInput): void {
    memory.forgetMemory(this.#database, input);
  }

  expireMemory(nowInput: string): number {
    return memory.expireMemory(this.#database, nowInput);
  }

  taskBelongsToContext(input: tasks.TaskBelongsToContextInput): boolean {
    return tasks.taskBelongsToContext(this.#database, input);
  }

  recordMemoryDenial(input: memory.RecordMemoryDenialInput): void {
    memory.recordMemoryDenial(this.#database, input);
  }

  peekResolvedTurnText(input: operations.PeekResolvedTurnTextInput): string | null {
    return operations.peekResolvedTurnText(this.#database, input);
  }

  peekOperationTurnModel(input: operations.PeekResolvedTurnTextInput): operations.OperationTurnModel | null {
    return operations.peekOperationTurnModel(this.#database, input);
  }

  resolveOperationTurnModel(input: operations.ResolveOperationTurnModelInput): operations.OperationTurnModel {
    return operations.resolveOperationTurnModel(this.#database, input);
  }

  resolveOperationTurnText(input: operations.ResolveOperationTurnTextInput): string {
    return operations.resolveOperationTurnText(this.#database, input);
  }

  recordThreadContextAudit(input: operations.RecordThreadContextAuditInput): void {
    operations.recordThreadContextAudit(this.#database, input);
  }

  recordThreadNote(input: threadNotes.RecordThreadNoteInput): threadNotes.RecordThreadNoteResult {
    return threadNotes.recordThreadNote(this.#database, input);
  }

  listPendingThreadNotes(taskId: string, limit?: number): ThreadNote[] {
    return threadNotes.listPendingThreadNotes(this.#database, taskId, limit);
  }

  findIngestedText(workspaceId: string, eventKey: string): string | null {
    return threadNotes.findIngestedText(this.#database, workspaceId, eventKey);
  }

  countActiveSchedules(workspaceId: string): number {
    return schedules.countActiveSchedules(this.#database, workspaceId);
  }

  createSchedule(input: schedules.CreateScheduleInput): ScheduleSummary {
    return schedules.createSchedule(this.#database, input);
  }

  listSchedules(taskId: string): ReadonlyArray<ScheduleSummary> {
    return schedules.listSchedules(this.#database, taskId);
  }

  getSchedule(scheduleId: string): ScheduleSummary | null {
    return schedules.getSchedule(this.#database, scheduleId);
  }

  findScheduleBySourceEvent(input: {
    readonly workspaceId: string;
    readonly sourceEventKey: string;
  }): ScheduleSummary | null {
    return schedules.findScheduleBySourceEvent(this.#database, input);
  }

  listActiveSchedulesForConversation(
    input: schedules.ListConversationSchedulesInput,
  ): ReadonlyArray<ScheduleSummary> {
    return schedules.listActiveSchedulesForConversation(this.#database, input);
  }

  /** Records finished runs' outcomes and auto-disables recurring schedules that keep failing. */
  reconcileScheduleRunOutcomes(
    input: scheduleOutcomes.ReconcileScheduleRunOutcomesInput,
  ): scheduleOutcomes.ReconcileScheduleRunOutcomesResult {
    return scheduleOutcomes.reconcileScheduleRunOutcomes(this.#context, input);
  }

  cancelSchedule(input: schedules.CancelScheduleInput): boolean {
    return schedules.cancelSchedule(this.#database, input);
  }

  revokeClaimedSchedule(input: schedules.RevokeClaimedScheduleInput): void {
    schedules.revokeClaimedSchedule(this.#database, input);
  }

  claimDueSchedule(input: schedules.ClaimDueScheduleInput): ClaimedSchedule | null {
    return schedules.claimDueSchedule(this.#database, input);
  }

  hasOpenScheduleOperation(scheduleId: string): boolean {
    return schedules.hasOpenScheduleOperation(this.#database, scheduleId);
  }

  settleScheduleRun(input: schedules.SettleScheduleRunInput): void {
    schedules.settleScheduleRun(this.#database, input);
  }

  recordScheduleDenial(input: schedules.RecordScheduleDenialInput): void {
    schedules.recordScheduleDenial(this.#database, input);
  }

  evaluateAmbient(input: ambient.EvaluateAmbientInput): AmbientDecision {
    return ambient.evaluateAmbient(this.#database, input);
  }

  /** The task bound to a Slack thread, created if needed, without creating an operation. */
  ensureTaskForThread(input: tasks.EnsureTaskForThreadInput): string {
    return tasks.ensureTaskForThread(this.#database, input);
  }

  ingestSlackEvent(input: SlackEventInput): IngestReceipt {
    return tasks.ingestSlackEvent(this.#context, input);
  }

  claimNextOperation(input: operations.ClaimNextOperationInput): ClaimedOperation | null {
    return operations.claimNextOperation(this.#context, input);
  }

  completeOperation(input: operations.CompleteOperationInput): void {
    operations.completeOperation(this.#database, input);
  }

  completeOperationWithOutbox(input: operations.CompleteOperationWithOutboxInput): string {
    return operations.completeOperationWithOutbox(this.#database, input);
  }

  getTaskPullRequest(taskId: string): pullRequests.TaskPullRequest | null {
    return pullRequests.getTaskPullRequest(this.#database, taskId);
  }

  listPrSyncJobs(taskId: string): readonly pullRequests.PrSyncJobRecord[] {
    return pullRequests.listPrSyncJobs(this.#database, taskId);
  }

  claimNextPrSyncJob(input: Parameters<typeof pullRequests.claimNextPrSyncJob>[1]): pullRequests.ClaimedPrSyncJob | null {
    return pullRequests.claimNextPrSyncJob(this.#database, input);
  }

  renewPrSyncJobLease(input: Parameters<typeof pullRequests.renewPrSyncJobLease>[1]): void {
    pullRequests.renewPrSyncJobLease(this.#database, input);
  }

  recordPrSyncPushed(input: Parameters<typeof pullRequests.recordPrSyncPushed>[1]): void {
    pullRequests.recordPrSyncPushed(this.#database, input);
  }

  settlePrSyncJob(input: pullRequests.SettlePrSyncJobInput): string | null {
    return pullRequests.settlePrSyncJob(this.#database, input);
  }

  retryPrSyncJob(input: Parameters<typeof pullRequests.retryPrSyncJob>[1]): void {
    pullRequests.retryPrSyncJob(this.#database, input);
  }

  releasePrSyncJob(input: Parameters<typeof pullRequests.releasePrSyncJob>[1]): void {
    pullRequests.releasePrSyncJob(this.#database, input);
  }

  cancelOperationWithOutbox(input: operations.CancelOperationWithOutboxInput): string {
    return operations.cancelOperationWithOutbox(this.#database, input);
  }

  renewOperationLease(input: operations.RenewOperationLeaseInput): string {
    return operations.renewOperationLease(this.#database, input);
  }

  deferOperation(input: operations.DeferOperationInput): void {
    operations.deferOperation(this.#database, input);
  }

  /** Records that `thread.turn.start` is about to be sent, before its outcome is known. */
  markOperationTurnDispatched(input: operations.MarkOperationTurnDispatchedInput): void {
    operations.markOperationTurnDispatched(this.#database, input);
  }

  /** Records that the operation's T3 turn was dispatched (and its turn id once known). */
  markOperationTurnStarted(input: operations.MarkOperationTurnStartedInput): void {
    operations.markOperationTurnStarted(this.#database, input);
  }

  /**
   * Returns an in-progress operation to the queue without counting the attempt, e.g. on service
   * shutdown. The stable command and message ids let the next owner resume the same T3 turn.
   */
  releaseOperation(input: operations.ReleaseOperationInput): boolean {
    return operations.releaseOperation(this.#database, input);
  }

  failOperation(input: operations.FailOperationInput): void {
    operations.failOperation(this.#database, input);
  }

  failOperationWithOutbox(input: operations.FailOperationWithOutboxInput): string {
    return operations.failOperationWithOutbox(this.#database, input);
  }

  /**
   * Decides, atomically with any concurrent Slack response, whether a turn blocked on approvals or
   * questions keeps polling (all answered), defers until the earliest expiry, or expires.
   */
  awaitOperationInteractions(input: waits.AwaitOperationInteractionsInput): waits.AwaitOperationInteractionsResult {
    return waits.awaitOperationInteractions(this.#database, input);
  }

  /** Fails a leased operation with a Slack notice and queues a durable interrupt of its T3 turn. */
  abandonOperation(input: waits.AbandonOperationInput): string {
    return waits.abandonOperation(this.#database, input);
  }

  bindT3Task(input: tasks.BindT3TaskInput): void {
    tasks.bindT3Task(this.#database, input);
  }

  findActiveTask(input: tasks.FindActiveTaskInput): ActiveTaskBinding | null {
    return tasks.findActiveTask(this.#database, input);
  }

  getTaskExecution(taskIdInput: string): TaskExecutionBinding {
    return tasks.getTaskExecution(this.#database, taskIdInput);
  }

  markT3ThreadStarted(input: tasks.MarkT3ThreadStartedInput): void {
    tasks.markT3ThreadStarted(this.#database, input);
  }

  setTaskModelSelection(input: tasks.SetTaskModelSelectionInput): void {
    tasks.setTaskModelSelection(this.#database, input);
  }

  recordAppliedModelSelection(input: tasks.RecordAppliedModelSelectionInput): boolean {
    return tasks.recordAppliedModelSelection(this.#database, input);
  }

  revertDesiredModelSelection(input: tasks.RevertDesiredModelSelectionInput): tasks.ModelRevert | null {
    return tasks.revertDesiredModelSelection(this.#database, input);
  }

  recordModelRejection(input: tasks.RecordModelRejectionInput): boolean {
    return tasks.recordModelRejection(this.#database, input);
  }

  clearInvalidModelSelection(input: tasks.ClearInvalidModelSelectionInput): readonly tasks.TaskModelColumn[] {
    return tasks.clearInvalidModelSelection(this.#database, input);
  }

  recordPendingInteraction(
    input: interactions.RecordPendingInteractionInput,
  ): interactions.RecordPendingInteractionResult {
    return interactions.recordPendingInteraction(this.#database, input);
  }

  /** The interaction card's current state (null for cancels and unknown ids); read at delivery time. */
  getInteractionCardView(interactionId: string): interactionCards.InteractionCardView | null {
    return interactionCards.getInteractionCardView(this.#database, interactionId);
  }

  /** Closes pending approvals/questions of the thread that T3 no longer reports (resolved outside Slack). */
  reconcileThreadInteractions(input: interactionCards.ReconcileThreadInteractionsInput): number {
    return interactionCards.reconcileThreadInteractions(this.#database, input);
  }

  submitInteractionResponse(
    input: interactions.SubmitInteractionResponseInput,
  ): interactions.SubmitInteractionResponseResult {
    return interactions.submitInteractionResponse(this.#database, input);
  }

  /** The response command id when the actor's user-input form in this thread is no longer pending. */
  handledUserInputCommandId(input: Omit<userInput.GetPendingUserInputQuestionInput, "questionId">): string | null {
    return userInput.handledUserInputCommandId(this.#database, input);
  }

  /** Returns one question of a still-pending user-input request when the actor may answer it. */
  getPendingUserInputQuestion(
    input: userInput.GetPendingUserInputQuestionInput,
  ): UserInputQuestionPrompt | null {
    return userInput.getPendingUserInputQuestion(this.#database, input);
  }

  /**
   * Durably records the answer to one question of a multi-question user-input request. The full
   * response is queued for T3 only once every question has an answer; until then each answer is kept
   * in `partial_response_json` and acknowledged in the Slack thread.
   */
  submitUserInputAnswer(input: userInput.SubmitUserInputAnswerInput): UserInputAnswerResult {
    return userInput.submitUserInputAnswer(this.#database, input);
  }

  /**
   * Interrupts the task's current operation only if it started a T3 turn; an operation still queued
   * with no T3 turn is cancelled in the store and never reaches T3.
   */
  requestTaskCancellation(
    input: interactions.RequestTaskCancellationInput,
  ): interactions.RequestTaskCancellationResult {
    return interactions.requestTaskCancellation(this.#database, input);
  }

  claimNextInteractionResponse(
    input: interactions.ClaimNextInteractionResponseInput,
  ): ClaimedInteractionResponse | null {
    return interactions.claimNextInteractionResponse(this.#database, input);
  }

  answeredOperationQuestions(operationId: string): ReadonlySet<string> {
    return interactions.answeredOperationQuestions(this.#database, operationId);
  }

  checkInteractionDispatch(
    input: interactions.CheckInteractionDispatchInput,
  ): interactions.CheckInteractionDispatchResult {
    return interactions.checkInteractionDispatch(this.#database, input);
  }

  completeInteractionResponse(input: interactions.CompleteInteractionResponseInput): void {
    interactions.completeInteractionResponse(this.#database, input);
  }

  failInteractionResponse(input: interactions.FailInteractionResponseInput): void {
    interactions.failInteractionResponse(this.#database, input);
  }

  enqueueOutbox(input: SlackOutboxInput): outbox.EnqueueOutboxResult {
    return outbox.enqueueOutbox(this.#context, input);
  }

  /** Ensures one pending delivery-time re-render of a posted message (see message-edits.ts). */
  enqueueMessageRefresh(input: messageEdits.EnqueueMessageRefreshInput): messageEdits.MessageEditResult {
    return this.#database.transaction(() => messageEdits.enqueueMessageRefresh(this.#database, input)).immediate();
  }

  /** Ensures the posted message is edited to `payload`; coalesces with a pending edit of it. */
  enqueueMessageEdit(input: messageEdits.EnqueueMessageEditInput): messageEdits.MessageEditResult {
    return this.#database.transaction(() => messageEdits.enqueueMessageEdit(this.#database, input)).immediate();
  }

  claimNextOutbox(input: outbox.ClaimNextOutboxInput): ClaimedOutboxMessage | null {
    return outbox.claimNextOutbox(this.#context, input);
  }

  claimNextReaction(input: reactions.ClaimNextReactionInput): reactions.ClaimedReaction | null {
    return reactions.claimNextReaction(this.#context, input);
  }

  markReactionDelivered(input: reactions.SettleReactionInput & { readonly errorCode?: string }): void {
    reactions.markReactionDelivered(this.#database, input);
  }

  failReaction(input: reactions.ReactionFailureInput): void {
    reactions.failReaction(this.#database, input);
  }

  retryReaction(input: reactions.RetryReactionInput): void {
    reactions.retryReaction(this.#database, input);
  }

  markOutboxDelivered(input: outbox.MarkOutboxDeliveredInput): void {
    outbox.markOutboxDelivered(this.#database, input);
  }

  /** Terminal failure (deterministic Slack rejection or revoked authority). */
  failOutbox(input: outbox.OutboxFailureInput): void {
    outbox.failOutbox(this.#database, input);
  }

  /** Known-not-delivered failure: requeue, claimable again from `blockedUntil`. */
  retryOutbox(input: outbox.RetryOutboxInput): void {
    outbox.retryOutbox(this.#database, input);
  }

  /** Retryable failure on the last allowed attempt: fail with a retry-exhausted audit row. */
  exhaustOutboxRetries(input: outbox.ExhaustOutboxRetriesInput): void {
    outbox.exhaustOutboxRetries(this.#database, input);
  }

  /** Ambiguous failure: the message may have been posted, so never resend it automatically. */
  quarantineOutbox(input: outbox.OutboxFailureInput): void {
    outbox.quarantineOutbox(this.#database, input);
  }

  /** Requeue once as plain escaped text after Slack rejected the rich payload. */
  scheduleOutboxFallback(input: outbox.OutboxFailureInput): void {
    outbox.scheduleOutboxFallback(this.#database, input);
  }

  quarantineExpiredOutbox(nowInput: string): number {
    return outbox.quarantineExpiredOutbox(this.#database, nowInput);
  }

  diagnostics(): diagnostics.StoreDiagnostics {
    return diagnostics.diagnostics(this.#database);
  }

  operationalStatus(nowInput: string): OperationalStatus {
    return diagnostics.operationalStatus(this.#database, nowInput);
  }
}
