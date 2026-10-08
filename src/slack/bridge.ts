import type { App as SlackApp } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { AgentTagStore } from "../store/store.ts";
import { SLACK_ACTION_IDS, SlackActionRouter, USER_INPUT_MODAL_CALLBACK_ID } from "./actions.ts";
import { SlackEventRouter } from "./events.ts";
import { deliverNextSlackOutbox, type RefreshRenderers, type SlackOutboxOutcome } from "./outbox.ts";
import { installUndiciWebSocketCompat } from "./undici-compat.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
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

/** Delivery-time renderers for outbox refresh rows. None yet: PR-I I2 and PR-F register theirs here. */
const REFRESH_RENDERERS: RefreshRenderers = {};

export class SlackSocketBridge {
  readonly #app: SlackApp;
  readonly #store: AgentTagStore;
  readonly #config: AgentTagConfig;
  readonly #workerId = `slack-outbox-${crypto.randomUUID()}`;

  private constructor(app: SlackApp, store: AgentTagStore, config: AgentTagConfig) {
    this.#app = app;
    this.#store = store;
    this.#config = config;
  }

  static async create(input: {
    readonly config: AgentTagConfig;
    readonly store: AgentTagStore;
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
    return new SlackSocketBridge(app, input.store, input.config);
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
