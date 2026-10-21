// Routines from Slack (PR-J §3.4): create, list and cancel by text, and cancel by button. The
// router detects the intent; this runs it: ledger claim (dedup), thread task, authority, action,
// reply through the outbox. Never throws for user errors.
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { isSteeringAllowed, type AccessDecision } from "../policy/access.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "../policy/execution.ts";
import type { RoutineCancelRef, RoutineIntent } from "../routines/intent.ts";
import { normalizeRoutineRequest } from "../routines/parse.ts";
import { extractTimeZone, resolveRoutineSchedule } from "../routines/timezone.ts";
import { AgentTagSchedules } from "../scheduler.ts";
import type { ServiceLogger } from "../service.ts";
import type { AgentTagStore, ScheduleSummary, SlackOutboxPayload } from "../store/store.ts";
import * as copy from "./routine-replies.ts";
import { slackErrorCode } from "./users.ts";

export interface RoutineRequest {
  readonly deliveryId: string;
  /** "<channel>:<ts>" of the request message. */
  readonly eventKey: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly conversationType: "channel" | "dm";
  /** The thread the request belongs to (the message's own ts at top level). Replies and runs go here. */
  readonly threadTs: string;
  readonly messageTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  /** The request with the bot mention stripped. */
  readonly text: string;
  readonly receivedAt: string;
}

export interface RoutineIngress {
  readonly kind: "routine";
  readonly intent: Exclude<RoutineIntent, { readonly kind: "none" }>;
  readonly request: RoutineRequest;
}

export type RoutineOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "executed"; readonly outcome: "succeeded" | "rejected" | "denied" | "failed" };

export type RoutineActionOutcome = "accepted" | "denied" | "ignored";

/** The active routines a cancel reference points at, in list order. Pure. */
export function matchCancelTargets(
  active: ReadonlyArray<ScheduleSummary>,
  ref: RoutineCancelRef,
  threadTs: string,
): ReadonlyArray<ScheduleSummary> {
  const live = active.filter((schedule) => schedule.state === "active");
  switch (ref.kind) {
    case "only":
      // "cancel this routine": only the routines of the thread it was said in.
      return live.filter((schedule) => schedule.threadTs === threadTs);
    case "index": {
      const schedule = live[ref.index - 1];
      return schedule === undefined ? [] : [schedule];
    }
    case "id":
      return live.filter((schedule) => schedule.scheduleId.replaceAll("-", "").toLowerCase().startsWith(ref.prefix));
    case "text": {
      const needle = ref.text.toLowerCase();
      return live.filter((schedule) => schedule.prompt.toLowerCase().includes(needle));
    }
  }
}

function refLabel(ref: RoutineCancelRef): string | null {
  switch (ref.kind) {
    case "only":
      return null;
    case "index":
      return `#${ref.index}`;
    case "id":
      return ref.prefix;
    case "text":
      return ref.text;
  }
}

/** Only-you notes for denials and failures, where a thread reply may not be allowed. */
export interface RoutineEphemeralSender {
  ephemeral(input: {
    readonly channel: string;
    readonly user: string;
    readonly threadTs?: string;
    readonly payload: SlackOutboxPayload;
  }): Promise<void>;
}

export interface RoutineUserDirectory {
  timeZone(userId: string, signal?: AbortSignal): Promise<string | null>;
  label(userId: string, signal?: AbortSignal): Promise<{ readonly label: string }>;
}

export interface SlackRoutinesOptions {
  /** A getter, so a config reload applies without rewiring. */
  readonly config: () => AgentTagConfig;
  readonly store: AgentTagStore;
  readonly users: RoutineUserDirectory;
  readonly replies: RoutineEphemeralSender;
  /** Display name from `auth.test` `user`, for the empty-list hint. */
  readonly botName?: string;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}

const TIME_ZONE_LOOKUP_MS = 3_000;
const LABEL_LOOKUP_MS = 3_000;
const AUTO_DISABLED_WINDOW_MS = 7 * 86_400_000;

const actionBodySchema = z.object({
  team: z.object({ id: z.string() }).nullish(),
  user: z.object({ id: z.string(), team_id: z.string().optional() }),
  channel: z.object({ id: z.string() }).optional(),
  container: z.object({ thread_ts: z.string().optional(), message_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).min(1),
});
const actionValueSchema = z.object({ scheduleId: z.uuid() });

type Settle = (outcome: "succeeded" | "rejected" | "denied" | "failed", reason: string | null) => void;

/** A DM non-owner gets past the gate so the task check below can tell them the routine isn't theirs. */
function clickMayProceed(decision: AccessDecision): boolean {
  return decision.allowed || decision.reason === "dm-owner-denied";
}

export class SlackRoutines {
  readonly #config: () => AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #users: RoutineUserDirectory;
  readonly #replies: RoutineEphemeralSender;
  readonly #botName: string;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;

  constructor(options: SlackRoutinesOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#users = options.users;
    this.#replies = options.replies;
    this.#botName = options.botName ?? "Agent Tag";
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async handle(ingress: RoutineIngress): Promise<RoutineOutcome> {
    const { intent, request: req } = ingress;
    const claim = this.#store.beginCommand({
      workspaceId: req.workspaceId,
      eventKey: req.eventKey,
      deliveryId: req.deliveryId,
      conversationId: req.conversationId,
      threadTs: req.threadTs,
      actorUserId: req.actorUserId,
      commandKind: `routine-${intent.kind}`,
      taskId: this.#store.findActiveTask({ workspaceId: req.workspaceId, conversationId: req.conversationId, threadTs: req.threadTs })?.taskId ?? null,
      now: req.receivedAt,
    });
    if (claim === "duplicate") return { kind: "duplicate" };

    const settle: Settle = (outcome, reason) => {
      this.#store.settleCommand({
        workspaceId: req.workspaceId,
        eventKey: req.eventKey,
        outcome,
        reason,
        profileId: req.profileId,
        now: this.#now().toISOString(),
      });
    };
    try {
      const config = this.#config();
      const taskId = this.#store.ensureTaskForThread({
        workspaceId: req.workspaceId,
        conversationId: req.conversationId,
        threadTs: req.threadTs,
        actorUserId: req.actorUserId,
        conversationType: req.conversationType,
        profileId: req.profileId,
        repositoryRoot: req.repositoryRoot,
        now: req.receivedAt,
      });
      requireExecutionAuthority({
        config,
        task: this.#store.getTaskExecution(taskId),
        actorUserId: req.actorUserId,
        purpose: "schedule",
      });
      const reply = (payload: SlackOutboxPayload): void => {
        this.#store.enqueueOutbox({
          taskId,
          correlationId: req.eventKey,
          conversationId: req.conversationId,
          threadTs: req.threadTs,
          clientMessageId: `routine:${req.eventKey}:${intent.kind}`,
          payload,
          createdAt: this.#now().toISOString(),
        });
      };
      switch (intent.kind) {
        case "create":
          return await this.#create(config, req, taskId, reply, settle);
        case "list":
          return await this.#list(req, reply, settle);
        case "cancel":
          return await this.#cancel(req, intent.ref, reply, settle);
      }
    } catch (error) {
      const denied = error instanceof ExecutionAuthorityDenied;
      this.#log(denied ? "routine.denied" : "routine.failed", intent.kind, error instanceof Error ? error.name : "unknown");
      try {
        settle(denied ? "denied" : "failed", denied ? "execution-denied" : "internal-error");
      } catch {
        // Already settled (the action committed, the reply failed): the ledger is right as it is.
      }
      await this.#ephemeral(req, denied ? copy.deniedReply("execution-denied", 0) : copy.ROUTINE_FAILED);
      return { kind: "executed", outcome: denied ? "denied" : "failed" };
    }
  }

  async #create(
    config: AgentTagConfig,
    req: RoutineRequest,
    taskId: string,
    reply: (payload: SlackOutboxPayload) => void,
    settle: Settle,
  ): Promise<RoutineOutcome> {
    const extracted = extractTimeZone(normalizeRoutineRequest(req.text));
    if (extracted.kind === "error") return this.#reject(reply, settle, "time-zone", copy.parseErrorReply(extracted.message));
    // The profile zone is the only I/O, and only needed when the request names no zone.
    const profileTimeZone = extracted.explicit === undefined ? await this.#profileTimeZone(req.actorUserId) : null;
    const now = this.#now();
    const resolved = resolveRoutineSchedule({
      text: req.text,
      now,
      actorUserId: req.actorUserId,
      profileTimeZone,
      defaultTimeZone: config.routines.defaultTimeZone,
    });
    if (resolved.kind === "error") return this.#reject(reply, settle, "parse-error", copy.parseErrorReply(resolved.message));

    const conversationLimit = config.routines.maxActivePerConversation;
    const active = this.#store.listActiveSchedulesForConversation({
      workspaceId: req.workspaceId,
      conversationId: req.conversationId,
      limit: 1_000,
    });
    if (active.length >= conversationLimit) {
      return this.#reject(reply, settle, "conversation-limit", copy.conversationLimitReply(conversationLimit));
    }
    const result = new AgentTagSchedules({ config, store: this.#store }).create({
      context: { workspaceId: req.workspaceId, actorUserId: req.actorUserId, profileId: req.profileId, taskId },
      spec: resolved.spec,
      now: now.toISOString(),
      source: {
        eventKey: req.eventKey,
        timeZone: resolved.timeZone,
        humanReadable: resolved.humanReadable,
        ...(resolved.notifyUserId === undefined ? {} : { notifyUserId: resolved.notifyUserId }),
      },
    });
    if (result.kind === "denied") {
      const payload = copy.deniedReply(result.reason, config.limits.maxActiveSchedules);
      if (result.reason === "schedule-limit") return this.#reject(reply, settle, "schedule-limit", payload);
      settle("denied", result.reason);
      await this.#ephemeral(req, payload);
      return { kind: "executed", outcome: "denied" };
    }
    reply(
      copy.createdReply({
        schedule: result.schedule,
        recurring: resolved.recurring,
        timeZoneSource: resolved.timeZoneSource,
        defaultTimeZone: config.routines.defaultTimeZone,
      }),
    );
    settle("succeeded", null);
    return { kind: "executed", outcome: "succeeded" };
  }

  async #list(req: RoutineRequest, reply: (payload: SlackOutboxPayload) => void, settle: Settle): Promise<RoutineOutcome> {
    const schedules = this.#store.listActiveSchedulesForConversation({
      workspaceId: req.workspaceId,
      conversationId: req.conversationId,
      limit: 1_000,
      autoDisabledSince: new Date(this.#now().getTime() - AUTO_DISABLED_WINDOW_MS).toISOString(),
    });
    const active = schedules.filter((schedule) => schedule.state === "active");
    const disabled = schedules.filter((schedule) => schedule.state !== "active");
    const shown = [...active.slice(0, copy.ROUTINE_LIST_LIMIT), ...disabled];
    const labels = await this.#labels(shown.map((schedule) => schedule.actorUserId));
    const row = (schedule: ScheduleSummary): copy.RoutineListRow => ({
      schedule,
      creatorLabel: labels.get(schedule.actorUserId) ?? schedule.actorUserId,
    });
    reply(
      copy.listReply({
        conversationType: req.conversationType,
        botName: this.#botName,
        active: active.map(row),
        disabled: disabled.map(row),
      }),
    );
    settle("succeeded", null);
    return { kind: "executed", outcome: "succeeded" };
  }

  async #cancel(
    req: RoutineRequest,
    ref: RoutineCancelRef,
    reply: (payload: SlackOutboxPayload) => void,
    settle: Settle,
  ): Promise<RoutineOutcome> {
    const active = this.#store.listActiveSchedulesForConversation({
      workspaceId: req.workspaceId,
      conversationId: req.conversationId,
      limit: 1_000,
    });
    const targets = matchCancelTargets(active, ref, req.threadTs);
    if (targets.length === 0) return this.#reject(reply, settle, "no-match", copy.noMatchReply(refLabel(ref)));
    if (targets.length > 1) {
      const labels = await this.#labels(targets.map((schedule) => schedule.actorUserId));
      // Keep the conversation-wide list numbers, so "cancel routine <n>" after this reply hits the row shown.
      const live = active.filter((schedule) => schedule.state === "active");
      const rows = targets.map((schedule) => ({
        number: live.indexOf(schedule) + 1,
        schedule,
        creatorLabel: labels.get(schedule.actorUserId) ?? schedule.actorUserId,
      }));
      return this.#reject(reply, settle, "ambiguous", copy.ambiguousCancelReply(rows));
    }
    const [schedule] = targets as [ScheduleSummary];
    const result = new AgentTagSchedules({ config: this.#config(), store: this.#store }).cancel({
      context: { workspaceId: req.workspaceId, actorUserId: req.actorUserId, profileId: schedule.profileId, taskId: schedule.taskId },
      scheduleId: schedule.scheduleId,
      now: this.#now().toISOString(),
    });
    if (result.kind === "denied") {
      if (this.#store.getSchedule(schedule.scheduleId)?.state !== "active") {
        return this.#reject(reply, settle, "already-ended", { text: copy.ALREADY_ENDED });
      }
      settle("denied", "schedule-denied");
      await this.#ephemeral(req, { text: copy.CANCEL_DENIED });
      return { kind: "executed", outcome: "denied" };
    }
    reply(copy.cancelledReply({ actorUserId: req.actorUserId, schedule }));
    settle("succeeded", null);
    return { kind: "executed", outcome: "succeeded" };
  }

  /**
   * The Cancel button. The caller acks first. Checks the click's team, user and channel against the
   * current config, then cancels with the routine's own task context, so a DM routine stays
   * owner-only. A second click finds the routine ended and posts no second notice.
   */
  async cancelFromAction(body: unknown, respond?: (text: string) => Promise<unknown>): Promise<RoutineActionOutcome> {
    const parsed = actionBodySchema.safeParse(body);
    if (!parsed.success) return "ignored";
    const action = parsed.data.actions.find((candidate) => candidate.action_id === copy.ROUTINE_CANCEL_ACTION_ID);
    const value = (() => {
      try {
        return actionValueSchema.safeParse(JSON.parse(action?.value ?? ""));
      } catch {
        return null;
      }
    })();
    if (value === null || !value.success) return "ignored";
    const config = this.#config();
    const teamId = parsed.data.team?.id ?? parsed.data.user.team_id;
    const channelId = parsed.data.channel?.id;
    const userId = parsed.data.user.id;
    if (
      teamId !== config.slack.workspaceId ||
      channelId === undefined ||
      !clickMayProceed(isSteeringAllowed({ config, workspaceId: teamId, conversationId: channelId, userId, purpose: "schedule" }))
    ) {
      return "ignored";
    }
    const tell = async (text: string): Promise<void> => {
      try {
        await respond?.(text);
      } catch (error) {
        this.#log("routine.action.reply.failed", "cancel", slackErrorCode(error));
      }
    };
    const schedule = this.#store.getSchedule(value.data.scheduleId);
    if (schedule === null || schedule.workspaceId !== teamId || schedule.conversationId !== channelId) return "ignored";
    if (schedule.state !== "active") {
      await tell(copy.ALREADY_ENDED);
      return "denied";
    }
    const now = this.#now().toISOString();
    try {
      requireExecutionAuthority({
        config,
        task: this.#store.getTaskExecution(schedule.taskId),
        actorUserId: userId,
        purpose: "schedule",
      });
    } catch (error) {
      if (!(error instanceof ExecutionAuthorityDenied)) throw error;
      await tell(copy.CANCEL_DENIED);
      return "denied";
    }
    const result = new AgentTagSchedules({ config, store: this.#store }).cancel({
      context: { workspaceId: teamId, actorUserId: userId, profileId: schedule.profileId, taskId: schedule.taskId },
      scheduleId: schedule.scheduleId,
      now,
    });
    if (result.kind === "denied") {
      await tell(this.#store.getSchedule(schedule.scheduleId)?.state === "active" ? copy.CANCEL_DENIED : copy.ALREADY_ENDED);
      return "denied";
    }
    // The notice goes in the thread holding the clicked card when it is a bound task (a list
    // reply), else in the routine's own thread.
    const clickedThread = parsed.data.container?.thread_ts ?? parsed.data.message?.thread_ts ?? parsed.data.message?.ts;
    const clicked =
      clickedThread === undefined
        ? null
        : this.#store.findActiveTask({ workspaceId: teamId, conversationId: channelId, threadTs: clickedThread });
    const target =
      clicked !== null && clickedThread !== undefined
        ? { taskId: clicked.taskId, threadTs: clickedThread }
        : { taskId: schedule.taskId, threadTs: schedule.threadTs };
    this.#store.enqueueOutbox({
      taskId: target.taskId,
      correlationId: schedule.scheduleId,
      conversationId: channelId,
      threadTs: target.threadTs,
      clientMessageId: `${schedule.scheduleId}:cancelled`,
      payload: copy.cancelledReply({ actorUserId: userId, schedule }),
      createdAt: now,
    });
    return "accepted";
  }

  #reject(reply: (payload: SlackOutboxPayload) => void, settle: Settle, reason: string, payload: SlackOutboxPayload): RoutineOutcome {
    reply(payload);
    settle("rejected", reason);
    return { kind: "executed", outcome: "rejected" };
  }

  async #profileTimeZone(userId: string): Promise<string | null> {
    try {
      return await this.#users.timeZone(userId, AbortSignal.timeout(TIME_ZONE_LOOKUP_MS));
    } catch {
      return null;
    }
  }

  /** Display labels for creators (never mentions). Unresolved IDs fall back to the raw ID. */
  async #labels(userIds: ReadonlyArray<string>): Promise<Map<string, string>> {
    const signal = AbortSignal.timeout(LABEL_LOOKUP_MS);
    const entries = await Promise.all(
      [...new Set(userIds)].map(async (userId) => {
        try {
          return [userId, (await this.#users.label(userId, signal)).label] as const;
        } catch {
          return [userId, userId] as const;
        }
      }),
    );
    return new Map(entries);
  }

  async #ephemeral(req: RoutineRequest, payload: SlackOutboxPayload): Promise<void> {
    try {
      await this.#replies.ephemeral({ channel: req.conversationId, user: req.actorUserId, threadTs: req.threadTs, payload });
    } catch (error) {
      this.#log("routine.reply.failed", undefined, slackErrorCode(error));
    }
  }

  /** No event key or text in logs. */
  #log(event: string, intent: string | undefined, errorCode: string): void {
    this.#logger?.({
      level: "warn",
      event,
      at: this.#now().toISOString(),
      ...(intent === undefined ? {} : { outcome: intent }),
      errorCode,
    });
  }
}
