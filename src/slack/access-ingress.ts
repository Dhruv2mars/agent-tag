// Slack ingress glue for the access policy (PR-Q §3.4, §3.5): warms the membership snapshot and the
// account kind before the synchronous routers run, routes unrouted DMs in `auto-route` mode, and audits
// denied explicit requests. The routers themselves only call `isSteeringAllowed`.
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { isAllowlisted, isDirectMessageId, isSteeringAllowed, resolveRoute, type AccessPurpose } from "../policy/access.ts";
import type { AgentTagStore } from "../store/store.ts";
import type { SlackEventRouter, SlackIngressResult } from "./events.ts";
import type { SlackUserKind } from "./users.ts";

const eventEnvelopeSchema = z.object({
  event_id: z.string().min(1).optional(),
  team_id: z.string().min(1).optional(),
  event: z.object({
    type: z.string(),
    channel: z.string().min(1).optional(),
    channel_type: z.string().optional(),
    user: z.string().min(1).optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
  }),
});

const actionEnvelopeSchema = z.object({
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }).optional(),
});

/** Who is asking where, read loosely from a Slack payload; null when the payload names no human. */
export interface AccessSubject {
  readonly channel: string;
  readonly user: string;
}

export function eventSubject(body: unknown): AccessSubject | null {
  const parsed = eventEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  const event = parsed.data.event;
  if (event.channel === undefined || event.user === undefined || event.bot_id !== undefined) return null;
  return { channel: event.channel, user: event.user };
}

export function actionSubject(body: unknown): AccessSubject | null {
  const parsed = actionEnvelopeSchema.safeParse(body);
  if (!parsed.success || parsed.data.channel === undefined) return null;
  return { channel: parsed.data.channel.id, user: parsed.data.user.id };
}

export interface AccessWarmup {
  ensureFresh(conversationId: string): Promise<void>;
}

/**
 * In `channel-members` mode, refreshes a stale snapshot of an allowed channel and looks up the actor's
 * account kind before a router decides, so a just-joined member is recognized on their first mention.
 * Allowlisted actors, DMs and `allowlist` mode skip it. Never rejects; after `deadlineMs` the router
 * decides on what is cached (an unknown snapshot fails closed).
 */
export async function warmAccess(
  input: {
    readonly config: AgentTagConfig;
    readonly membership: AccessWarmup | null;
    readonly users: { kind(userId: string, signal?: AbortSignal): Promise<SlackUserKind> };
    readonly deadlineMs: number;
  },
  subject: AccessSubject | null,
): Promise<void> {
  const { config } = input;
  if (
    subject === null ||
    input.membership === null ||
    config.access.mode !== "channel-members" ||
    isDirectMessageId(subject.channel) ||
    !config.access.allowedChannelIds.includes(subject.channel) ||
    isAllowlisted(config, subject.user)
  ) {
    return;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, input.deadlineMs);
  });
  const work = Promise.allSettled([
    input.membership.ensureFresh(subject.channel),
    input.users.kind(subject.user, controller.signal),
  ]).then(() => undefined);
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The event router, plus `directMessages.mode: "auto-route"`: a `message.im` from an allowlisted user in
 * a DM without a configured route is ingested by a router whose config carries the synthesized DM route
 * (`resolveRoute`), so events.ts needs no DM-specific branch. Execution rebuilds the same route from the
 * task's recorded owner.
 */
export class DirectMessageAutoRouter {
  readonly #config: AgentTagConfig;
  readonly #base: Pick<SlackEventRouter, "ingest">;
  readonly #create: (config: AgentTagConfig) => Pick<SlackEventRouter, "ingest">;
  readonly #routers = new Map<string, Pick<SlackEventRouter, "ingest">>();

  constructor(input: {
    readonly config: AgentTagConfig;
    readonly base: Pick<SlackEventRouter, "ingest">;
    readonly create: (config: AgentTagConfig) => Pick<SlackEventRouter, "ingest">;
  }) {
    this.#config = input.config;
    this.#base = input.base;
    this.#create = input.create;
  }

  ingest(body: unknown): SlackIngressResult {
    return this.#routerFor(body).ingest(body);
  }

  #routerFor(body: unknown): Pick<SlackEventRouter, "ingest"> {
    const config = this.#config;
    if (config.access.directMessages.mode !== "auto-route") return this.#base;
    const parsed = eventEnvelopeSchema.safeParse(body);
    if (!parsed.success) return this.#base;
    const event = parsed.data.event;
    const channel = event.channel;
    if (
      event.type !== "message" ||
      event.channel_type !== "im" ||
      channel === undefined ||
      event.user === undefined ||
      event.bot_id !== undefined ||
      !isDirectMessageId(channel) ||
      config.routes.some((route) => route.conversationId === channel)
    ) {
      return this.#base;
    }
    const route = resolveRoute(config, channel, event.user);
    if (route === undefined) return this.#base;
    // A D-id belongs to one human and the bot, so the first allowlisted sender owns it for good.
    const existing = this.#routers.get(channel);
    if (existing !== undefined) return existing;
    const router = this.#create({
      ...config,
      access: { ...config.access, allowedChannelIds: [...config.access.allowedChannelIds, channel] },
      routes: [...config.routes, route],
    });
    this.#routers.set(channel, router);
    return router;
  }
}

/**
 * Writes one `access.denied` audit row when an explicit request (a mention, a DM, a button click) is
 * refused by the access policy. Ambient channel chatter is never audited. The reason is the predicate's,
 * so the row says why even where a router reports a coarser reason.
 */
export function auditAccessDenial(input: {
  readonly config: AgentTagConfig;
  readonly store: Pick<AgentTagStore, "recordAccessAudit">;
  readonly workspaceId: string;
  readonly subject: AccessSubject;
  readonly purpose: AccessPurpose;
  readonly source: string;
  readonly now: string;
}): void {
  const decision = isSteeringAllowed({
    config: input.config,
    workspaceId: input.workspaceId,
    conversationId: input.subject.channel,
    userId: input.subject.user,
    purpose: input.purpose,
  });
  if (decision.allowed) return;
  input.store.recordAccessAudit({
    action: "access.denied",
    actorId: input.subject.user,
    conversationId: input.subject.channel,
    result: decision.reason,
    source: input.source,
    metadata: { purpose: input.purpose },
    createdAt: input.now,
  });
}

/** An app mention or a DM message: a request addressed to the bot, as opposed to ambient chatter. */
export function isExplicitEvent(body: unknown): boolean {
  const parsed = eventEnvelopeSchema.safeParse(body);
  if (!parsed.success) return false;
  const event = parsed.data.event;
  return event.type === "app_mention" || (event.type === "message" && event.channel_type === "im" && event.subtype === undefined);
}

/** Event id and team id for an audit row. */
export function eventEnvelope(body: unknown): { readonly eventId: string; readonly workspaceId: string } | null {
  const parsed = eventEnvelopeSchema.safeParse(body);
  if (!parsed.success || parsed.data.event_id === undefined || parsed.data.team_id === undefined) return null;
  return { eventId: parsed.data.event_id, workspaceId: parsed.data.team_id };
}
