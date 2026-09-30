import type { App as SlackApp } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { AgentTagStore } from "../store/store.ts";
import { SLACK_ACTION_IDS, SlackActionRouter } from "./actions.ts";
import { SlackEventRouter } from "./events.ts";
import { deliverNextSlackOutbox } from "./outbox.ts";
import { installUndiciWebSocketCompat } from "./undici-compat.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
});

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
      clientOptions: { retryConfig: { retries: 0 } },
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
      app.action(actionId, async ({ ack, body }) => {
        await ack();
        actions.ingest(body);
      });
    }
    return new SlackSocketBridge(app, input.store, input.config);
  }

  async start(): Promise<void> {
    await this.#app.start();
  }

  async stop(): Promise<void> {
    await this.#app.stop();
  }

  async deliverNextOutbox(): Promise<boolean> {
    return deliverNextSlackOutbox({
      config: this.#config,
      store: this.#store,
      workerId: this.#workerId,
      postMessage: (message) => this.#app.client.chat.postMessage(message),
    });
  }
}
