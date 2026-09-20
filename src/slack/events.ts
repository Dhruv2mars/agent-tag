import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { AgentTagStore, type IngestReceipt } from "../store/store.ts";

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const slackTimestamp = z.string().regex(/^\d{1,20}\.\d{1,9}$/);
const baseMessage = z.object({
  user: slackId,
  channel: slackId,
  ts: slackTimestamp,
  thread_ts: slackTimestamp.optional(),
  text: z.string(),
  bot_id: slackId.optional(),
  subtype: z.string().optional(),
});
const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().min(1),
  team_id: slackId,
  event: z.discriminatedUnion("type", [
    baseMessage.extend({ type: z.literal("app_mention") }),
    baseMessage.extend({ type: z.literal("message") }),
  ]),
});

export type SlackIngressResult =
  | { readonly kind: "accepted" | "duplicate"; readonly receipt: IngestReceipt }
  | {
      readonly kind: "ignored";
      readonly reason:
        | "invalid-event"
        | "workspace-denied"
        | "channel-denied"
        | "user-denied"
        | "bot-event"
        | "message-subtype"
        | "unrouted-channel"
        | "unbound-thread";
    };

export interface SlackEventRouterOptions {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly botUserId: string;
  readonly now?: () => string;
}

export class SlackEventRouter {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #botUserId: string;
  readonly #now: () => string;

  constructor(options: SlackEventRouterOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#botUserId = slackId.parse(options.botUserId);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  ingest(input: unknown): SlackIngressResult {
    const parsed = slackEventCallbackSchema.safeParse(input);
    if (!parsed.success) return { kind: "ignored", reason: "invalid-event" };
    const body = parsed.data;
    const event = body.event;
    if (body.team_id !== this.#config.slack.workspaceId) {
      return { kind: "ignored", reason: "workspace-denied" };
    }
    if (!this.#config.access.allowedChannelIds.includes(event.channel)) {
      return { kind: "ignored", reason: "channel-denied" };
    }
    if (event.bot_id !== undefined || event.user === this.#botUserId) {
      return { kind: "ignored", reason: "bot-event" };
    }
    if (!this.#config.access.allowedUserIds.includes(event.user)) {
      return { kind: "ignored", reason: "user-denied" };
    }
    if (event.subtype !== undefined) return { kind: "ignored", reason: "message-subtype" };

    const threadTs = event.thread_ts ?? event.ts;
    const binding = this.#store.findActiveTask({
      workspaceId: body.team_id,
      conversationId: event.channel,
      threadTs,
    });
    let profileId: string;
    let repositoryRoot: string;
    if (binding !== null) {
      profileId = binding.profileId;
      repositoryRoot = binding.repositoryRoot;
    } else {
      if (event.type === "message") return { kind: "ignored", reason: "unbound-thread" };
      const route = this.#config.routes.find((candidate) => candidate.conversationId === event.channel);
      if (route === undefined) return { kind: "ignored", reason: "unrouted-channel" };
      const profile = this.#config.profiles.find((candidate) => candidate.id === route.profileId);
      if (profile === undefined) throw new Error(`validated route references missing profile ${route.profileId}`);
      profileId = profile.id;
      const selectedRoot = route.repositoryRoot ?? profile.repositoryRoots[0];
      if (selectedRoot === undefined) throw new Error(`validated profile ${profile.id} has no repository root`);
      repositoryRoot = selectedRoot;
    }

    const text = event.text.replaceAll(`<@${this.#botUserId}>`, "").trim();
    const receipt = this.#store.ingestSlackEvent({
      deliveryId: body.event_id,
      eventKey: `${event.channel}:${event.ts}`,
      workspaceId: body.team_id,
      conversationId: event.channel,
      threadTs,
      actorUserId: event.user,
      profileId,
      repositoryRoot,
      text,
      receivedAt: z.iso.datetime().parse(this.#now()),
      sourceOrderKey: event.ts,
    });
    return { kind: receipt.kind, receipt };
  }
}
