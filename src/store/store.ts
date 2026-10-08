/**
 * AgentTagStore is the public facade over the SQLite store. Each domain lives in its own module and
 * owns its SQL and transactions; this class only holds the handle and delegates:
 *
 *   files.ts        open + migrations, backup/restore      tasks.ts        Slack ingest, task bindings
 *   operations.ts   operation leases and outcomes          interactions.ts approvals, cancel, responses
 *   user-input.ts   multi-question user-input answers      outbox.ts       Slack outbox queue
 *   message-edits.ts  chat.update edit/refresh rows (outbox)
 *   schedules.ts    schedules and runs                     memory.ts       memory entries
 *   ambient.ts      ambient trigger decisions              audit.ts        audit log write/export
 *   diagnostics.ts  counts and operational status          lease.ts        shared lease helpers
 *   waits.ts        human waits, expiry, abandoned turns
 *   schema.ts       zod schemas                            types.ts        public types (re-exported)
 */
import type { Database } from "bun:sqlite";

import type { StoreContext } from "./context.ts";
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
  UserInputAnswerResult,
  UserInputQuestionPrompt,
} from "./types.ts";
import * as files from "./files.ts";
import * as audit from "./audit.ts";
import * as memory from "./memory.ts";
import * as schedules from "./schedules.ts";
import * as ambient from "./ambient.ts";
import * as diagnostics from "./diagnostics.ts";
import * as tasks from "./tasks.ts";
import * as operations from "./operations.ts";
import * as interactions from "./interactions.ts";
import * as userInput from "./user-input.ts";
import * as outbox from "./outbox.ts";
import * as messageEdits from "./message-edits.ts";
import * as waits from "./waits.ts";

export { AUDIT_ACTIONS, type AuditAction } from "./schema.ts";
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
  ScheduleSummary,
  SlackEventInput,
  SlackOutboxInput,
  SlackOutboxPayload,
  StoreFaultPoint,
  StoreOpenOptions,
  TaskExecutionBinding,
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
} from "./schedules.ts";
export type { EvaluateAmbientInput } from "./ambient.ts";
export type {
  TaskBelongsToContextInput,
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
  ReleaseOperationInput,
  FailOperationInput,
  FailOperationWithOutboxInput,
  CancelOperationWithOutboxInput,
} from "./operations.ts";
export type {
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
export type {
  EnqueueOutboxResult,
  ClaimNextOutboxInput,
  MarkOutboxDeliveredInput,
  OutboxFailureInput,
  RetryOutboxInput,
  ExhaustOutboxRetriesInput,
} from "./outbox.ts";
export { REFRESH_KINDS } from "./message-edits.ts";
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

  resolveOperationTurnText(input: operations.ResolveOperationTurnTextInput): string {
    return operations.resolveOperationTurnText(this.#database, input);
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

  cancelOperationWithOutbox(input: operations.CancelOperationWithOutboxInput): string {
    return operations.cancelOperationWithOutbox(this.#database, input);
  }

  renewOperationLease(input: operations.RenewOperationLeaseInput): string {
    return operations.renewOperationLease(this.#database, input);
  }

  deferOperation(input: operations.DeferOperationInput): void {
    operations.deferOperation(this.#database, input);
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

  recordPendingInteraction(
    input: interactions.RecordPendingInteractionInput,
  ): interactions.RecordPendingInteractionResult {
    return interactions.recordPendingInteraction(this.#database, input);
  }

  submitInteractionResponse(
    input: interactions.SubmitInteractionResponseInput,
  ): interactions.SubmitInteractionResponseResult {
    return interactions.submitInteractionResponse(this.#database, input);
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
