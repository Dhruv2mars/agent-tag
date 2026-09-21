import { App, LogLevel } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { AgentTagStore } from "../store/store.ts";
import { SlackActionRouter } from "./actions.ts";
import { SlackEventRouter } from "./events.ts";

const authTestSchema = z.object({
  ok: z.literal(true),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
});

export class SlackSocketBridge {
  readonly #app: App;
  readonly #store: AgentTagStore;
  readonly #workerId = `slack-outbox-${crypto.randomUUID()}`;

  private constructor(app: App, store: AgentTagStore) {
    this.#app = app;
    this.#store = store;
  }

  static async create(input: {
    readonly config: AgentTagConfig;
    readonly store: AgentTagStore;
  }): Promise<SlackSocketBridge> {
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
    for (const actionId of [
      "agent-tag.approval.accept",
      "agent-tag.approval.decline",
      "agent-tag.approval.cancel",
      "agent-tag.user-input.answer",
      "agent-tag.user-input.dismiss",
      "agent-tag.turn.cancel",
    ]) {
      app.action(actionId, async ({ ack, body }) => {
        await ack();
        actions.ingest(body);
      });
    }
    return new SlackSocketBridge(app, input.store);
  }

  async start(): Promise<void> {
    await this.#app.start();
  }

  async stop(): Promise<void> {
    await this.#app.stop();
  }

  async deliverNextOutbox(now = new Date().toISOString()): Promise<boolean> {
    const claimed = this.#store.claimNextOutbox({
      workerId: this.#workerId,
      now,
      leaseMs: 30_000,
    });
    if (claimed === null) return false;
    try {
      const response = await this.#app.client.chat.postMessage({
        channel: claimed.conversationId,
        thread_ts: claimed.threadTs,
        text: claimed.payload.text,
        ...(claimed.payload.blocks === undefined ? {} : { blocks: claimed.payload.blocks }),
      });
      const messageTs = z.string().min(1).parse(response.ts);
      this.#store.markOutboxDelivered({
        outboxId: claimed.outboxId,
        workerId: this.#workerId,
        slackMessageTs: messageTs,
        now: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      this.#store.failOutbox({
        outboxId: claimed.outboxId,
        workerId: this.#workerId,
        errorCode: error instanceof Error ? error.name : "SlackDeliveryError",
        retryable: false,
        now: new Date().toISOString(),
      });
      throw error;
    }
  }
}
