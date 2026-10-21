import type { App as SlackApp, types as SlackTypes } from "@slack/bolt";
import { z } from "zod";

import { AgentTagCommands, type CommandReplySender } from "../commands/handler.ts";
import type { AgentTagConfig } from "../config.ts";
import { ACCESS_DENIAL_REASONS, bindMembership } from "../policy/access.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { ServiceLogger } from "../service.ts";
import type { AgentTagStore } from "../store/store.ts";
import type { T3ServerInfo } from "../t3/gateway.ts";
import {
  actionSubject,
  auditAccessDenial,
  DirectMessageAutoRouter,
  eventEnvelope,
  eventSubject,
  isExplicitEvent,
  warmAccess,
} from "./access-ingress.ts";
import { actionPurpose } from "./actions.ts";
import { SLACK_ACTION_IDS, SlackActionRouter, USER_INPUT_MODAL_CALLBACK_ID, type SlackActionResult } from "./actions.ts";
import { renderInteractionCard } from "./cards.ts";
import type { SlackContextSource } from "./context-source.ts";
import { THREAD_CONTEXT_TIMEOUT_MS, type SlackRepliesPage } from "./context.ts";
import { SlackEventRouter, type SlackIngressResult } from "./events.ts";
import { downloadSlackFile, parseSlackFileInfo, type SlackFileClient } from "./files.ts";
import { ChannelMembershipCache, membershipChannels, type ChannelMembershipStatus } from "./membership.ts";
import { SlackMemoryCommands } from "./memory-commands.ts";
import { SlackModelSwitch } from "./model-switch.ts";
import { deliverNextSlackOutbox, type RefreshRenderers, type SlackOutboxOutcome } from "./outbox.ts";
import { renderStatusMessage } from "./status.ts";
import { classifySlackDeliveryError } from "./outbox-policy.ts";
import { ROUTINE_CANCEL_ACTION_ID } from "./routine-replies.ts";
import { SlackRoutines } from "./routines.ts";
import { deliverNextSlackReaction, type SlackReactionOutcome } from "./reactions.ts";
import { installUndiciWebSocketCompat } from "./undici-compat.ts";
import { slackUploadClient, type SlackUploadClient } from "./uploads.ts";
import { SlackUserDirectory, slackErrorCode, type SlackUserKind } from "./users.ts";
import { ConversationVisibilityResolver } from "./visibility.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  /** The bot user's name, used as its display name in command replies. */
  user: z.string().min(1).max(80).optional(),
  /** Documented for bot tokens; absent on older or unusual installs. */
  bot_id: z.string().min(1).optional(),
});

const usersInfoBotSchema = z.object({
  user: z.object({ profile: z.object({ bot_id: z.string().min(1).optional() }).optional() }),
});

/**
 * Agent Tag's own bot ID, used to drop its own posts and edits. `auth.test` documents `bot_id`
 * for bot tokens; when it is absent, `users.info` on the bot user carries it in `profile.bot_id`.
 * A failed lookup (for example a token without `users:read`) leaves only the user-ID filter.
 */
export async function resolveSelfBotId(
  auth: { readonly user_id: string; readonly bot_id?: string | undefined },
  usersInfo: (user: string) => Promise<unknown>,
): Promise<string | undefined> {
  if (auth.bot_id !== undefined) return auth.bot_id;
  try {
    const parsed = usersInfoBotSchema.safeParse(await usersInfo(auth.user_id));
    return parsed.success ? parsed.data.user.profile?.bot_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Web API client options. The outbox owns retries: it classifies each failure and requeues
 * known-not-delivered sends with durable backoff (see outbox-policy.ts). SDK-level retries could
 * double-post after an ambiguous failure, and the SDK's default 429 handling sleeps inline, so 429s
 * are surfaced immediately with their Retry-After instead.
 */
export const SLACK_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  // Abort hung requests well inside the 30s outbox lease so the (ambiguous) outcome is recorded.
  timeout: 20_000,
} as const;

/**
 * Options for the separate client that serves speaker lookups (`users.info`). Lookups never share
 * the outbox client's request queue: a slow or hung lookup holds a slot in its own small queue, so
 * it cannot delay a `chat.postMessage` past the outbox lease. The timeout matches the directory's,
 * so an abandoned lookup frees its slot about when the caller stops waiting for it.
 */
export const SLACK_LOOKUP_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  maxRequestConcurrency: 4,
  timeout: 5_000,
} as const;

/**
 * Options for the client that reads thread history (`conversations.replies`). Like lookups, it has
 * its own queue so a slow history read never delays outbox sends or speaker lookups. The request
 * timeout matches the thread window's wall-clock budget.
 */
export const SLACK_CONTEXT_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  maxRequestConcurrency: 2,
  timeout: THREAD_CONTEXT_TIMEOUT_MS,
} as const;

/**
 * Options for the client that walks channel membership (`conversations.members`, Tier 4). Its own queue,
 * so a large channel's page walk never delays outbox sends, lookups or history reads.
 */
export const SLACK_MEMBERSHIP_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  maxRequestConcurrency: 2,
  timeout: 10_000,
} as const;

/** How long startup waits for the first membership snapshots in `channel-members` mode. */
export const MEMBERSHIP_STARTUP_WAIT_MS = 15_000;
/** How long an event or a click waits for a membership refresh and a kind lookup before deciding. */
export const ACCESS_WARMUP_EVENT_MS = 10_000;
/** Clicks wait less: a modal's trigger id expires 3 s after the click. */
export const ACCESS_WARMUP_ACTION_MS = 2_000;

/** `conversations.members` on its own Web API client (see SLACK_MEMBERSHIP_CLIENT_OPTIONS). */
export async function createSlackMembershipCache(input: {
  readonly botToken: string;
  readonly config: AgentTagConfig;
  readonly store: Pick<AgentTagStore, "recordAccessAudit">;
  readonly users: { cachedKind(userId: string): SlackUserKind };
  readonly logger?: ServiceLogger;
  /** Tests point this at a local fake. */
  readonly slackApiUrl?: string;
}): Promise<ChannelMembershipCache> {
  const { LogLevel, webApi } = await import("@slack/bolt");
  const client = new webApi.WebClient(input.botToken, {
    ...SLACK_MEMBERSHIP_CLIENT_OPTIONS,
    retryConfig: { ...SLACK_MEMBERSHIP_CLIENT_OPTIONS.retryConfig },
    logLevel: LogLevel.WARN,
    ...(input.slackApiUrl === undefined ? {} : { slackApiUrl: input.slackApiUrl }),
  });
  return new ChannelMembershipCache({
    list: (args) => client.conversations.members({ ...args }),
    settings: input.config.access.membership,
    users: input.users,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    onDegraded: ({ conversationId, state, errorCode }) => {
      input.store.recordAccessAudit({
        action: "access.membership.degraded",
        actorId: "agent-tag",
        conversationId,
        result: state,
        source: conversationId,
        metadata: { errorCode },
        createdAt: new Date().toISOString(),
      });
    },
  });
}

/** `conversations.replies` on its own Web API client (see SLACK_CONTEXT_CLIENT_OPTIONS). */
export async function createSlackRepliesReader(input: {
  readonly botToken: string;
  /** Tests point this at a local fake. */
  readonly slackApiUrl?: string;
}): Promise<SlackRepliesPage> {
  const { LogLevel, webApi } = await import("@slack/bolt");
  const client = new webApi.WebClient(input.botToken, {
    ...SLACK_CONTEXT_CLIENT_OPTIONS,
    retryConfig: { ...SLACK_CONTEXT_CLIENT_OPTIONS.retryConfig },
    logLevel: LogLevel.WARN,
    ...(input.slackApiUrl === undefined ? {} : { slackApiUrl: input.slackApiUrl }),
  });
  // The Web API client has no per-call abort; the caller's wall-clock race drops a late response.
  return (args) => client.conversations.replies({ ...args });
}

/** Builds the speaker directory on its own Web API client (see SLACK_LOOKUP_CLIENT_OPTIONS). */
export async function createSlackUserDirectory(input: {
  readonly botToken: string;
  readonly logger?: ServiceLogger;
  /** Tests point this at a local fake. */
  readonly slackApiUrl?: string;
}): Promise<SlackUserDirectory> {
  const { LogLevel, webApi } = await import("@slack/bolt");
  const client = new webApi.WebClient(input.botToken, {
    ...SLACK_LOOKUP_CLIENT_OPTIONS,
    retryConfig: { ...SLACK_LOOKUP_CLIENT_OPTIONS.retryConfig },
    logLevel: LogLevel.WARN,
    ...(input.slackApiUrl === undefined ? {} : { slackApiUrl: input.slackApiUrl }),
  });
  return new SlackUserDirectory({
    lookup: (userId) => client.users.info({ user: userId }),
    lookupTimeoutMs: SLACK_LOOKUP_CLIENT_OPTIONS.timeout,
    maxOutstandingLookups: SLACK_LOOKUP_CLIENT_OPTIONS.maxRequestConcurrency * 2,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
}

/**
 * Shared-file reads (PR-L1): `files.info` on its own Web API client and token-bearing downloads of
 * `url_private_download`. Needs the `files:read` scope; without it `files.info` fails with
 * `missing_scope` and the file is skipped with a reinstall hint.
 */
export async function createSlackFileClient(input: {
  readonly botToken: { exposeToBoundary(): string };
  /** Tests point this at a local fake. */
  readonly slackApiUrl?: string;
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): Promise<SlackFileClient> {
  const { LogLevel, webApi } = await import("@slack/bolt");
  const client = new webApi.WebClient(input.botToken.exposeToBoundary(), {
    ...SLACK_LOOKUP_CLIENT_OPTIONS,
    retryConfig: { ...SLACK_LOOKUP_CLIENT_OPTIONS.retryConfig },
    logLevel: LogLevel.WARN,
    ...(input.slackApiUrl === undefined ? {} : { slackApiUrl: input.slackApiUrl }),
  });
  return {
    // The Web API client has no per-call abort; the materializer checks the signal between files.
    info: async (fileId) => parseSlackFileInfo(await client.files.info({ file: fileId })),
    download: (url, maxBytes, declaredMimeType, signal) =>
      downloadSlackFile({
        url,
        token: input.botToken,
        maxBytes,
        ...(declaredMimeType === undefined ? {} : { declaredMimeType }),
        ...(signal === undefined ? {} : { signal }),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
  };
}

/** Longest Retry-After an only-you command reply waits for its single retry. */
export const COMMAND_REPLY_RETRY_CAP_MS = 5_000;

interface CommandReplyClient {
  readonly chat: {
    postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<unknown>;
    postMessage(args: { channel: string; thread_ts: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  };
}

/**
 * Command replies over the outbox's Web API client (no SDK retries, 429s surfaced). An only-you
 * reply is retried once after a classified retryable failure, waiting Retry-After capped at 5 s;
 * anything else propagates and the handler logs it.
 */
export function createCommandReplySender(
  client: CommandReplyClient,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): CommandReplySender {
  return {
    async ephemeral({ channel, user, threadTs, payload }) {
      const send = () =>
        client.chat.postEphemeral({
          channel,
          user,
          text: payload.text,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
          ...(payload.blocks === undefined ? {} : { blocks: [...payload.blocks] }),
        });
      try {
        await send();
      } catch (error) {
        const failure = classifySlackDeliveryError(error);
        if (failure.kind !== "retryable") throw error;
        await sleep(Math.min(failure.retryAfterMs ?? 1_000, COMMAND_REPLY_RETRY_CAP_MS));
        await send();
      }
    },
    async post({ channel, threadTs, payload }) {
      const result = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: payload.text,
        ...(payload.blocks === undefined ? {} : { blocks: [...payload.blocks] }),
      });
      if (typeof result.ts !== "string") throw new Error("chat.postMessage returned no ts");
      return { ts: result.ts };
    },
  };
}

/** Access hooks around the synchronous routers (see access-ingress.ts). */
export interface SlackIngressAccess {
  /** Warms membership and the account kind; never rejects. */
  warmEvent(body: unknown): Promise<void>;
  /** Audits an explicit request the router ignored, when the access policy denied it. */
  auditEvent(body: unknown, result: SlackIngressResult): void;
}

/**
 * Routes one Slack event; a `!command`, model switch, routine request or memory phrase is executed
 * after the router returns (never inside ingest).
 */
export async function handleSlackEvent(
  input: {
    readonly router: Pick<SlackEventRouter, "ingest">;
    readonly commands: Pick<AgentTagCommands, "execute">;
    readonly routines?: Pick<SlackRoutines, "handle">;
    readonly access?: SlackIngressAccess;
    readonly memory?: Pick<SlackMemoryCommands, "handle">;
    readonly models?: Pick<SlackModelSwitch, "handle">;
  },
  body: unknown,
): Promise<void> {
  await input.access?.warmEvent(body);
  const result = input.router.ingest(body);
  input.access?.auditEvent(body, result);
  if (result.kind === "command") await input.commands.execute(result);
  if (result.kind === "routine") await input.routines?.handle(result);
  if (result.kind === "memory") await input.memory?.handle(result);
  if (result.kind === "model") await input.models?.handle(result);
}

/** Builds the ingress access hooks for a config, a store and (in `channel-members` mode) a cache. */
export function slackIngressAccess(input: {
  readonly config: AgentTagConfig;
  readonly store: Pick<AgentTagStore, "recordAccessAudit">;
  readonly membership: ChannelMembershipCache | null;
  readonly users: { kind(userId: string, signal?: AbortSignal): Promise<SlackUserKind> };
  readonly logger?: ServiceLogger;
  readonly now?: () => string;
}): SlackIngressAccess & {
  warmAction(body: unknown): Promise<void>;
  auditAction(body: unknown, result: SlackActionResult): void;
} {
  const now = input.now ?? (() => new Date().toISOString());
  const audit = (record: () => void): void => {
    // An audit row is evidence, not control flow: a failed write never changes what the user sees.
    try {
      record();
    } catch (error) {
      input.logger?.({ level: "warn", event: "access.audit.failed", at: now(), errorCode: error instanceof Error ? error.name : "unknown" });
    }
  };
  return {
    warmEvent: (body) =>
      warmAccess({ config: input.config, membership: input.membership, users: input.users, deadlineMs: ACCESS_WARMUP_EVENT_MS }, eventSubject(body)),
    warmAction: (body) =>
      warmAccess({ config: input.config, membership: input.membership, users: input.users, deadlineMs: ACCESS_WARMUP_ACTION_MS }, actionSubject(body)),
    auditEvent(body, result) {
      if (result.kind !== "ignored" || !isExplicitEvent(body)) return;
      const subject = eventSubject(body);
      const envelope = eventEnvelope(body);
      if (subject === null || envelope === null) return;
      audit(() =>
        auditAccessDenial({
          config: input.config,
          store: input.store,
          workspaceId: envelope.workspaceId,
          subject,
          purpose: "steer",
          source: envelope.eventId,
          now: now(),
        })
      );
    },
    auditAction(body, result) {
      if (result.kind !== "ignored" || !ACCESS_IGNORED_REASONS.has(result.reason)) return;
      const subject = actionSubject(body);
      const parsed = actionAuditSchema.safeParse(body);
      if (subject === null || !parsed.success) return;
      const action = parsed.data.actions[0];
      if (action === undefined) return;
      audit(() =>
        auditAccessDenial({
          config: input.config,
          store: input.store,
          workspaceId: parsed.data.team.id,
          subject,
          purpose: actionPurpose(action.action_id),
          source: `${parsed.data.team.id}:${subject.user}:${action.action_ts}:${action.action_id}`,
          now: now(),
        })
      );
    },
  };
}

const ACCESS_IGNORED_REASONS: ReadonlySet<string> = new Set(ACCESS_DENIAL_REASONS);

const actionAuditSchema = z.object({
  team: z.object({ id: z.string().min(1) }),
  actions: z.array(z.object({ action_id: z.string(), action_ts: z.string() })),
});

/** Delivery-time renderers for outbox refresh rows, by refresh kind. PR-F adds "status-message". */
export function refreshRenderers(store: AgentTagStore, config: AgentTagConfig): RefreshRenderers {
  return {
    "interaction-card": (interactionId) => {
      const view = store.getInteractionCardView(interactionId);
      return view === null ? null : renderInteractionCard(view, { expirySeconds: config.limits.interactionExpirySeconds });
    },
    "status-message": (operationId) => {
      const view = store.getStatusMessageView(operationId);
      return view === null ? null : renderStatusMessage(view, { showProgress: config.slack.ui.statusProgress });
    },
  };
}

/** Bolt's `respond` for an action: posts to the action's response_url. */
export type SlackRespond = (message: {
  readonly response_type: "ephemeral";
  readonly replace_original: false;
  readonly text: string;
}) => Promise<unknown>;

/**
 * Handles one acked block action. A click on a request that is no longer pending changes nothing and
 * gets one ephemeral saying how it was handled; a click on an expired one says so. Feedback is best
 * effort: a failed `respond` is logged, never retried.
 */
export async function handleBlockAction(
  input: {
    readonly actions: Pick<SlackActionRouter, "ingest">;
    readonly openView: (triggerId: string, view: SlackTypes.ModalView) => Promise<unknown>;
    readonly respond: SlackRespond;
    readonly logger?: ServiceLogger;
  },
  body: unknown,
): Promise<SlackActionResult> {
  const result = input.actions.ingest(body);
  // Free-text and multi-select answers are collected in a modal; trigger ids expire in 3 seconds.
  if (result.kind === "open-modal") {
    await input.openView(result.triggerId, result.view);
    return result;
  }
  const feedback = result.kind === "duplicate"
    ? result.resolution
    : result.kind === "ignored" && result.reason === "interaction-expired"
    ? "This request has expired and can no longer be answered."
    : null;
  if (feedback !== null) {
    try {
      await input.respond({ response_type: "ephemeral", replace_original: false, text: feedback });
    } catch (error) {
      input.logger?.({
        level: "warn",
        event: "slack.action.feedback_failed",
        at: new Date().toISOString(),
        errorCode: slackErrorCode(error),
      });
    }
  }
  return result;
}

export class SlackSocketBridge {
  readonly #app: SlackApp;
  readonly #store: AgentTagStore;
  readonly #config: AgentTagConfig;
  readonly #workerId = `slack-outbox-${crypto.randomUUID()}`;
  readonly #refreshRenderers: RefreshRenderers;
  /** Read-only Slack lookups for turn composition (speaker labels, thread window). */
  readonly contextSource: SlackContextSource;
  /** Channel membership snapshots; null unless `access.mode` is `channel-members`. */
  readonly membership: ChannelMembershipCache | null;
  /** Shared-file reads for the coordinator (PR-L1). */
  readonly files: SlackFileClient;
  /**
   * Agent file shares (PR-L2) over the outbox's client: no SDK retries, so the upload worker owns
   * every retry and a completed share is never repeated. Needs `files:write` (and `files:read` for
   * the crash-recovery share check).
   */
  readonly uploads: SlackUploadClient;

  private constructor(
    app: SlackApp,
    store: AgentTagStore,
    config: AgentTagConfig,
    contextSource: SlackContextSource,
    membership: ChannelMembershipCache | null,
    files: SlackFileClient,
  ) {
    this.#app = app;
    this.#store = store;
    this.#config = config;
    this.#refreshRenderers = refreshRenderers(store, config);
    this.contextSource = contextSource;
    this.membership = membership;
    this.files = files;
    this.uploads = slackUploadClient(app.client);
  }

  static async create(input: {
    readonly config: AgentTagConfig;
    readonly store: AgentTagStore;
    /** The T3 provider catalog, for model switches from Slack. */
    readonly catalog?: { current(): T3ServerInfo | null };
    readonly logger?: ServiceLogger;
  }): Promise<SlackSocketBridge> {
    installUndiciWebSocketCompat();
    const { App, LogLevel } = await import("@slack/bolt");
    const [appToken, botToken] = await Promise.all([
      readSecretFile(input.config.slack.appTokenFile),
      readSecretFile(input.config.slack.botTokenFile),
    ]);
    const app = new App({
      token: botToken.exposeToBoundary(),
      appToken: appToken.exposeToBoundary(),
      socketMode: true,
      logLevel: LogLevel.WARN,
      clientOptions: SLACK_CLIENT_OPTIONS,
    });
    const auth = authTestSchema.parse(await app.client.auth.test());
    if (auth.team_id !== input.config.slack.workspaceId) {
      throw new Error(
        `Slack bot belongs to workspace ${auth.team_id}, expected ${input.config.slack.workspaceId}`,
      );
    }
    const selfBotId = await resolveSelfBotId(auth, (user) => app.client.users.info({ user }));
    const eventRouter = (config: AgentTagConfig): SlackEventRouter =>
      new SlackEventRouter({
        config,
        store: input.store,
        botUserId: auth.user_id,
        ...(selfBotId === undefined ? {} : { selfBotId }),
        ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
      });
    const router = new DirectMessageAutoRouter({ config: input.config, base: eventRouter(input.config), create: eventRouter });
    const commandReplies = createCommandReplySender(app.client as unknown as CommandReplyClient);
    const commands = new AgentTagCommands({
      config: () => input.config,
      store: input.store,
      replies: commandReplies,
      ...(auth.user === undefined ? {} : { botName: auth.user }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    // users:read: speaker labels for thread context, the requester's zone for routines, guest/bot kind.
    const users = await createSlackUserDirectory({
      botToken: botToken.exposeToBoundary(),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    // channels:read / groups:read: who is in an allowed channel, only in channel-members mode.
    const membership = input.config.access.mode === "channel-members"
      ? await createSlackMembershipCache({
        botToken: botToken.exposeToBoundary(),
        config: input.config,
        store: input.store,
        users,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      })
      : null;
    if (membership !== null) bindMembership(input.config, membership);
    const access = slackIngressAccess({
      config: input.config,
      store: input.store,
      membership,
      users,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const routines = new SlackRoutines({
      config: () => input.config,
      store: input.store,
      users,
      replies: commandReplies,
      ...(auth.user === undefined ? {} : { botName: auth.user }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    // channels:read / groups:read: whether a channel is public, for workspace notes. Without them the
    // lookup fails, visibility is unknown and only workspace writes are refused.
    const visibility = new ConversationVisibilityResolver({
      config: () => input.config,
      conversationsInfo: (channel) => app.client.conversations.info({ channel }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const memory = new SlackMemoryCommands({
      config: () => input.config,
      store: input.store,
      replies: commandReplies,
      visibility,
      users,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const models = new SlackModelSwitch({
      config: () => input.config,
      store: input.store,
      replies: commandReplies,
      ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
      ...(auth.user === undefined ? {} : { botName: auth.user }),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const actions = new SlackActionRouter({ config: input.config, store: input.store });
    app.event("app_mention", async ({ body }) => {
      await handleSlackEvent({ router, commands, routines, access, memory, models }, body);
    });
    app.event("message", async ({ body }) => {
      await handleSlackEvent({ router, commands, routines, access, memory, models }, body);
    });
    app.action(ROUTINE_CANCEL_ACTION_ID, async ({ ack, body, respond }) => {
      await ack();
      await access.warmAction(body);
      await routines.cancelFromAction(body, (text) => respond({ response_type: "ephemeral", replace_original: false, text }));
    });
    for (const actionId of SLACK_ACTION_IDS) {
      app.action(actionId, async ({ ack, body, client, respond }) => {
        await ack();
        await access.warmAction(body);
        const result = await handleBlockAction({
          actions,
          openView: (triggerId, view) => client.views.open({ trigger_id: triggerId, view }),
          respond,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        }, body);
        access.auditAction(body, result);
      });
    }
    app.view(USER_INPUT_MODAL_CALLBACK_ID, async ({ ack, body }) => {
      const result = actions.ingestViewSubmission(body);
      if (result.kind === "invalid-input") {
        await ack({ response_action: "errors", errors: { ...result.errors } });
      } else {
        await ack();
      }
    });
    const replies = await createSlackRepliesReader({ botToken: botToken.exposeToBoundary() });
    const contextSource: SlackContextSource = {
      botUserId: auth.user_id,
      ...(selfBotId === undefined ? {} : { selfBotId }),
      users,
      replies,
    };
    const files = await createSlackFileClient({ botToken });
    return new SlackSocketBridge(app, input.store, input.config, contextSource, membership, files);
  }

  /** Refreshes every due routed channel; the service's membership worker calls this each tick. */
  async refreshMembership(): Promise<void> {
    await this.membership?.refreshAll(membershipChannels(this.#config));
  }

  /** Per routed channel snapshot state, for doctor and logs. Empty in `allowlist` mode. */
  membershipStatus(): ReadonlyArray<ChannelMembershipStatus> {
    const membership = this.membership;
    return membership === null ? [] : membershipChannels(this.#config).map((id) => membership.status(id));
  }

  async start(): Promise<void> {
    // Read channel membership before the service's workers re-check queued work, so a restart does not
    // deny members for `membership-unknown`. Bounded: a slow Slack never holds startup.
    await Promise.race([this.refreshMembership(), Bun.sleep(MEMBERSHIP_STARTUP_WAIT_MS)]);
    await this.#app.start();
  }

  async stop(): Promise<void> {
    await this.#app.stop();
  }

  /** `chat.getPermalink` for a thread root (no extra scope); undefined unless Slack returns an https URL. */
  async threadPermalink(conversationId: string, threadTs: string): Promise<string | undefined> {
    const result = await this.#app.client.chat.getPermalink({ channel: conversationId, message_ts: threadTs });
    const permalink = result.permalink;
    return typeof permalink === "string" && permalink.startsWith("https://") ? permalink : undefined;
  }

  /** Queued ack reactions go first, so an ack never waits behind a backlog of replies. */
  async deliverNextOutbox(): Promise<SlackOutboxOutcome | SlackReactionOutcome> {
    const reaction = await deliverNextSlackReaction({
      config: this.#config,
      store: this.#store,
      workerId: this.#workerId,
      // reactions:write; without it every ack fails with missing_scope and the task is unaffected.
      addReaction: (input) => this.#app.client.reactions.add(input),
    });
    if (reaction.kind !== "idle") return reaction;
    return deliverNextSlackOutbox({
      config: this.#config,
      store: this.#store,
      workerId: this.#workerId,
      postMessage: (message) => this.#app.client.chat.postMessage(message),
      // Needs only chat:write (a bot may edit its own messages), so no scope or manifest change.
      updateMessage: (message) => this.#app.client.chat.update(message),
      refreshRenderers: this.#refreshRenderers,
    });
  }
}
