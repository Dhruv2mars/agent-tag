// Who may use the agent where (PR-Q §3.3). Every access decision (events, actions, schedules, memory,
// and execution-time re-checks) goes through `isSteeringAllowed`, so an access mode is one function.
import type { AgentTagConfig, AgentTagRoute } from "../config.ts";

/** What the actor is trying to do. Guests never get `approve`, `answer` or `cancel`. */
export type AccessPurpose = "steer" | "approve" | "answer" | "cancel" | "schedule" | "memory" | "execute";

export type AccessDenialReason =
  | "workspace-denied"
  | "channel-denied"
  | "user-denied"
  | "dm-owner-denied"
  | "guest-denied"
  | "approver-denied"
  | "membership-unknown"
  | "dm-disabled";

export type AccessDecision =
  | { readonly allowed: true; readonly basis: "allowlist" | "member" | "dm-owner" }
  | { readonly allowed: false; readonly reason: AccessDenialReason };

export type MembershipState = "member" | "not-member" | "unknown";
export type AccessUserKind = "member" | "guest" | "bot" | "unknown";

/** Synchronous view of channel membership and account kinds. Never calls Slack. */
export interface MembershipView {
  lookup(conversationId: string, userId: string): MembershipState;
  userKind(userId: string): AccessUserKind;
}

/** Knows nothing: in `channel-members` mode only the allowlist works (fail closed). */
export const UNKNOWN_MEMBERSHIP: MembershipView = {
  lookup: () => "unknown",
  userKind: () => "unknown",
};

const boundViews = new WeakMap<AgentTagConfig, MembershipView>();

/**
 * Makes `view` the membership source for every check against this config object. The service binds its
 * Slack-backed cache once at startup, so workers that only hold the config see the same snapshots.
 */
export function bindMembership(config: AgentTagConfig, view: MembershipView): void {
  boundViews.set(config, view);
}

export function membershipFor(config: AgentTagConfig): MembershipView {
  return boundViews.get(config) ?? UNKNOWN_MEMBERSHIP;
}

/** Slack 1:1 DM conversation ids start with D. */
export function isDirectMessageId(conversationId: string): boolean {
  return conversationId.startsWith("D");
}

/** In `access.allowedUserIds`: always allowed in an allowed channel, in both modes. */
export function isAllowlisted(config: AgentTagConfig, userId: string): boolean {
  return config.access.allowedUserIds.includes(userId);
}

/**
 * The route for a conversation: the configured one, or in `directMessages.mode: "auto-route"` a private
 * DM route owned by `ownerUserId` on the auto-route profile. An auto route needs an allowlisted owner.
 */
export function resolveRoute(
  config: AgentTagConfig,
  conversationId: string,
  ownerUserId?: string | null,
): AgentTagRoute | undefined {
  const configured = config.routes.find((candidate) => candidate.conversationId === conversationId);
  if (configured !== undefined) return configured;
  const directMessages = config.access.directMessages;
  if (
    directMessages.mode !== "auto-route" ||
    directMessages.autoRouteProfileId === undefined ||
    !isDirectMessageId(conversationId) ||
    ownerUserId === undefined ||
    ownerUserId === null ||
    !isAllowlisted(config, ownerUserId)
  ) {
    return undefined;
  }
  return { conversationId, conversationType: "dm", ownerUserId, profileId: directMessages.autoRouteProfileId };
}

const APPROVER_PURPOSES: ReadonlySet<AccessPurpose> = new Set(["approve", "answer", "cancel"]);
const GUEST_STEER_PURPOSES: ReadonlySet<AccessPurpose> = new Set(["steer", "execute"]);

function deny(reason: AccessDenialReason): AccessDecision {
  return { allowed: false, reason };
}

/**
 * The single access predicate. First match wins:
 * 1. workspace; 2. DMs (owner only, never membership; `off` denies every DM); 3. channel in allowedChannelIds;
 * 4. allowlisted user; 5. allowlist mode denies the rest; 6. bots and guests; 7. channel membership
 * (`unknown` fails closed).
 */
export function isSteeringAllowed(input: {
  readonly config: AgentTagConfig;
  /** Defaults to the view bound to `config` (see bindMembership). */
  readonly membership?: MembershipView;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly purpose: AccessPurpose;
  /** For an existing DM task: its recorded owner (auto-routed DMs have no configured route). */
  readonly dmOwnerUserId?: string | null;
}): AccessDecision {
  const { config, conversationId, userId, purpose } = input;
  const access = config.access;
  if (input.workspaceId !== config.slack.workspaceId) return deny("workspace-denied");

  if (isDirectMessageId(conversationId)) {
    if (access.directMessages.mode === "off") return deny("dm-disabled");
    const route = access.allowedChannelIds.includes(conversationId)
      ? resolveRoute(config, conversationId)
      : resolveRoute(config, conversationId, input.dmOwnerUserId ?? userId);
    if (route === undefined || route.conversationType !== "dm") return deny("channel-denied");
    if (userId !== route.ownerUserId) return deny("dm-owner-denied");
    if (!isAllowlisted(config, route.ownerUserId)) return deny("user-denied");
    return { allowed: true, basis: "dm-owner" };
  }

  if (!access.allowedChannelIds.includes(conversationId)) return deny("channel-denied");
  if (isAllowlisted(config, userId)) return { allowed: true, basis: "allowlist" };
  if (access.mode === "allowlist") return deny("user-denied");

  const membership = input.membership ?? membershipFor(config);
  const kind = membership.userKind(userId);
  if (kind === "bot") return deny("user-denied");
  // An unknown account kind might be a guest, so it may steer but never approve (fail closed).
  if (APPROVER_PURPOSES.has(purpose) && (kind === "guest" || kind === "unknown")) return deny("approver-denied");
  if (kind === "guest" && !(access.membership.guests === "steer-only" && GUEST_STEER_PURPOSES.has(purpose))) {
    return deny("guest-denied");
  }
  const state = membership.lookup(conversationId, userId);
  if (state === "member") return { allowed: true, basis: "member" };
  return deny(state === "not-member" ? "user-denied" : "membership-unknown");
}
