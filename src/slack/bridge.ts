import type { App as SlackApp } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { ServiceLogger } from "../service.ts";
import type { AgentTagStore } from "../store/store.ts";
import { SLACK_ACTION_IDS, SlackActionRouter, USER_INPUT_MODAL_CALLBACK_ID } from "./actions.ts";
import type { SlackContextSource } from "./context-source.ts";
import { THREAD_CONTEXT_TIMEOUT_MS, type SlackRepliesPage } from "./context.ts";
import { SlackEventRouter } from "./events.ts";
import { deliverNextSlackOutbox, type RefreshRenderers, type SlackOutboxOutcome } from "./outbox.ts";
import { installUndiciWebSocketCompat } from "./undici-compat.ts";
import { SlackUserDirectory } from "./users.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  /** Documented for bot tokens; absent on older or unusual installs. */
  bot_id: z.string().min(1).optional(),
});

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

/** Delivery-time renderers for outbox refresh rows. None yet: PR-I I2 and PR-F register theirs here. */
const REFRESH_RENDERERS: RefreshRenderers = {};

export class SlackSocketBridge {
  readonly #app: SlackApp;
  readonly #store: AgentTagStore;
  readonly #config: AgentTagConfig;
  readonly #workerId = `slack-outbox-${crypto.randomUUID()}`;
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
    const router = new SlackEventRouter({
      config: input.config,
      store: input.store,
      botUserId: auth.user_id,
      ...(auth.bot_id === undefined ? {} : { selfBotId: auth.bot_id }),
    });
    const actions = new SlackActionRouter({ config: input.config, store: input.store });
    app.event("app_mention", async ({ body }) => {
      router.ingest(body);
    });
    app.event("message", async ({ body }) => {
      router.ingest(body);
    });
    for (const actionId of SLACK_ACTION_IDS) {
      app.action(actionId, async ({ ack, body, client }) => {
        await ack();
        const result = actions.ingest(body);
        // Free-text and multi-select answers are collected in a modal; trigger ids expire in 3 seconds.
        if (result.kind === "open-modal") {
          await client.views.open({ trigger_id: result.triggerId, view: result.view });
        }
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
      ...(auth.bot_id === undefined ? {} : { selfBotId: auth.bot_id }),
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

  async deliverNextOutbox(): Promise<SlackOutboxOutcome> {
    return deliverNextSlackOutbox({
      config: this.#config,
      store: this.#store,
      workerId: this.#workerId,
      postMessage: (message) => this.#app.client.chat.postMessage(message),
      // Needs only chat:write (a bot may edit its own messages), so no scope or manifest change.
      updateMessage: (message) => this.#app.client.chat.update(message),
      refreshRenderers: REFRESH_RENDERERS,
    });
  }
}
