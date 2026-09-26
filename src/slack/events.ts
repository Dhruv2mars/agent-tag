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
        | "unbound-thread"
        | "ambient-disabled"
        | "ambient-not-relevant"
        | "ambient-quiet"
        | "dm-owner-denied"
        | "task-route-denied";
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
    const eventKey = `${event.channel}:${event.ts}`;
    const receivedAt = z.iso.datetime().parse(this.#now());
    const route = this.#config.routes.find((candidate) => candidate.conversationId === event.channel);
    if (route === undefined) return { kind: "ignored", reason: "unrouted-channel" };
    const profile = this.#config.profiles.find((candidate) => candidate.id === route.profileId);
    if (profile === undefined) throw new Error(`validated route references missing profile ${route.profileId}`);
    if (route.conversationType === "dm" && event.user !== route.ownerUserId) {
      return { kind: "ignored", reason: "dm-owner-denied" };
    }
    const selectedRoot = route.repositoryRoot ?? profile.repositoryRoots[0];
    if (selectedRoot === undefined) throw new Error(`validated profile ${profile.id} has no repository root`);
    const binding = this.#store.findActiveTask({
      workspaceId: body.team_id,
      conversationId: event.channel,
      threadTs,
    });
    let profileId: string;
    let repositoryRoot: string;
    if (binding !== null) {
      if (
        binding.profileId !== route.profileId ||
        binding.repositoryRoot !== selectedRoot ||
        binding.conversationType !== route.conversationType ||
        binding.ownerUserId !== (route.conversationType === "dm" ? route.ownerUserId : null)
      ) {
        return { kind: "ignored", reason: "task-route-denied" };
      }
      profileId = binding.profileId;
      repositoryRoot = binding.repositoryRoot;
    } else {
      const explicitMention = event.text.includes(`<@${this.#botUserId}>`);
      if (event.type === "message" && event.thread_ts !== undefined) {
        return { kind: "ignored", reason: "unbound-thread" };
      }
      if (event.type === "message" && !explicitMention && route.conversationType === "channel") {
        if (!profile.ambient.enabled) return { kind: "ignored", reason: "ambient-disabled" };
        const normalized = event.text.toLowerCase();
        if (!profile.ambient.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
          return { kind: "ignored", reason: "ambient-not-relevant" };
        }
        const decision = this.#store.evaluateAmbient({
          workspaceId: body.team_id,
          conversationId: event.channel,
          eventKey,
          actorUserId: event.user,
          text: event.text,
          cooldownSeconds: profile.ambient.cooldownSeconds,
          maxTurnsPerHour: profile.ambient.maxTurnsPerHour,
          now: receivedAt,
        });
        if (decision.kind === "quiet") return { kind: "ignored", reason: "ambient-quiet" };
      }
      profileId = profile.id;
      repositoryRoot = selectedRoot;
    }

    const text = event.text.replaceAll(`<@${this.#botUserId}>`, "").trim();
    const receipt = this.#store.ingestSlackEvent({
      deliveryId: body.event_id,
      eventKey,
      workspaceId: body.team_id,
      conversationId: event.channel,
      threadTs,
      actorUserId: event.user,
      conversationType: route.conversationType,
      profileId,
      repositoryRoot,
      text,
      receivedAt,
      sourceOrderKey: event.ts,
    });
    return { kind: receipt.kind, receipt };
  }
}
