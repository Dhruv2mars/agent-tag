import type { App as SlackApp, types as SlackTypes } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { ServiceLogger } from "../service.ts";
import type { AgentTagStore } from "../store/store.ts";
import { SLACK_ACTION_IDS, SlackActionRouter, USER_INPUT_MODAL_CALLBACK_ID, type SlackActionResult } from "./actions.ts";
import { renderInteractionCard } from "./cards.ts";
import type { SlackContextSource } from "./context-source.ts";
import { THREAD_CONTEXT_TIMEOUT_MS, type SlackRepliesPage } from "./context.ts";
import { SlackEventRouter } from "./events.ts";
import { deliverNextSlackOutbox, type RefreshRenderers, type SlackOutboxOutcome } from "./outbox.ts";
import { deliverNextSlackReaction, type SlackReactionOutcome } from "./reactions.ts";
import { installUndiciWebSocketCompat } from "./undici-compat.ts";
import { SlackUserDirectory, slackErrorCode } from "./users.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
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

/** Delivery-time renderers for outbox refresh rows, by refresh kind. PR-F adds "status-message". */
export function refreshRenderers(store: AgentTagStore, config: AgentTagConfig): RefreshRenderers {
  return {
    "interaction-card": (interactionId) => {
      const view = store.getInteractionCardView(interactionId);
      return view === null ? null : renderInteractionCard(view, { expirySeconds: config.limits.interactionExpirySeconds });
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

  private constructor(
    app: SlackApp,
    store: AgentTagStore,
    config: AgentTagConfig,
    contextSource: SlackContextSource,
  ) {
    this.#app = app;
    this.#store = store;
    this.#config = config;
    this.#refreshRenderers = refreshRenderers(store, config);
    this.contextSource = contextSource;
  }

  static async create(input: {
    readonly config: AgentTagConfig;
    readonly store: AgentTagStore;
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
    const router = new SlackEventRouter({
      config: input.config,
      store: input.store,
      botUserId: auth.user_id,
      ...(selfBotId === undefined ? {} : { selfBotId }),
    });
    const actions = new SlackActionRouter({ config: input.config, store: input.store });
    app.event("app_mention", async ({ body }) => {
      router.ingest(body);
    });
    app.event("message", async ({ body }) => {
      router.ingest(body);
    });
    for (const actionId of SLACK_ACTION_IDS) {
      app.action(actionId, async ({ ack, body, client, respond }) => {
        await ack();
        await handleBlockAction({
          actions,
          openView: (triggerId, view) => client.views.open({ trigger_id: triggerId, view }),
          respond,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        }, body);
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
    const users = await createSlackUserDirectory({
      botToken: botToken.exposeToBoundary(),
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    });
    const replies = await createSlackRepliesReader({ botToken: botToken.exposeToBoundary() });
    const contextSource: SlackContextSource = {
      botUserId: auth.user_id,
      ...(selfBotId === undefined ? {} : { selfBotId }),
      users,
      replies,
    };
    return new SlackSocketBridge(app, input.store, input.config, contextSource);
  }

  async start(): Promise<void> {
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
