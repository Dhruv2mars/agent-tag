// Executes routed `!commands` (PR-H §3.2): ledger claim (dedup), authority, action, reply.
import type { AgentTagConfig } from "../config.ts";
import { effectiveSelection } from "../policy/models.ts";
import type { ServiceLogger } from "../service.ts";
import { slackErrorCode } from "../slack/users.ts";
import type { AgentTagStore, SlackOutboxPayload } from "../store/store.ts";
import { authorizeCommand, isCommandAdminOnly, isCommandDisabled } from "./authority.ts";
import type { CommandContext, CommandIngress } from "./context.ts";
import { IMPLEMENTED_COMMANDS, isCommandUsage, type ImplementedCommandName } from "./parse.ts";
import * as replies from "./replies.ts";

/** Delivery for command replies (PR-H §3.4). Public notices in bound threads go through the outbox instead. */
export interface CommandReplySender {
  /** Only-you note. At-most-once: nothing depends on it and the user can re-run the command. */
  ephemeral(input: {
    readonly channel: string;
    readonly user: string;
    readonly threadTs?: string;
    readonly payload: SlackOutboxPayload;
  }): Promise<void>;
  /** Best-effort public reply where no task exists (no outbox row is possible). */
  post(input: { readonly channel: string; readonly threadTs: string; readonly payload: SlackOutboxPayload }): Promise<{ readonly ts: string }>;
}

export type CommandExecution =
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored" }
  | { readonly kind: "executed"; readonly outcome: "succeeded" | "rejected" | "denied" | "failed" };

export interface AgentTagCommandsOptions {
  /** A getter, so a config reload applies without rewiring. */
  readonly config: () => AgentTagConfig;
  readonly store: AgentTagStore;
  readonly replies: CommandReplySender;
  /** Display name from `auth.test` `user`. */
  readonly botName?: string;
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}

function isImplemented(name: string): name is ImplementedCommandName {
  return (IMPLEMENTED_COMMANDS as ReadonlyArray<string>).includes(name);
}

export class AgentTagCommands {
  readonly #config: () => AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #replies: CommandReplySender;
  readonly #botName: string;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;

  constructor(options: AgentTagCommandsOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#replies = options.replies;
    this.#botName = options.botName ?? replies.DEFAULT_BOT_NAME;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(ingress: CommandIngress): Promise<CommandExecution> {
    const { command, context: ctx } = ingress;
    // The router only routes implemented commands; anything else is not ours to answer.
    if (isCommandUsage(command) || !isImplemented(command.name)) return { kind: "ignored" };
    const name = command.name;
    const config = this.#config();
    const claim = this.#store.beginCommand({
      workspaceId: ctx.workspaceId,
      eventKey: ctx.eventKey,
      deliveryId: ctx.deliveryId,
      conversationId: ctx.conversationId,
      threadTs: ctx.threadTs,
      actorUserId: ctx.actorUserId,
      commandKind: name,
      taskId: ctx.binding?.taskId ?? null,
      now: ctx.receivedAt,
    });
    if (claim === "duplicate") return { kind: "duplicate" };

    const settle = (outcome: "succeeded" | "rejected" | "denied" | "failed", reason: string | null): void => {
      this.#store.settleCommand({
        workspaceId: ctx.workspaceId,
        eventKey: ctx.eventKey,
        outcome,
        reason,
        profileId: ctx.profileId,
        now: this.#now().toISOString(),
      });
    };
    try {
      const authorization = authorizeCommand({ config, store: this.#store, ctx, command: name });
      if (authorization.kind === "denied") {
        settle("denied", authorization.reason);
        await this.#ephemeral(ctx, replies.deniedReply({ botName: this.#botName, command: name, reason: authorization.reason }));
        return { kind: "executed", outcome: "denied" };
      }
      switch (name) {
        case "help":
          settle("succeeded", null);
          await this.#ephemeral(ctx, this.#help(config));
          return { kind: "executed", outcome: "succeeded" };
        case "status":
          await this.#status(config, ctx, settle);
          return { kind: "executed", outcome: "succeeded" };
        case "mute":
        case "unmute":
          return await this.#mute(ctx, name === "mute", settle);
      }
    } catch (error) {
      this.#log("command.failed", name, error instanceof Error ? error.name : "unknown");
      try {
        settle("failed", "internal-error");
      } catch {
        // Already settled (the action committed, the reply failed): the ledger is right as it is.
      }
      await this.#ephemeral(ctx, replies.COMMAND_FAILED);
      return { kind: "executed", outcome: "failed" };
    }
  }

  #help(config: AgentTagConfig): SlackOutboxPayload {
    return replies.helpReply({
      botName: this.#botName,
      commands: IMPLEMENTED_COMMANDS.filter((name) => !isCommandDisabled(config, name)).map((name) => ({
        name,
        adminOnly: isCommandAdminOnly(config, name),
      })),
    });
  }

  async #status(
    config: AgentTagConfig,
    ctx: CommandContext,
    settle: (outcome: "succeeded", reason: string | null) => void,
  ): Promise<void> {
    const now = this.#now().getTime();
    const since = (iso: string | null): number | null => (iso === null ? null : now - Date.parse(iso));
    let payload: SlackOutboxPayload;
    if (ctx.threadTs === null) {
      const status = this.#store.getConversationStatus({ workspaceId: ctx.workspaceId, conversationId: ctx.conversationId });
      payload = replies.conversationStatusReply({ botName: this.#botName, conversationType: ctx.conversationType, ...status });
    } else if (ctx.binding === null) {
      payload = replies.threadStatusReply({
        botName: this.#botName,
        conversationType: ctx.conversationType,
        bound: false,
        muted: false,
        workingForMs: null,
        waitingForMs: null,
        queued: 0,
        model: null,
      });
    } else {
      const status = this.#store.getThreadStatus({
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        threadTs: ctx.threadTs,
        taskId: ctx.binding.taskId,
      });
      payload = replies.threadStatusReply({
        botName: this.#botName,
        conversationType: ctx.conversationType,
        bound: true,
        muted: status.muted,
        workingForMs: since(status.workingSince),
        waitingForMs: since(status.waitingSince),
        queued: status.queued,
        model: this.#threadModel(config, ctx.binding.taskId),
      });
    }
    settle("succeeded", null);
    await this.#ephemeral(ctx, payload);
  }

  /** The model the thread's next turn would use, without a T3 call (`!status` works while T3 is down). */
  #threadModel(config: AgentTagConfig, taskId: string): replies.ThreadStatusView["model"] {
    const task = this.#store.getTaskExecution(taskId);
    const profile = config.profiles.find((candidate) => candidate.id === task.profileId);
    if (profile === undefined) return null;
    const route = config.routes.find((candidate) => candidate.conversationId === task.conversationId);
    const effective = effectiveSelection({
      task: { desired: task.desiredModelSelection, applied: task.appliedModelSelection },
      profile,
      route,
    });
    return { ...effective.selection, override: effective.reason === "desired" };
  }

  async #mute(
    ctx: CommandContext,
    muted: boolean,
    settle: (outcome: "rejected", reason: string | null) => void,
  ): Promise<CommandExecution> {
    if (ctx.threadTs === null) {
      settle("rejected", "top-level");
      await this.#ephemeral(ctx, replies.muteTopLevelReply(this.#botName));
      return { kind: "executed", outcome: "rejected" };
    }
    if (ctx.binding === null) {
      settle("rejected", "unbound-thread");
      await this.#ephemeral(ctx, muted ? replies.MUTE_UNBOUND : replies.UNMUTE_UNBOUND);
      return { kind: "executed", outcome: "rejected" };
    }
    const result = this.#store.setThreadMute({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      threadTs: ctx.threadTs,
      muted,
      actorUserId: ctx.actorUserId,
      source: "command",
      command: { eventKey: ctx.eventKey, profileId: ctx.profileId },
      outbox: {
        taskId: ctx.binding.taskId,
        clientMessageId: `cmd:${ctx.eventKey}`,
        payload: muted ? replies.mutedReply(this.#botName) : replies.unmutedReply(this.#botName),
      },
      now: this.#now().toISOString(),
    });
    if (result === "changed") return { kind: "executed", outcome: "succeeded" };
    await this.#ephemeral(ctx, muted ? replies.ALREADY_MUTED : replies.NOT_MUTED);
    return { kind: "executed", outcome: "rejected" };
  }

  async #ephemeral(ctx: CommandContext, payload: SlackOutboxPayload): Promise<void> {
    try {
      await this.#replies.ephemeral({
        channel: ctx.conversationId,
        user: ctx.actorUserId,
        ...(ctx.threadTs === null ? {} : { threadTs: ctx.threadTs }),
        payload,
      });
    } catch (error) {
      this.#log("command.reply.failed", undefined, slackErrorCode(error));
    }
  }

  /** No event key or text in logs: ids only reach the audit log. */
  #log(event: string, command: string | undefined, errorCode: string): void {
    this.#logger?.({
      level: "warn",
      event,
      at: this.#now().toISOString(),
      ...(command === undefined ? {} : { outcome: command }),
      errorCode,
    });
  }
}
