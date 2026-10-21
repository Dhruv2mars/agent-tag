// Plain-language model switch from Slack (PR-P2 §3.5): the router parses the directive; this plans the
// switch against the task row and the T3 catalog and applies it without a T3 turn. Ledger claim,
// thread task, the chosen model and its audit row, the reply and (for a switch that carries a request)
// the request's operation commit together (store runThreadCommand), so a redelivery never switches
// twice and a refused switch never runs the request on the wrong model. Never throws for user errors.
import { isCommandAdminOnly, isCommandDisabled } from "../commands/authority.ts";
import { DEFAULT_BOT_NAME } from "../commands/replies.ts";
import type { AgentTagConfig } from "../config.ts";
import { resolveRoute } from "../policy/access.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "../policy/execution.ts";
import {
  allowedChoices,
  effectiveSelection,
  type ModelChoice,
  planSwitch,
  type SwitchPlan,
  type SwitchRefusalCode,
} from "../policy/models.ts";
import type { ServiceLogger } from "../service.ts";
import type { ThreadCommandResult } from "../store/commands.ts";
import type { AgentTagStore, IngestReceipt, SlackEventInput, SlackOutboxPayload, TaskExecutionBinding } from "../store/store.ts";
import type { T3ModelSelection, T3ServerInfo } from "../t3/gateway.ts";
import type { MemoryEphemeralSender } from "./memory-commands.ts";
import type { ModelDirective } from "./model-directive.ts";
import * as copy from "./model-replies.ts";
import { slackErrorCode } from "./users.ts";

export interface ModelRequest {
  readonly deliveryId: string;
  /** "<channel>:<ts>" of the request message. */
  readonly eventKey: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly conversationType: "channel" | "dm";
  /** The thread the directive belongs to (the message's own ts at top level). Replies go here. */
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly receivedAt: string;
}

export interface ModelIngress {
  readonly kind: "model";
  readonly directive: ModelDirective;
  readonly request: ModelRequest;
  /** The request after the directive, ingested as a turn when the switch is taken; null when switch-only. */
  readonly prompt: SlackEventInput | null;
}

export type ModelSwitchOutcome =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "executed";
      readonly outcome: ThreadCommandResult["outcome"];
      readonly reason: string | null;
      /** The queued request, when the switch carried one and was taken. */
      readonly receipt: IngestReceipt | null;
    };

export interface SlackModelSwitchOptions {
  /** A getter, so a config reload applies without rewiring. */
  readonly config: () => AgentTagConfig;
  readonly store: AgentTagStore;
  readonly replies: MemoryEphemeralSender;
  /** The T3 provider catalog; absent or stale means T3 state is unknown (`planSwitch` is then cautious). */
  readonly catalog?: { current(): T3ServerInfo | null };
  /** How users address the bot in the hints, e.g. "Agent Tag". */
  readonly botName?: string;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}

interface Executed extends ThreadCommandResult {
  readonly receipt: IngestReceipt | null;
  /** Set when the actor lost authority: nothing changed and the reply goes only to them. */
  readonly ephemeral?: SlackOutboxPayload;
}

function sameSelection(left: T3ModelSelection, right: T3ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function selectionOf(choice: ModelChoice): T3ModelSelection {
  return { instanceId: choice.instanceId, model: choice.model };
}

export class SlackModelSwitch {
  readonly #config: () => AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #replies: MemoryEphemeralSender;
  readonly #catalog: SlackModelSwitchOptions["catalog"];
  readonly #botName: string;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;

  constructor(options: SlackModelSwitchOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#replies = options.replies;
    this.#catalog = options.catalog;
    this.#botName = options.botName ?? DEFAULT_BOT_NAME;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async handle(ingress: ModelIngress): Promise<ModelSwitchOutcome> {
    const req = ingress.request;
    const config = this.#config();
    const catalog = this.#catalog?.current() ?? null;
    try {
      const receipt = this.#store.runThreadCommand(
        {
          deliveryId: req.deliveryId,
          eventKey: req.eventKey,
          workspaceId: req.workspaceId,
          conversationId: req.conversationId,
          conversationType: req.conversationType,
          threadTs: req.threadTs,
          actorUserId: req.actorUserId,
          profileId: req.profileId,
          repositoryRoot: req.repositoryRoot,
          commandKind: "model-switch",
          now: req.receivedAt,
        },
        (taskId): Executed => {
          let task: TaskExecutionBinding;
          try {
            task = this.#store.getTaskExecution(taskId);
            requireExecutionAuthority({ config, task, actorUserId: req.actorUserId });
          } catch (error) {
            if (!(error instanceof ExecutionAuthorityDenied)) throw error;
            return { outcome: "denied", reason: "execution-denied", replies: [], receipt: null, ephemeral: copy.MODEL_SWITCH_DENIED };
          }
          return this.#execute(config, catalog, task, ingress);
        },
      );
      if (receipt.kind === "duplicate") return { kind: "duplicate" };
      if (receipt.result.ephemeral !== undefined) await this.#ephemeral(req, receipt.result.ephemeral);
      return { kind: "executed", outcome: receipt.result.outcome, reason: receipt.result.reason, receipt: receipt.result.receipt };
    } catch (error) {
      // Everything rolled back; Bolt already acked the event, so the user retries by sending it again.
      this.#log("model.switch.failed", error instanceof Error ? error.name : "unknown");
      await this.#ephemeral(req, copy.MODEL_SWITCH_FAILED);
      return { kind: "executed", outcome: "failed", reason: "internal-error", receipt: null };
    }
  }

  #execute(config: AgentTagConfig, catalog: T3ServerInfo | null, task: TaskExecutionBinding, ingress: ModelIngress): Executed {
    const { directive, request: req } = ingress;
    const profile = config.profiles.find((candidate) => candidate.id === task.profileId);
    if (profile === undefined) throw new Error(`validated route references missing profile ${task.profileId}`);
    const route = resolveRoute(config, task.conversationId, task.ownerUserId) ?? null;
    const choices = allowedChoices(profile, route);
    // A closed task's next request opens a fresh T3 thread, so its old thread's model no longer binds it.
    const closed = task.state === "closed";
    const applied = closed ? null : task.appliedModelSelection;
    const effective = effectiveSelection({
      task: { desired: task.desiredModelSelection, applied },
      profile,
      route,
      catalog,
    }).selection;
    // What T3 has for the thread (or will create it with), and what the next turn would carry.
    const current = applied ?? effective;
    const name = (selection: T3ModelSelection): copy.ModelName => ({
      selection,
      label: choices.find((choice) => sameSelection(choice, selection))?.label ?? `${selection.instanceId}/${selection.model}`,
    });
    const refuse = (code: SwitchRefusalCode, target: ModelChoice | null, known: T3ModelSelection | null, detail?: string): Executed => {
      this.#store.recordModelDenied({
        taskId: task.taskId,
        actorUserId: req.actorUserId,
        target: target === null ? known : selectionOf(target),
        current,
        code,
        correlationId: req.eventKey,
        now: req.receivedAt,
      });
      const driver = (instanceId: string): string | null =>
        catalog?.providers.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
      return {
        outcome: "rejected",
        reason: code,
        receipt: null,
        replies: [
          copy.refusedReply({
            code,
            query: directive.query,
            target: target === null ? null : name(selectionOf(target)),
            current: name(current),
            currentDriver: driver(current.instanceId) ?? current.instanceId,
            targetDriver: target === null ? null : driver(target.instanceId),
            allowed: choices,
            candidates: directive.kind === "ambiguous" ? directive.candidates : [],
            detail: detail ?? null,
            hadRequest: ingress.prompt !== null,
            botName: this.#botName,
            restartAvailable: this.#restartAvailable(config, req.actorUserId),
            targetHandle: target === null ? null : target.aliases[0] ?? target.model,
          }),
        ],
      };
    };
    if (directive.kind === "ambiguous") return refuse("ambiguous", null, null);
    if (directive.kind === "not-allowed") return refuse("not-allowed", null, directive.known);

    const target = directive.choice;
    // A turn claimed or sent to T3 may already have started the thread: treat it as started.
    const threadStarted = !closed && (task.threadStarted || this.#store.hasInflightOperation(task.taskId));
    let plan: SwitchPlan = planSwitch({ current, target, threadStarted, catalog, policy: profile.modelSwitch });
    if (plan.kind === "noop" && !sameSelection(effective, target)) {
      // T3 already has the target but a pending choice would move the thread off it: undo that choice.
      plan = { kind: threadStarted ? "in-place" : "pre-start" };
    }
    if (plan.kind === "refused") return refuse(plan.code, target, null, plan.detail);

    const replies: SlackOutboxPayload[] = [];
    if (plan.kind === "noop") {
      // A request rides along unannounced; a bare switch to the current model gets a short answer.
      if (ingress.prompt === null) replies.push(copy.alreadyReply(name(current)));
    } else {
      this.#store.setTaskModelSelection({
        taskId: task.taskId,
        selection: selectionOf(target),
        selectedBy: req.actorUserId,
        correlationId: req.eventKey,
        now: req.receivedAt,
      });
      replies.push(copy.switchedReply({
        target: name(selectionOf(target)),
        actorUserId: req.actorUserId,
        preStart: plan.kind === "pre-start",
      }));
    }
    // Same transaction: the request is queued only with the switch it was written for.
    const receipt = ingress.prompt === null ? null : this.#store.ingestSlackEvent(ingress.prompt);
    return { outcome: "succeeded", reason: plan.kind === "noop" ? "already-selected" : null, replies, receipt };
  }

  #restartAvailable(config: AgentTagConfig, actorUserId: string): boolean {
    return config.commands.enabled &&
      !isCommandDisabled(config, "restart") &&
      (!isCommandAdminOnly(config, "restart") || config.access.adminUserIds.includes(actorUserId));
  }

  async #ephemeral(req: ModelRequest, payload: SlackOutboxPayload): Promise<void> {
    try {
      await this.#replies.ephemeral({ channel: req.conversationId, user: req.actorUserId, threadTs: req.threadTs, payload });
    } catch (error) {
      this.#log("model.switch.reply.failed", slackErrorCode(error));
    }
  }

  /** No event key or message text in logs. */
  #log(event: string, errorCode: string): void {
    this.#logger?.({ level: "warn", event, at: this.#now().toISOString(), errorCode });
  }
}
