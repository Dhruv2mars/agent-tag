import { z } from "zod";

import type { CommandIngress } from "../commands/context.ts";
import { IMPLEMENTED_COMMANDS, isCommandUsage, parseAgentCommand } from "../commands/parse.ts";
import type { AgentTagConfig } from "../config.ts";
import { AgentTagStore, type ActiveTaskBinding, type IngestReceipt } from "../store/store.ts";

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const slackTimestamp = z.string().regex(/^\d{1,20}\.\d{1,9}$/);
const slackFile = z.object({ name: z.string().optional(), title: z.string().optional() }).passthrough();
const messageFields = {
  channel: slackId,
  ts: slackTimestamp,
  thread_ts: slackTimestamp.optional(),
  text: z.string().default(""),
  /** Absent on bot_message. */
  user: slackId.optional(),
  bot_id: slackId.optional(),
  app_id: slackId.optional(),
  username: z.string().max(200).optional(),
  bot_profile: z.object({ name: z.string().max(200).optional() }).passthrough().optional(),
  subtype: z.string().optional(),
  edited: z.object({ user: z.string().optional(), ts: slackTimestamp.optional() }).passthrough().optional(),
  files: z.array(slackFile).max(20).optional(),
};
const innerMessage = z
  .object({ ...messageFields, reply_count: z.number().int().nonnegative().optional() })
  .omit({ channel: true })
  .extend({ channel: slackId.optional() });
const messageChanged = z.object({
  type: z.literal("message"),
  subtype: z.literal("message_changed"),
  channel: slackId,
  /** ts of the change event itself, not of the edited message. */
  ts: slackTimestamp,
  message: innerMessage,
  previous_message: innerMessage.partial().optional(),
});
const plainEvent = z.object({ type: z.enum(["app_mention", "message"]), ...messageFields });
const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().min(1),
  team_id: slackId,
  // message_changed first: a plain message schema would also accept it, without its inner message.
  event: z.union([messageChanged, plainEvent]),
});
type MessageChangedEvent = z.infer<typeof messageChanged>;
type PlainEvent = z.infer<typeof plainEvent>;
type Route = AgentTagConfig["routes"][number];
type Profile = AgentTagConfig["profiles"][number];

/** Human subtypes that may trigger a turn. `file_share` stays ignored until file support lands. */
const TRIGGER_SUBTYPES = new Set([undefined, "thread_broadcast"]);
/** Bot subtypes recorded as context notes. */
const BOT_NOTE_SUBTYPES = new Set([undefined, "bot_message", "thread_broadcast"]);

export type SlackIngressResult =
  | { readonly kind: "accepted" | "duplicate"; readonly receipt: IngestReceipt }
  | { readonly kind: "noted"; readonly noteId: string; readonly duplicate: boolean }
  /** An `@bot !command`: no ingest, no task, no operation. The bridge runs it (commands/handler.ts). */
  | CommandIngress
  | {
      readonly kind: "ignored";
      readonly reason:
        | "invalid-event"
        | "workspace-denied"
        | "channel-denied"
        | "self-event"
        | "user-denied"
        | "bot-event"
        | "message-subtype"
        | "unrouted-channel"
        | "unbound-thread"
        | "unbound-edit"
        | "ambient-disabled"
        | "ambient-not-relevant"
        | "ambient-quiet"
        | "dm-owner-denied"
        | "task-route-denied"
        | "edit-irrelevant"
        | "thread-muted"
        | "command-handled";
    };
type IgnoredReason = Extract<SlackIngressResult, { kind: "ignored" }>["reason"];

export interface SlackEventRouterOptions {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly botUserId: string;
  /** `auth.test.bot_id`: the agent's own bot ID, so its `chat.update` echoes are dropped unwritten. */
  readonly selfBotId?: string;
  readonly now?: () => string;
}

/** Who a note is from, after the speaker policy allowed it. */
interface NoteSpeaker {
  readonly speakerKind: "human" | "bot";
  readonly speakerId: string;
  readonly speakerLabel: string | null;
  readonly steeringAllowed: boolean;
}

function ignored(reason: IgnoredReason): SlackIngressResult {
  return { kind: "ignored", reason };
}

function isBotMessage(message: { readonly bot_id?: string | undefined; readonly subtype?: string | undefined }): boolean {
  return message.bot_id !== undefined || message.subtype === "bot_message";
}

export class SlackEventRouter {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #botUserId: string;
  readonly #selfBotId: string | undefined;
  readonly #now: () => string;

  constructor(options: SlackEventRouterOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#botUserId = slackId.parse(options.botUserId);
    this.#selfBotId = options.selfBotId === undefined ? undefined : slackId.parse(options.selfBotId);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  ingest(input: unknown): SlackIngressResult {
    const parsed = slackEventCallbackSchema.safeParse(input);
    if (!parsed.success) return ignored("invalid-event");
    const body = parsed.data;
    const event = body.event;
    if (body.team_id !== this.#config.slack.workspaceId) return ignored("workspace-denied");
    if (!this.#config.access.allowedChannelIds.includes(event.channel)) return ignored("channel-denied");
    // First, before any store call: the agent's own posts and chat.update echoes cost nothing.
    if (this.#isSelf("message" in event ? event.message : event)) return ignored("self-event");
    // Route lookup is pure config, so it can precede the speaker checks that depend on the profile.
    const route = this.#config.routes.find((candidate) => candidate.conversationId === event.channel);
    if (route === undefined) return ignored("unrouted-channel");
    const profile = this.#config.profiles.find((candidate) => candidate.id === route.profileId);
    if (profile === undefined) throw new Error(`validated route references missing profile ${route.profileId}`);
    if ("message" in event) return this.#ingestEdit(body.team_id, body.event_id, event, route, profile);
    return this.#ingestMessage(body.team_id, body.event_id, event, route, profile);
  }

  #isSelf(message: { readonly user?: string | undefined; readonly bot_id?: string | undefined }): boolean {
    return message.user === this.#botUserId || (this.#selfBotId !== undefined && message.bot_id === this.#selfBotId);
  }

  /** One place decides who may steer, so a later access mode swaps a single function. */
  #isSteeringAllowed(userId: string): boolean {
    return this.#config.access.allowedUserIds.includes(userId);
  }

  /** `<@BOT>` or `<@BOT|label>` anywhere in the text. */
  #mentionsBot(text: string): boolean {
    return text.includes(`<@${this.#botUserId}>`) || text.includes(`<@${this.#botUserId}|`);
  }

  /**
   * An implemented `!command`, or null for an ordinary prompt. In a DM the bare form (no mention) also
   * counts, since nobody mentions a bot in a 1:1 DM. Commands not implemented yet stay prompts.
   */
  #parseCommand(text: string, route: Route): CommandIngress["command"] | null {
    if (!this.#config.commands.enabled) return null;
    const command = parseAgentCommand(text, { botUserId: this.#botUserId, allowBare: route.conversationType === "dm" });
    if (command === null || isCommandUsage(command)) return null;
    return (IMPLEMENTED_COMMANDS as ReadonlyArray<string>).includes(command.name) ? command : null;
  }

  #findBinding(workspaceId: string, conversationId: string, threadTs: string): ActiveTaskBinding | null {
    return this.#store.findActiveTask({ workspaceId, conversationId, threadTs });
  }

  /**
   * The speaker policy for context notes (messages and edits alike): bots per `includeBotMessages`,
   * non-allowlisted humans per `includeNonAllowedUsers`, and only on channel routes. Returns the reason
   * to ignore instead when the speaker may not contribute context.
   */
  #noteSpeaker(
    message: PlainEvent | MessageChangedEvent["message"],
    route: Route,
    profile: Profile,
  ): NoteSpeaker | IgnoredReason {
    if (isBotMessage(message)) {
      if (route.conversationType !== "channel" || profile.threadContext.includeBotMessages === "none") {
        return "bot-event";
      }
      const speakerId = message.bot_id ?? message.user;
      if (speakerId === undefined) return "bot-event";
      return {
        speakerKind: "bot",
        speakerId,
        speakerLabel: message.bot_profile?.name ?? message.username ?? null,
        steeringAllowed: false,
      };
    }
    if (message.user === undefined) return "invalid-event";
    if (route.conversationType === "dm" && message.user !== route.ownerUserId) return "dm-owner-denied";
    if (this.#isSteeringAllowed(message.user)) {
      return { speakerKind: "human", speakerId: message.user, speakerLabel: null, steeringAllowed: true };
    }
    if (route.conversationType !== "channel" || !profile.threadContext.includeNonAllowedUsers) return "user-denied";
    return { speakerKind: "human", speakerId: message.user, speakerLabel: null, steeringAllowed: false };
  }

  /** An edit is context for a bound thread's next turn. It never creates a task or an operation. */
  #ingestEdit(
    workspaceId: string,
    deliveryId: string,
    event: MessageChangedEvent,
    route: Route,
    profile: Profile,
  ): SlackIngressResult {
    const message = event.message;
    // Unfurls, metadata and attachment-only updates keep the text; tombstones are deletions.
    if (
      message.subtype === "tombstone" ||
      (message.thread_ts === undefined && message.reply_count === undefined) ||
      event.previous_message?.text === message.text
    ) {
      return ignored("edit-irrelevant");
    }
    const threadTs = message.thread_ts ?? message.ts;
    if (this.#findBinding(workspaceId, event.channel, threadTs) === null) return ignored("unbound-edit");
    const speaker = this.#noteSpeaker(message, route, profile);
    if (typeof speaker === "string") return ignored(speaker);
    const messageKey = `${event.channel}:${message.ts}`;
    const editTs = message.edited?.ts ?? event.ts;
    const previousText = event.previous_message?.text ?? this.#store.findIngestedText(workspaceId, messageKey);
    const note = this.#store.recordThreadNote({
      workspaceId,
      conversationId: event.channel,
      threadTs,
      sourceEventKey: `${messageKey}:edit:${editTs}`,
      sourceDeliveryId: deliveryId,
      kind: "edit",
      ...speaker,
      messageTs: message.ts,
      text: message.text,
      previousText,
      sourceOrderKey: editTs,
      now: z.iso.datetime().parse(this.#now()),
    });
    return note === null ? ignored("unbound-edit") : { kind: "noted", ...note };
  }

  /** Records a bot or non-allowlisted message in a bound channel thread as a context note. */
  #ingestNote(
    workspaceId: string,
    deliveryId: string,
    event: PlainEvent,
    speaker: NoteSpeaker,
    threadTs: string,
  ): SlackIngressResult | null {
    const note = this.#store.recordThreadNote({
      workspaceId,
      conversationId: event.channel,
      threadTs,
      sourceEventKey: `${event.channel}:${event.ts}`,
      sourceDeliveryId: deliveryId,
      kind: "message",
      ...speaker,
      messageTs: event.ts,
      text: event.text,
      previousText: null,
      sourceOrderKey: event.ts,
      now: z.iso.datetime().parse(this.#now()),
    });
    return note === null ? null : { kind: "noted", ...note };
  }

  #ingestMessage(
    workspaceId: string,
    deliveryId: string,
    event: PlainEvent,
    route: Route,
    profile: Profile,
  ): SlackIngressResult {
    const threadTs = event.thread_ts ?? event.ts;
    // Bots never trigger. In a bound channel thread they are context, per includeBotMessages.
    if (isBotMessage(event)) {
      if (!BOT_NOTE_SUBTYPES.has(event.subtype)) return ignored("bot-event");
      const speaker = this.#noteSpeaker(event, route, profile);
      if (typeof speaker === "string" || this.#findBinding(workspaceId, event.channel, threadTs) === null) {
        return ignored("bot-event");
      }
      return this.#ingestNote(workspaceId, deliveryId, event, speaker, threadTs) ?? ignored("bot-event");
    }
    if (!TRIGGER_SUBTYPES.has(event.subtype)) return ignored("message-subtype");
    if (event.user === undefined) return ignored("invalid-event");
    const actorUserId = event.user;
    if (!this.#isSteeringAllowed(actorUserId)) {
      // In a DM only the owner counts, so anyone else is a DM denial rather than an allowlist one.
      if (route.conversationType === "dm") {
        return ignored(actorUserId === route.ownerUserId ? "user-denied" : "dm-owner-denied");
      }
      const speaker = this.#noteSpeaker(event, route, profile);
      if (typeof speaker === "string" || this.#findBinding(workspaceId, event.channel, threadTs) === null) {
        return ignored("user-denied");
      }
      return this.#ingestNote(workspaceId, deliveryId, event, speaker, threadTs) ?? ignored("user-denied");
    }
    // Slack does not document whether app_mention re-fires when a message is edited to add the
    // mention. An edit never starts work, so a mention carrying `edited` is dropped either way.
    if (event.type === "app_mention" && event.edited !== undefined) return ignored("edit-irrelevant");

    const eventKey = `${event.channel}:${event.ts}`;
    const receivedAt = z.iso.datetime().parse(this.#now());
    if (route.conversationType === "dm" && actorUserId !== route.ownerUserId) return ignored("dm-owner-denied");
    const selectedRoot = route.repositoryRoot ?? profile.repositoryRoots[0];
    if (selectedRoot === undefined) throw new Error(`validated profile ${profile.id} has no repository root`);
    // Commands run after every access check, so a user who may not message the bot stays unanswered.
    const command = this.#parseCommand(event.text, route);
    if (command !== null) {
      const commandThreadTs = event.thread_ts ?? null;
      return {
        kind: "command",
        command,
        context: {
          deliveryId,
          eventKey,
          workspaceId,
          conversationId: event.channel,
          conversationType: route.conversationType,
          threadTs: commandThreadTs,
          messageTs: event.ts,
          actorUserId,
          profileId: route.profileId,
          repositoryRoot: selectedRoot,
          binding: commandThreadTs === null ? null : this.#findBinding(workspaceId, event.channel, commandThreadTs),
          receivedAt,
        },
      };
    }
    // Already answered as a command (before a config change turned commands off): never a prompt too.
    if (this.#store.isCommandEvent({ workspaceId, eventKey })) return ignored("command-handled");
    const binding = this.#findBinding(workspaceId, event.channel, threadTs);
    const explicitMention = this.#mentionsBot(event.text);
    let profileId: string;
    let repositoryRoot: string;
    if (binding !== null) {
      if (
        binding.profileId !== route.profileId ||
        binding.repositoryRoot !== selectedRoot ||
        binding.conversationType !== route.conversationType ||
        binding.ownerUserId !== (route.conversationType === "dm" ? route.ownerUserId : null)
      ) {
        return ignored("task-route-denied");
      }
      // A muted thread only takes requests that mention the bot; such a mention unmutes it (below).
      if (!explicitMention && this.#store.isThreadMuted({ workspaceId, conversationId: event.channel, threadTs })) {
        return ignored("thread-muted");
      }
      profileId = binding.profileId;
      repositoryRoot = binding.repositoryRoot;
    } else {
      if (event.type === "message" && event.thread_ts !== undefined) return ignored("unbound-thread");
      if (event.type === "message" && !explicitMention && route.conversationType === "channel") {
        if (!profile.ambient.enabled) return ignored("ambient-disabled");
        const normalized = event.text.toLowerCase();
        if (!profile.ambient.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
          return ignored("ambient-not-relevant");
        }
        const decision = this.#store.evaluateAmbient({
          workspaceId,
          conversationId: event.channel,
          eventKey,
          actorUserId,
          text: event.text,
          cooldownSeconds: profile.ambient.cooldownSeconds,
          maxTurnsPerHour: profile.ambient.maxTurnsPerHour,
          now: receivedAt,
        });
        if (decision.kind === "quiet") return ignored("ambient-quiet");
      }
      profileId = profile.id;
      repositoryRoot = selectedRoot;
    }

    // First mention partway into an existing thread: the coordinator reads the earlier messages.
    // Only an explicit mention gets here for an unbound reply (plain replies stop at unbound-thread).
    const firstMentionInThread = binding === null && event.thread_ts !== undefined && event.thread_ts !== event.ts;
    const threadContext = firstMentionInThread && profile.threadContext.enabled
      ? { rootTs: threadTs, beforeTs: event.ts }
      : undefined;
    const text = event.text.replaceAll(`<@${this.#botUserId}>`, "").trim();
    const receipt = this.#store.ingestSlackEvent({
      deliveryId,
      eventKey,
      workspaceId,
      conversationId: event.channel,
      threadTs,
      actorUserId,
      conversationType: route.conversationType,
      profileId,
      repositoryRoot,
      text,
      receivedAt,
      sourceOrderKey: event.ts,
      messageTs: event.ts,
      origin: "slack",
      ...(threadContext === undefined ? {} : { threadContext }),
      ...(binding !== null && explicitMention ? { unmuteThread: true } : {}),
    });
    return { kind: receipt.kind, receipt };
  }
}
