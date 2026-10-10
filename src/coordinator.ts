import type { AgentTagConfig, AgentTagProfile, AgentTagRoute } from "./config.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "./policy/execution.ts";
import { allowedChoices, effectiveSelection, planSwitch, type ModelChoice } from "./policy/models.ts";
import { AgentTagMemory } from "./memory.ts";
import type { SlackContextSource } from "./slack/context-source.ts";
import { fetchThreadWindow, SlackContextUnavailable, THREAD_CONTEXT_TIMEOUT_MS } from "./slack/context.ts";
import { collectMentionedUserIds, type SpeakerIdentity } from "./slack/markup.ts";
import { escapeSlackText, markdownToMrkdwn, renderCodeBlock, splitForSlack, truncateBlockText } from "./slack/render.ts";
import { slackErrorCode, unresolvedSpeaker } from "./slack/users.ts";
import type { AgentTagStore, ClaimedOperation, SlackOutboxPayload, TaskExecutionBinding } from "./store/store.ts";
import { composeTurnText, type TurnWindow } from "./turn-text.ts";
import {
  awaitingT3AnswerContinuation,
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  pendingT3Approvals,
  pendingT3UserInputs,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
  type T3ModelSelection,
  type T3PendingApproval,
  type T3PendingUserInput,
  type T3ServerInfo,
  type T3ThreadSnapshot,
  threadModelSelectionCommand,
} from "./t3/gateway.ts";
import type { ThreadWatch, ThreadWatchSource } from "./t3/watcher.ts";

export interface T3CoordinatorGateway {
  /** Implementations should stop the RPC (closing its socket) when `signal` aborts. */
  readonly dispatch: (command: T3Command, signal?: AbortSignal) => Promise<T3DispatchResult>;
  readonly fetchThread: (threadId: string, signal?: AbortSignal) => Promise<T3ThreadSnapshot>;
}

export type CoordinatorOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "completed"; readonly operationId: string; readonly outboxId: string }
  | { readonly kind: "cancelled"; readonly operationId: string; readonly outboxId: string }
  | {
      readonly kind: "waiting-interaction";
      readonly operationId: string;
      readonly threadId: string;
      readonly approvalCount: number;
      readonly questionCount: number;
    }
  | { readonly kind: "expired"; readonly operationId: string; readonly outboxId: string }
  | { readonly kind: "retry-scheduled"; readonly operationId: string; readonly errorCode: string }
  | { readonly kind: "released"; readonly operationId: string }
  | { readonly kind: "failed"; readonly operationId: string; readonly outboxId: string; readonly errorCode: string };

/** When this claim started polling its T3 turn (null until dispatched), and its thread watch if any. */
interface TurnPolling {
  startedAt: number | null;
  watch: ThreadWatch | null;
}

/** The T3 provider catalog as the coordinator needs it (`ProviderCatalog` in production). */
export interface CoordinatorProviderCatalog {
  /** The snapshot, or null when there is none or it is stale. */
  readonly current: () => T3ServerInfo | null;
  /** Re-reads the catalog; resolves false on failure. */
  readonly refresh: (signal?: AbortSignal) => Promise<boolean>;
}

/** Budget for refreshing a stale catalog before planning a model switch. */
const CATALOG_REFRESH_BUDGET_MS = 3_000;

export interface CoordinatorOptions {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly t3?: T3CoordinatorGateway;
  readonly memory?: AgentTagMemory;
  /** Provider catalog for planning model switches on started threads. Absent means unknown (fail closed). */
  readonly catalog?: CoordinatorProviderCatalog;
  /** Wall-clock budget for refreshing a stale catalog before planning a switch. Defaults to 3s. */
  readonly catalogRefreshBudgetMs?: number;
  /** Slack reads for speaker labels. Absent (tests, legacy) means speakers render as raw IDs. */
  readonly slackContext?: SlackContextSource;
  /** Turn-wide wall-clock budget for speaker lookups. Defaults to min(5s, lease / 4). */
  readonly speakerLookupBudgetMs?: number;
  /** Wall-clock budget for reading the thread window. Defaults to min(8s, lease / 3). */
  readonly threadContextBudgetMs?: number;
  readonly workerId?: string;
  readonly leaseMs?: number;
  /** Poll interval without a watcher, and while a snapshot lags an event the watcher already saw. */
  readonly pollMs?: number;
  /** Wakes the wait loop on T3 thread events instead of polling every `pollMs`. */
  readonly watcher?: ThreadWatchSource;
  /** Longest wait for a watcher wake-up before re-reading the snapshot. Defaults to `t3.watch.safetyPollMs`. */
  readonly safetyPollMs?: number;
  /** No-progress window before a turn counts as stalled. Defaults to `stalledTurn.timeoutSeconds`. */
  readonly stallMs?: number;
  /** Absolute ceiling on a turn's active polling time. Defaults to `stalledTurn.maxTurnSeconds`. */
  readonly maxTurnMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Upper bound on distinct users resolved for one turn; the rest render as raw IDs. */
const MAX_TURN_SPEAKER_IDS = 50;

function defaultT3Gateway(config: T3ConnectionConfig): T3CoordinatorGateway {
  return {
    dispatch: (command, signal) =>
      dispatchT3Command({ config, command, ...(signal === undefined ? {} : { signal }) }),
    fetchThread: (threadId, signal) =>
      fetchT3ThreadSnapshot({ config, threadId, ...(signal === undefined ? {} : { signal }) }),
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "T3CoordinatorError";
}

class CoordinatorFailure extends Error {
  readonly userMessage: string;

  constructor(code: string, userMessage: string) {
    super(code);
    this.name = code;
    this.userMessage = userMessage;
  }
}

class CoordinatorAborted extends Error {
  constructor() {
    super("coordinator processing was aborted");
    this.name = "CoordinatorAborted";
  }
}

/** Settles with the promise, or rejects as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new CoordinatorAborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CoordinatorAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class T3TurnStalled extends Error {
  constructor() {
    super("T3 reported no progress for the configured stall window");
    this.name = "T3TurnStalled";
  }
}

/**
 * Everything in a snapshot that changes while this thread's turn works: activity and message
 * counts, the newest activity sequence and activity/message timestamp, streamed text length, and
 * turn/session state. A turn whose marker stops changing for the stall window is stalled.
 * `snapshotSequence` is excluded: T3 reports its global read-model sequence there, which other
 * threads' events advance while this turn is stuck.
 */
export function t3ProgressMarker(snapshot: T3ThreadSnapshot): string {
  const thread = snapshot.thread;
  let latestMs = 0;
  let latestSequence = 0;
  let textLength = 0;
  for (const activity of thread.activities) {
    latestMs = Math.max(latestMs, Date.parse(activity.createdAt));
    latestSequence = Math.max(latestSequence, activity.sequence ?? 0);
  }
  for (const message of thread.messages) {
    latestMs = Math.max(latestMs, Date.parse(message.updatedAt));
    textLength += message.text.length;
  }
  return JSON.stringify([
    thread.activities.length,
    latestSequence,
    thread.messages.length,
    latestMs,
    textLength,
    thread.latestTurn?.turnId ?? null,
    thread.latestTurn?.state ?? null,
    thread.session?.status ?? null,
    thread.session?.updatedAt ?? null,
  ]);
}

/** Renders a configured duration for Slack, e.g. 86400 -> "24 hours". */
export function describeDuration(seconds: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/**
 * Maps T3's free-text `session.lastError` to a stable failure code and a sanitized Slack message.
 * Provider diagnostic text never reaches Slack; operators read the code in audit and status output.
 */
export function classifyT3TurnFailure(
  lastError: string | null | undefined,
  context: { readonly currentModel?: string } = {},
): {
  readonly code: string;
  readonly userMessage: string;
} {
  const detail = lastError?.toLowerCase() ?? "";
  // T3 0.0.45 refusing to move a started thread to another model (ProviderCommandReactor). Not
  // retryable: the same selection would be refused again.
  if (
    [
      "cannot switch models after the conversation has started",
      "cannot switch to '",
      "is bound to driver",
      "provider resume state is incompatible",
    ].some((term) => detail.includes(term))
  ) {
    const current = context.currentModel === undefined ? "its current model" : `*${escapeSlackText(context.currentModel)}*`;
    return {
      code: "T3ModelSwitchRejected",
      userMessage:
        `T3 refused to move this thread to the requested model; it stays on ${current}. Start a new thread to use a different provider.`,
    };
  }
  // Claude subscription (OAuth) login blocked by the Anthropic organization's policy: HTTP 403
  // `oauth_not_allowed_for_organization`. Retrying cannot help; the operator must switch credentials.
  if (["oauth_not_allowed_for_organization", "oauth authentication is currently not allowed"].some((term) => detail.includes(term))) {
    return {
      code: "T3ProviderAuthPolicy",
      userMessage:
        "Agent Tag could not run this request because the provider's organization does not allow this login method (for Claude, subscription OAuth is disabled by organization policy). Ask the operator to configure an organization-approved credential, such as an API key, then retry.",
    };
  }
  if (["could not authenticate", "authentication_failed", "authentication_error", "invalid api key", "invalid x-api-key", "not logged in", "please run /login"].some((term) => detail.includes(term))) {
    return {
      code: "T3ProviderAuth",
      userMessage:
        "Agent Tag could not run this request because the configured provider is not authenticated on the T3 host. Ask the operator to sign the provider in again, then retry.",
    };
  }
  if (["usage limit", "rate limit", "quota", "credits"].some((term) => detail.includes(term))) {
    return {
      code: "T3ProviderLimit",
      userMessage:
        "Agent Tag could not start this request because the configured provider has reached its usage limit. Ask the operator to configure an organization-approved provider, then retry.",
    };
  }
  return {
    code: "T3TurnError",
    userMessage:
      "Agent Tag could not complete this request because T3 reported a provider or runtime error. Ask the operator to inspect service diagnostics.",
  };
}

export { T3_TURN_ENDED_FAILURE_CODES } from "./store/interactions.ts";

/**
 * T3 reports a turn start it refused (a model switch, an unknown provider) asynchronously: the
 * dispatch succeeds, then a `provider.turn.start.failed` activity names the message. Returns its
 * detail, or null when this message's start has not failed.
 */
function turnStartFailureDetail(snapshot: T3ThreadSnapshot, messageId: string): string | null {
  for (const activity of snapshot.thread.activities) {
    if (activity.kind !== "provider.turn.start.failed") continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const { requestId, detail } = payload as { readonly requestId?: unknown; readonly detail?: unknown };
    if (requestId === messageId) return typeof detail === "string" ? detail : "";
  }
  return null;
}

function sameSelection(left: T3ModelSelection, right: T3ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function modelChoice(profile: AgentTagProfile, route: AgentTagRoute | undefined, selection: T3ModelSelection): ModelChoice {
  return allowedChoices(profile, route).find((choice) => sameSelection(choice, selection)) ?? {
    instanceId: selection.instanceId,
    model: selection.model,
    label: selection.model,
    aliases: [],
    source: "allowed",
  };
}

function modelLabel(profile: AgentTagProfile, route: AgentTagRoute | undefined, selection: T3ModelSelection): string {
  return modelChoice(profile, route, selection).label;
}

/** The selection a turn carries, and what the coordinator must do once T3 accepts or rejects it. */
interface TurnModel {
  readonly selection: T3ModelSelection;
  /** What T3 had accepted before this turn (null for a new thread). */
  readonly previous: T3ModelSelection | null;
  /** A `thread.meta.update` moved the thread's projected selection for this turn. */
  readonly movedThread: boolean;
}

function snapshotHasCurrentTurn(snapshot: T3ThreadSnapshot, messageId: string): boolean {
  const userMessage = snapshot.thread.messages.find((message) => message.id === messageId && message.role === "user");
  const latestTurn = snapshot.thread.latestTurn;
  return userMessage !== undefined && latestTurn !== null &&
    new Date(latestTurn.requestedAt).getTime() >= new Date(userMessage.createdAt).getTime();
}

export function approvalMessage(interactionId: string, approval: T3PendingApproval): SlackOutboxPayload {
  const detail = approval.detail === undefined
    ? "The agent requested permission."
    : approval.detail.includes("\n")
    ? renderCodeBlock(approval.detail)
    : escapeSlackText(approval.detail);
  return {
    text: truncateBlockText(`Approval required: ${escapeSlackText(approval.requestKind)}`),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateBlockText(`*Approval required* · ${escapeSlackText(approval.requestKind)}\n${detail}`),
        },
      },
      {
        type: "actions",
        block_id: `agent-tag:${interactionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "agent-tag.approval.accept",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: "agent-tag.approval.decline",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel request" },
            action_id: "agent-tag.approval.cancel",
            value: interactionId,
          },
        ],
      },
    ],
  };
}

function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Renders every question of a T3 user-input request. Single-select options are buttons; multi-select
 * and free-text answers open a modal. Answers are collected per question and sent to T3 once complete.
 */
export function questionMessage(interactionId: string, request: T3PendingUserInput): SlackOutboxPayload {
  if (request.questions.length === 0) throw new Error("T3 user-input request has no questions");
  type SlackBlock = NonNullable<SlackOutboxPayload["blocks"]>[number];
  type SlackActionsBlock = Extract<SlackBlock, { readonly type: "actions" }>;
  const total = request.questions.length;
  const blocks: SlackBlock[] = [];
  if (total > 1) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*The agent has ${total} questions.* Answer each one; the replies are sent together once all are answered.`,
      },
    });
  }
  request.questions.forEach((question, index) => {
    const customAllowed = question.options.length === 0 || question.allowCustomAnswer !== false;
    const optionLines =
      question.multiSelect || question.options.some((option) => option.description !== undefined)
        ? question.options.map((option) =>
            `• ${escapeSlackText(option.label)}${option.description === undefined ? "" : ` — ${escapeSlackText(option.description)}`}`,
          )
        : [];
    const prefix = total > 1 ? `${index + 1}/${total} · ` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateBlockText(
          [`*${prefix}${escapeSlackText(question.header)}*`, escapeSlackText(question.question), ...optionLines].join("\n"),
        ),
      },
    });
    const elements: SlackActionsBlock["elements"] = question.multiSelect
      ? []
      : question.options.slice(0, 24).map((option, optionIndex) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: truncateText(option.label, 75) },
          action_id: "agent-tag.user-input.answer",
          value: JSON.stringify({ interactionId, questionId: question.id, optionIndex }),
        }));
    const needsModal = (question.multiSelect && question.options.length > 0) || customAllowed;
    if (needsModal) {
      elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: question.multiSelect && question.options.length > 0
            ? "Choose options"
            : question.options.length > 0 ? "Other answer" : "Type answer",
        },
        action_id: "agent-tag.user-input.open",
        value: JSON.stringify({ interactionId, questionId: question.id }),
      });
    }
    if (elements.length > 0) {
      blocks.push({ type: "actions", block_id: `agent-tag:${interactionId}:q${index}`, elements });
    }
  });
  if (request.dismissible) {
    blocks.push({
      type: "actions",
      block_id: `agent-tag:${interactionId}:dismiss`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss" },
          action_id: "agent-tag.user-input.dismiss",
          value: interactionId,
        },
      ],
    });
  }
  const first = request.questions[0];
  return {
    text: total === 1 && first !== undefined
      ? truncateBlockText(`Question from the agent: ${escapeSlackText(first.question)}`)
      : truncateBlockText(`The agent has ${total} questions: ${request.questions.map((question) => escapeSlackText(question.question)).join(" / ")}`),
    blocks,
  };
}

export class AgentTagCoordinator {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #t3: T3CoordinatorGateway;
  readonly #memory: AgentTagMemory;
  readonly #catalog: CoordinatorProviderCatalog | null;
  readonly #catalogRefreshBudgetMs: number;
  readonly #slackContext: SlackContextSource | undefined;
  readonly #speakerLookupBudgetMs: number;
  readonly #threadContextBudgetMs: number;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #pollMs: number;
  readonly #watcher: ThreadWatchSource | null;
  readonly #safetyPollMs: number;
  readonly #stallMs: number;
  readonly #maxTurnMs: number;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CoordinatorOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#t3 = options.t3 ?? defaultT3Gateway(options.config.t3);
    this.#memory = options.memory ?? new AgentTagMemory({ config: options.config, store: options.store });
    this.#catalog = options.catalog ?? null;
    this.#catalogRefreshBudgetMs = options.catalogRefreshBudgetMs ?? CATALOG_REFRESH_BUDGET_MS;
    this.#slackContext = options.slackContext;
    this.#workerId = options.workerId ?? `t3-worker-${crypto.randomUUID()}`;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#speakerLookupBudgetMs = options.speakerLookupBudgetMs ?? Math.min(5_000, Math.floor(this.#leaseMs / 4));
    this.#threadContextBudgetMs = options.threadContextBudgetMs
      ?? Math.min(THREAD_CONTEXT_TIMEOUT_MS, Math.floor(this.#leaseMs / 3));
    this.#pollMs = options.pollMs ?? 500;
    this.#watcher = options.watcher ?? null;
    this.#safetyPollMs = options.safetyPollMs ?? options.config.t3.watch.safetyPollMs;
    this.#stallMs = options.stallMs ?? options.config.limits.stalledTurn.timeoutSeconds * 1_000;
    this.#maxTurnMs = options.maxTurnMs ?? options.config.limits.stalledTurn.maxTurnSeconds * 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  /**
   * Claims and drives one operation. When `signal` aborts (service shutdown), in-flight T3 calls and
   * polling stop promptly and the lease is released so the operation resumes after restart.
   */
  async processNext(signal?: AbortSignal): Promise<CoordinatorOutcome> {
    if (signal?.aborted) return { kind: "idle" };
    const operation = this.#store.claimNextOperation({
      workerId: this.#workerId,
      now: this.#now().toISOString(),
      leaseMs: this.#leaseMs,
      maxConcurrentTasks: this.#config.limits.maxConcurrentTasks,
    });
    if (operation === null) return { kind: "idle" };

    // Active polling time is persisted whenever the claim ends, not only on lease renewal, so short
    // attempts, retries and shutdowns cannot keep the turn ceiling from accumulating.
    const polling: TurnPolling = { startedAt: null, watch: null };
    const turnActiveMs = () =>
      polling.startedAt === null ? undefined : operation.turnActiveMs + (this.#now().getTime() - polling.startedAt);
    try {
      return await this.#run(operation, signal, polling);
    } catch (error) {
      if (signal?.aborted) {
        this.#store.releaseOperation({
          operationId: operation.operationId,
          workerId: this.#workerId,
          now: this.#now().toISOString(),
          turnActiveMs: turnActiveMs(),
        });
        return { kind: "released", operationId: operation.operationId };
      }
      const stalledTurn = this.#config.limits.stalledTurn;
      if (error instanceof T3TurnStalled && operation.attempt < stalledTurn.maxAttempts) {
        const now = this.#now();
        this.#store.failOperation({
          operationId: operation.operationId,
          workerId: this.#workerId,
          errorCode: error.name,
          retryable: true,
          blockedUntil: new Date(now.getTime() + stalledTurn.retryDelaySeconds * 1_000).toISOString(),
          now: now.toISOString(),
          turnActiveMs: turnActiveMs(),
        });
        return { kind: "retry-scheduled", operationId: operation.operationId, errorCode: error.name };
      }
      if (
        !(error instanceof CoordinatorFailure) &&
        !(error instanceof T3TurnStalled) &&
        !(error instanceof ExecutionAuthorityDenied) &&
        operation.attempt < 5
      ) {
        const now = this.#now();
        this.#store.failOperation({
          operationId: operation.operationId,
          workerId: this.#workerId,
          errorCode: errorCode(error),
          retryable: true,
          blockedUntil: new Date(now.getTime() + 1_000 * 2 ** (operation.attempt - 1)).toISOString(),
          now: now.toISOString(),
          turnActiveMs: turnActiveMs(),
        });
        return { kind: "retry-scheduled", operationId: operation.operationId, errorCode: errorCode(error) };
      }
      const failure = error instanceof T3TurnStalled
        ? new CoordinatorFailure(
            error.name,
            `Agent Tag could not confirm completion: T3 reported no progress for ${describeDuration(stalledTurn.timeoutSeconds)} on each of ${stalledTurn.maxAttempts} attempts. Ask the operator to inspect T3 before retrying.`,
          )
        : error instanceof ExecutionAuthorityDenied
        ? new CoordinatorFailure(
            error.name,
            "Agent Tag stopped this request because the current access configuration no longer authorizes it. Ask the operator to review the task route and access policy.",
          )
        : error instanceof CoordinatorFailure
        ? error
        : new CoordinatorFailure(
            errorCode(error),
            "Agent Tag could not complete this request after repeated service errors. Ask the operator to inspect service diagnostics.",
          );
      const outboxId = this.#store.failOperationWithOutbox({
        operationId: operation.operationId,
        taskId: operation.taskId,
        workerId: this.#workerId,
        errorCode: failure.name,
        conversationId: operation.payload.conversationId,
        threadTs: operation.payload.threadTs,
        text: failure.userMessage,
        now: this.#now().toISOString(),
        turnActiveMs: turnActiveMs(),
      });
      return { kind: "failed", operationId: operation.operationId, outboxId, errorCode: failure.name };
    } finally {
      polling.watch?.release();
    }
  }

  /**
   * Builds and freezes the T3 user message. Once `resolved_text` exists it is returned untouched, so
   * retries and restarts make no Slack calls and send byte-identical text.
   */
  async #composeTurn(
    operation: ClaimedOperation,
    task: TaskExecutionBinding,
    profile: AgentTagProfile,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const lease = { operationId: operation.operationId, workerId: this.#workerId };
    const frozen = this.#store.peekResolvedTurnText({ ...lease, now: this.#now().toISOString() });
    if (frozen !== null) return frozen;
    const { actorUserId, text, origin } = operation.payload;
    const window = await this.#readThreadWindow(operation, profile, signal);
    // Updates since the last turn are context for the next human turn; schedule runs leave them pending.
    const notes = origin === "slack" ? this.#store.listPendingThreadNotes(operation.taskId) : [];
    const memories = this.#memory.list({
      context: {
        workspaceId: this.#config.slack.workspaceId,
        actorUserId,
        profileId: task.profileId,
        taskId: operation.taskId,
        conversationType: task.conversationType,
      },
      now: this.#now().toISOString(),
    });
    // Schedule prompts are plain text, so only Slack-origin text is scanned for mentions.
    const mentioned = origin === "slack" ? collectMentionedUserIds(text) : [];
    const windowIds = window === null || "unavailable" in window
      ? []
      : window.messages.flatMap((message) => [
        ...(message.speakerKind === "human" ? [message.speakerId] : []),
        ...collectMentionedUserIds(message.text),
      ]);
    const noteIds = notes.flatMap((note) => [
      ...(note.speakerKind === "human" ? [note.speakerId] : []),
      ...collectMentionedUserIds(note.text),
      ...collectMentionedUserIds(note.previousText ?? ""),
    ]);
    const ids = [...new Set([actorUserId, ...mentioned, ...windowIds, ...noteIds])]
      .filter((id) => id !== this.#slackContext?.botUserId)
      .slice(0, MAX_TURN_SPEAKER_IDS);
    let names: ReadonlyMap<string, SpeakerIdentity> = new Map();
    if (this.#slackContext !== undefined) {
      // A hard deadline well inside the lease: unresolved users fall back to raw IDs, then the lease
      // is renewed so dispatch starts with a full lease.
      const deadline = AbortSignal.timeout(this.#speakerLookupBudgetMs);
      names = await abortable(this.#slackContext.users.labels(ids, signal, deadline), signal);
      this.#store.renewOperationLease({ ...lease, now: this.#now().toISOString(), leaseMs: this.#leaseMs });
    }
    const proposedText = composeTurnText({
      // Claims derive origin for legacy rows; if it is still absent, fail safe to plain text.
      origin: origin ?? "schedule",
      speaker: names.get(actorUserId) ?? unresolvedSpeaker(actorUserId),
      primaryText: text,
      names,
      ...(this.#slackContext === undefined ? {} : { botUserId: this.#slackContext.botUserId }),
      window,
      notes: notes.length === 0
        ? null
        : {
          items: notes,
          limits: { maxChars: profile.threadContext.maxChars, maxMessageChars: profile.threadContext.maxMessageChars },
        },
      memories,
    });
    return this.#store.resolveOperationTurnText({
      ...lease,
      proposedText,
      consumeNoteIds: notes.map((note) => note.noteId),
      now: this.#now().toISOString(),
    });
  }

  /**
   * Reads the earlier thread messages for a first mention in an existing thread. Fails open: any
   * Slack error or timeout becomes an "unavailable" window (and an audit row); only shutdown aborts.
   */
  async #readThreadWindow(
    operation: ClaimedOperation,
    profile: AgentTagProfile,
    signal: AbortSignal | undefined,
  ): Promise<TurnWindow | null> {
    const seed = operation.payload.threadContext;
    if (seed === undefined || this.#slackContext === undefined) return null;
    const source = this.#slackContext;
    let window: TurnWindow;
    try {
      window = await abortable(
        fetchThreadWindow({
          replies: source.replies,
          channel: operation.payload.conversationId,
          rootTs: seed.rootTs,
          beforeTs: seed.beforeTs,
          botUserId: source.botUserId,
          ...(source.selfBotId === undefined ? {} : { selfBotId: source.selfBotId }),
          allowedUserIds: this.#config.access.allowedUserIds,
          policy: profile.threadContext,
          timeoutMs: this.#threadContextBudgetMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof CoordinatorAborted || signal?.aborted === true) throw new CoordinatorAborted();
      window = { unavailable: error instanceof SlackContextUnavailable ? error.code : slackErrorCode(error) };
    }
    const now = this.#now().toISOString();
    this.#store.recordThreadContextAudit({
      operationId: operation.operationId,
      taskId: operation.taskId,
      workerId: this.#workerId,
      outcome: "unavailable" in window
        ? { kind: "unavailable", code: window.unavailable }
        : {
          kind: "loaded",
          messages: window.messages.length,
          omitted: window.omitted,
          truncated: window.truncated,
          chars: window.messages.reduce((total, message) => total + message.text.length, 0),
        },
      now,
    });
    this.#store.renewOperationLease({
      operationId: operation.operationId,
      workerId: this.#workerId,
      now,
      leaseMs: this.#leaseMs,
    });
    return window;
  }

  async #run(
    operation: ClaimedOperation,
    signal: AbortSignal | undefined,
    polling: TurnPolling,
  ): Promise<CoordinatorOutcome> {
    const task = this.#store.getTaskExecution(operation.taskId);
    const profile = requireExecutionAuthority({
      config: this.#config,
      task,
      actorUserId: operation.payload.actorUserId,
    });
    const route = this.#config.routes.find((candidate) => candidate.conversationId === task.conversationId);
    const turnText = await this.#composeTurn(operation, task, profile, signal);
    // Shutdown aborts these dispatches (the gateway interrupts the RPC and closes its socket). Both
    // commands use stable ids, so T3 deduplicates the replay when the released operation resumes.
    await abortable(this.#t3.dispatch({
      type: "project.create",
      commandId: `${task.projectOwnerTaskId}:project.create`,
      projectId: task.projectId,
      title: `Agent Tag ${profile.id}`,
      workspaceRoot: task.repositoryRoot,
      // Projects are shared across tasks, so they keep the profile default.
      defaultModelSelection: { instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel },
      createdAt: task.projectCreatedAt,
    }, signal), signal);
    // Chosen after the project exists: until the model is frozen here no model-bearing command has
    // gone out, so a retry before this point re-plans against the current config.
    const model = await this.#turnModel(operation, task, profile, route, signal);
    const modelSelection = model.selection;

    // Recorded first: if the receipt is lost, T3 may still run the turn, so cancellation has to wait
    // for the replay below to confirm it instead of dropping the operation locally.
    this.#store.markOperationTurnDispatched({
      operationId: operation.operationId,
      workerId: this.#workerId,
      now: this.#now().toISOString(),
    });
    const turn = await abortable(this.#t3.dispatch({
      type: "thread.turn.start",
      commandId: operation.commandId,
      threadId: task.threadId,
      message: {
        messageId: operation.messageId,
        role: "user",
        text: turnText,
        attachments: [],
      },
      modelSelection,
      titleSeed: `Slack ${operation.payload.conversationId}/${operation.payload.threadTs}`,
      runtimeMode: profile.runtimeMode,
      interactionMode: "default",
      ...(task.threadStarted
        ? {}
        : {
            bootstrap: {
              createThread: {
                projectId: task.projectId,
                title: `Slack ${operation.payload.conversationId}/${operation.payload.threadTs}`,
                modelSelection,
                runtimeMode: profile.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: task.createdAt,
              },
              prepareWorktree: {
                projectCwd: task.repositoryRoot,
                baseBranch: profile.baseBranch,
                branch: `agent-tag/${task.taskId}`,
              },
              runSetupScript: false,
            },
          }),
      createdAt: this.#now().toISOString(),
    }, signal), signal);
    this.#store.markT3ThreadStarted({ taskId: task.taskId, now: this.#now().toISOString() });
    // Watching from the receipt's sequence skips the initial snapshot frame; the loop's first fetch
    // reads the thread anyway.
    polling.watch = this.#watcher?.acquire(task.threadId, { afterSequence: turn.sequence }) ?? null;
    // From here a cancel interrupts this turn in T3 instead of dropping the queued operation.
    this.#store.markOperationTurnStarted({
      operationId: operation.operationId,
      workerId: this.#workerId,
      turnId: null,
      now: this.#now().toISOString(),
    });
    let turnIdRecorded = false;
    this.#store.enqueueOutbox({
      taskId: operation.taskId,
      correlationId: operation.operationId,
      conversationId: operation.payload.conversationId,
      threadTs: operation.payload.threadTs,
      clientMessageId: `${operation.operationId}:started`,
      payload: {
        text: "Agent Tag is working on this request.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Agent Tag is working on this request." },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                style: "danger",
                action_id: "agent-tag.turn.cancel",
                value: operation.taskId,
                confirm: {
                  title: { type: "plain_text", text: "Cancel this task?" },
                  text: { type: "mrkdwn", text: "The active T3 turn will be interrupted." },
                  confirm: { type: "plain_text", text: "Cancel task" },
                  deny: { type: "plain_text", text: "Keep running" },
                  style: "danger",
                },
              },
            ],
          },
        ],
      },
      createdAt: this.#now().toISOString(),
    });

    // Stall means "no T3 progress for the stall window", not "not finished yet": a long turn that
    // keeps advancing is polled until it settles, bounded only by the active-time ceiling, which is
    // summed across claims (restarts, retries, human waits are excluded) and persisted on renewal and
    // whenever the claim ends.
    const loopStartedAt = this.#now().getTime();
    polling.startedAt = loopStartedAt;
    const turnActiveMs = () => operation.turnActiveMs + (this.#now().getTime() - loopStartedAt);
    let progressMarker: string | null = null;
    let progressAt = loopStartedAt;
    let renewAt = loopStartedAt + Math.floor(this.#leaseMs / 2);
    while (true) {
      if (signal?.aborted) throw new CoordinatorAborted();
      if (this.#now().getTime() >= renewAt) {
        this.#store.renewOperationLease({
          operationId: operation.operationId,
          workerId: this.#workerId,
          now: this.#now().toISOString(),
          leaseMs: this.#leaseMs,
          turnActiveMs: turnActiveMs(),
        });
        renewAt = this.#now().getTime() + Math.floor(this.#leaseMs / 2);
      }
      if (turnActiveMs() > this.#maxTurnMs) {
        const outboxId = this.#store.abandonOperation({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          threadId: task.threadId,
          actorUserId: operation.payload.actorUserId,
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          errorCode: "T3TurnCeiling",
          text: `Agent Tag stopped this request because the T3 turn ran longer than the configured limit of ${describeDuration(Math.round(this.#maxTurnMs / 1_000))}. Agent Tag has asked T3 to interrupt it; ask the operator to inspect T3 before retrying.`,
          reason: "turn-ceiling",
          turnActiveMs: turnActiveMs(),
          now: this.#now().toISOString(),
        });
        return { kind: "failed", operationId: operation.operationId, outboxId, errorCode: "T3TurnCeiling" };
      }
      const snapshot = await abortable(this.#t3.fetchThread(task.threadId, signal), signal);
      // Events the stream saw count as progress even when they did not wake us for a fetch (streamed
      // text, tool updates), so a long tool call is not mistaken for a stall.
      const marker = `${t3ProgressMarker(snapshot)}:${polling.watch?.lastSequence ?? 0}`;
      if (marker !== progressMarker) {
        progressMarker = marker;
        progressAt = this.#now().getTime();
      }
      const startFailure = turnStartFailureDetail(snapshot, operation.messageId);
      if (startFailure !== null) {
        throw await this.#turnFailure(startFailure, operation, task, profile, route, model, signal);
      }
      if (task.threadStarted && !snapshotHasCurrentTurn(snapshot, operation.messageId)) {
        await this.#pollAgain(progressAt, signal, polling.watch, snapshot);
        continue;
      }
      if (!turnIdRecorded && snapshot.thread.latestTurn !== null) {
        // The latest turn is this operation's: either the thread is new or the check above matched.
        this.#store.markOperationTurnStarted({
          operationId: operation.operationId,
          workerId: this.#workerId,
          turnId: snapshot.thread.latestTurn.turnId,
          now: this.#now().toISOString(),
        });
        turnIdRecorded = true;
        // T3 started this turn, so it accepted the selection: later turns are planned against it.
        this.#store.recordAppliedModelSelection({
          taskId: task.taskId,
          threadId: task.threadId,
          selection: modelSelection,
          now: this.#now().toISOString(),
        });
      }
      const approvals = pendingT3Approvals(snapshot);
      const userInputs = pendingT3UserInputs(snapshot);
      if (approvals.length > 0 || userInputs.length > 0) {
        const interactionNow = this.#now();
        for (const approval of approvals) {
          this.#store.recordPendingInteraction({
            taskId: operation.taskId,
            operationId: operation.operationId,
            threadId: task.threadId,
            requestId: approval.requestId,
            kind: "approval",
            prompt: approval,
            conversationId: operation.payload.conversationId,
            threadTs: operation.payload.threadTs,
            message: (interactionId) => approvalMessage(interactionId, approval),
            now: interactionNow.toISOString(),
          });
        }
        for (const userInput of userInputs) {
          this.#store.recordPendingInteraction({
            taskId: operation.taskId,
            operationId: operation.operationId,
            threadId: task.threadId,
            requestId: userInput.requestId,
            kind: "user-input",
            prompt: userInput,
            conversationId: operation.payload.conversationId,
            threadTs: operation.payload.threadTs,
            message: (interactionId) => questionMessage(interactionId, userInput),
            now: interactionNow.toISOString(),
          });
        }
        // Re-read the store before deferring, atomically with the defer: if every request already
        // has a response (queued, in flight or delivered, T3 just has not caught up), keep polling.
        // Otherwise wait until the earliest request expires; a Slack response clears the block to
        // wake us.
        const expirySeconds = this.#config.limits.interactionExpirySeconds;
        const wait = this.#store.awaitOperationInteractions({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          threadId: task.threadId,
          actorUserId: operation.payload.actorUserId,
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          requests: [
            ...approvals.map((approval) => ({ requestId: approval.requestId, kind: "approval" as const })),
            ...userInputs.map((userInput) => ({ requestId: userInput.requestId, kind: "user-input" as const })),
          ],
          expirySeconds,
          expiredText: `Agent Tag cancelled this request because an approval or question went unanswered for ${describeDuration(expirySeconds)}. Agent Tag has asked T3 to stop the turn; send a new message to try again.`,
          turnActiveMs: turnActiveMs(),
          now: interactionNow.toISOString(),
        });
        if (wait.kind === "expired") {
          return { kind: "expired", operationId: operation.operationId, outboxId: wait.outboxId };
        }
        if (wait.kind === "deferred") {
          return {
            kind: "waiting-interaction",
            operationId: operation.operationId,
            threadId: task.threadId,
            approvalCount: approvals.length,
            questionCount: userInputs.length,
          };
        }
        if (wait.kind === "answered") {
          // Every request T3 still awaits has an accepted response that T3 has not reflected yet. This
          // snapshot predates the answers, so its turn state must not settle the operation: a turn that
          // completed with a message-mode question pending would otherwise settle and close the answer
          // before the interaction worker sends it. A delivery that never lands ends via the stall,
          // ceiling and failure paths, which close the response.
          await this.#pollAgain(progressAt, signal, polling.watch, snapshot);
          continue;
        }
        // "stale": every reported request is one an earlier operation gave up on; the turn decides.
      }
      if (awaitingT3AnswerContinuation(snapshot, this.#store.answeredOperationQuestions(operation.operationId))) {
        // T3 took this operation's message-mode answer, but the latest turn is still the one that
        // asked and ended before it. Settle only from the turn that continues from the answer (a new
        // turn, or the running turn the answer steered).
        await this.#pollAgain(progressAt, signal, polling.watch, snapshot);
        continue;
      }
      const latestTurn = snapshot.thread.latestTurn;
      if (latestTurn?.state === "error") {
        throw await this.#turnFailure(snapshot.thread.session?.lastError, operation, task, profile, route, model, signal);
      }
      if (latestTurn?.state === "interrupted") {
        const outboxId = this.#store.cancelOperationWithOutbox({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          now: this.#now().toISOString(),
        });
        return { kind: "cancelled", operationId: operation.operationId, outboxId };
      }
      if (latestTurn?.state === "completed") {
        const assistant = snapshot.thread.messages.find(
          (message) =>
            message.id === latestTurn.assistantMessageId &&
            message.role === "assistant" &&
            !message.streaming,
        );
        if (assistant === undefined) throw new Error("completed T3 turn has no final assistant message");
        const outboxId = this.#store.completeOperationWithOutbox({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          resultSequence: Math.max(turn.sequence, snapshot.snapshotSequence),
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          text: splitForSlack(markdownToMrkdwn(assistant.text)),
          now: this.#now().toISOString(),
        });
        return { kind: "completed", operationId: operation.operationId, outboxId };
      }
      await this.#pollAgain(progressAt, signal, polling.watch, snapshot);
    }
  }

  /**
   * The model this operation's turn runs on, chosen once and frozen on the operation: a replay sends
   * (and later records as applied) the same selection T3 deduplicated, even if the task's desired
   * model or the config changed in between. A thread move is re-sent under its stable command id.
   */
  async #turnModel(
    operation: ClaimedOperation,
    task: TaskExecutionBinding,
    profile: AgentTagProfile,
    route: AgentTagRoute | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TurnModel> {
    const lease = { operationId: operation.operationId, workerId: this.#workerId };
    const model = this.#store.peekOperationTurnModel({ ...lease, now: this.#now().toISOString() })
      ?? this.#store.resolveOperationTurnModel({
        ...lease,
        proposed: await this.#chooseModel(operation, task, profile, route, signal),
        now: this.#now().toISOString(),
      });
    if (model.movedThread) {
      // A stable id per operation: a replay after a lost receipt deduplicates in T3.
      await abortable(this.#t3.dispatch(threadModelSelectionCommand({
        commandId: `${operation.operationId}:model`,
        threadId: task.threadId,
        modelSelection: model.selection,
      }), signal), signal);
    }
    return model;
  }

  /**
   * Picks the selection for this turn (P2 §3.7): the task's desired model while config allows it, else
   * the route or profile default. A started thread only moves where T3 0.0.45 would follow (same
   * driver and resume state), via `thread.meta.update` so the snapshot names the model in use;
   * otherwise it stays on what T3 last accepted (sticky), which keeps a profile default moved to
   * another driver from breaking started threads. A desired model that cannot be honoured is reverted
   * with a one-line notice in the thread.
   */
  async #chooseModel(
    operation: ClaimedOperation,
    task: TaskExecutionBinding,
    profile: AgentTagProfile,
    route: AgentTagRoute | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TurnModel> {
    if (task.invalidModelSelection) {
      // Unreadable columns already read as unset; clearing them leaves an audit trail without the value.
      this.#store.clearInvalidModelSelection({
        taskId: task.taskId,
        correlationId: operation.operationId,
        now: this.#now().toISOString(),
      });
    }
    let applied = task.appliedModelSelection;
    if (task.threadStarted && applied === null) {
      // A thread started before selections were recorded: T3's projected selection is what it runs.
      const snapshot = await abortable(this.#t3.fetchThread(task.threadId, signal), signal);
      applied = { instanceId: snapshot.thread.modelSelection.instanceId, model: snapshot.thread.modelSelection.model };
      this.#store.recordAppliedModelSelection({
        taskId: task.taskId,
        threadId: task.threadId,
        selection: applied,
        now: this.#now().toISOString(),
      });
    }
    const effective = effectiveSelection({
      task: { desired: task.desiredModelSelection, applied },
      profile,
      route,
      catalog: this.#catalog?.current() ?? null,
    });
    // T3 already refused this default for the thread: stay on what it accepted until either changes.
    const stuck = effective.reason !== "desired" && task.threadStarted && applied !== null
      && task.rejectedModelSelection !== null && sameSelection(effective.selection, task.rejectedModelSelection);
    if (effective.revoked && task.desiredModelSelection !== null) {
      const dropped = task.desiredModelSelection;
      const allowed = allowedChoices(profile, route).map((choice) => `*${escapeSlackText(choice.label)}*`).join(", ");
      const droppedLabel = escapeSlackText(dropped.model);
      this.#modelNotice(
        operation,
        effective.reason === "sticky-applied" || stuck
          ? `*${droppedLabel}* is no longer allowed here, but T3 can't move a started thread to another provider, so this thread stays on it. Start a new thread to use an allowed model: ${allowed}.`
          : `*${droppedLabel}* is no longer allowed here, so this thread uses *${escapeSlackText(modelLabel(profile, route, effective.selection))}*. Allowed: ${allowed}.`,
      );
      this.#store.revertDesiredModelSelection({
        taskId: task.taskId,
        reason: "revoked",
        code: "not-allowed",
        correlationId: operation.operationId,
        now: this.#now().toISOString(),
      });
    }
    const target = effective.selection;
    if (!task.threadStarted || applied === null || sameSelection(target, applied)) {
      return { selection: target, previous: applied, movedThread: false };
    }
    if (stuck) return { selection: applied, previous: applied, movedThread: false };

    const catalog = await this.#freshCatalog(signal);
    const plan = planSwitch({
      current: applied,
      target: modelChoice(profile, route, target),
      threadStarted: true,
      catalog,
      // Disabling user switches does not pin a thread off a changed default.
      policy: effective.reason === "desired" ? profile.modelSwitch : { ...profile.modelSwitch, enabled: true },
    });
    if (plan.kind === "in-place" || plan.kind === "pre-start" || plan.kind === "noop") {
      return { selection: target, previous: applied, movedThread: true };
    }
    if (effective.reason === "desired") {
      const appliedLabel = escapeSlackText(modelLabel(profile, route, applied));
      this.#modelNotice(
        operation,
        `This thread already started on *${appliedLabel}*; T3 can't move it to *${escapeSlackText(modelLabel(profile, route, target))}* (${plan.code}). It stays on *${appliedLabel}*; start a new thread to use another provider.`,
      );
    }
    this.#store.revertDesiredModelSelection({
      taskId: task.taskId,
      reason: "refused",
      code: plan.code,
      correlationId: operation.operationId,
      now: this.#now().toISOString(),
    });
    return { selection: applied, previous: applied, movedThread: false };
  }

  /** The catalog, refreshed first (within a short budget) when it is missing or stale. */
  async #freshCatalog(signal: AbortSignal | undefined): Promise<T3ServerInfo | null> {
    if (this.#catalog === null) return null;
    const current = this.#catalog.current();
    if (current !== null) return current;
    // The budget bounds this wait, not the refresh: a read shared with the maintenance worker ignores
    // our signal, so past the budget the plan proceeds without a catalog and the read carries on.
    const budget = AbortSignal.timeout(this.#catalogRefreshBudgetMs);
    const deadline = signal === undefined ? budget : AbortSignal.any([signal, budget]);
    try {
      await abortable(this.#catalog.refresh(deadline), deadline);
    } catch (error) {
      if (signal?.aborted === true) throw new CoordinatorAborted();
      if (!(error instanceof CoordinatorAborted)) throw error;
    }
    return this.#catalog.current();
  }

  /** A one-line model notice in the task's Slack thread, at most once per operation. */
  #modelNotice(operation: ClaimedOperation, text: string): void {
    this.#store.enqueueOutbox({
      taskId: operation.taskId,
      correlationId: operation.operationId,
      conversationId: operation.payload.conversationId,
      threadTs: operation.payload.threadTs,
      clientMessageId: `${operation.operationId}:model-notice`,
      payload: { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] },
      createdAt: this.#now().toISOString(),
    });
  }

  /**
   * Classifies a T3 turn failure. When T3 refused the model switch, the rejection is recorded (a
   * desired model reverts to the one T3 last accepted; a default is not retried) and the thread's
   * projected selection is moved back (best effort).
   */
  async #turnFailure(
    lastError: string | null | undefined,
    operation: ClaimedOperation,
    task: TaskExecutionBinding,
    profile: AgentTagProfile,
    route: AgentTagRoute | undefined,
    model: TurnModel,
    signal: AbortSignal | undefined,
  ): Promise<CoordinatorFailure> {
    const failure = classifyT3TurnFailure(lastError, {
      currentModel: modelLabel(profile, route, model.previous ?? model.selection),
    });
    if (failure.code === "T3ModelSwitchRejected" && model.previous !== null && !sameSelection(model.selection, model.previous)) {
      this.#store.recordModelRejection({
        taskId: task.taskId,
        threadId: task.threadId,
        rejected: model.selection,
        code: failure.code,
        correlationId: operation.operationId,
        now: this.#now().toISOString(),
      });
      if (model.movedThread && model.previous !== null) {
        try {
          await abortable(this.#t3.dispatch(threadModelSelectionCommand({
            commandId: `${operation.operationId}:model-restore`,
            threadId: task.threadId,
            modelSelection: model.previous,
          }), signal), signal);
        } catch (error) {
          if (error instanceof CoordinatorAborted || signal?.aborted === true) throw new CoordinatorAborted();
          // The next turn re-plans from the applied selection, so a stale projection only misnames the model.
        }
      }
    }
    return new CoordinatorFailure(failure.code, failure.userMessage);
  }

  /**
   * Waits until T3 may have changed, unless it has shown no progress for the whole stall window.
   * With a watch, that is the next settlement-relevant thread event, a stream resync, or the safety
   * poll, never longer than half the lease (renewal) or past the stall deadline. Without one, or
   * while `snapshot` predates an event the stream already delivered, it is one poll interval.
   */
  async #pollAgain(
    progressAt: number,
    signal: AbortSignal | undefined,
    watch: ThreadWatch | null,
    snapshot: T3ThreadSnapshot,
  ): Promise<void> {
    const now = this.#now().getTime();
    if (now - progressAt > this.#stallMs) throw new T3TurnStalled();
    // `snapshotSequence` is T3's global read-model sequence, the same space as event sequences.
    if (watch === null || snapshot.snapshotSequence < watch.lastSequence) {
      await abortable(this.#sleep(this.#pollMs), signal);
      return;
    }
    const timeoutMs = Math.max(
      1,
      Math.min(this.#safetyPollMs, Math.floor(this.#leaseMs / 2), progressAt + this.#stallMs + 1 - now),
    );
    await abortable(watch.next(timeoutMs, signal), signal);
  }
}
