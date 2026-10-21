// Doctor's access block (PR-Q §3.7): the mode, each routed channel's membership read, DM routing and missing scopes.
import type { AgentTagConfig } from "./config.ts";
import { type DoctorCheck, type DoctorDependencies, fetchWithTimeout, skipped } from "./doctor.ts";
import type { SecretString } from "./security/secret-file.ts";
import { ChannelMembershipCache, membershipChannels, type ChannelMembershipStatus } from "./slack/membership.ts";

export interface AccessReport {
  readonly mode: AgentTagConfig["access"]["mode"];
  /** One entry per routed, allowed channel in `channel-members` mode; empty in `allowlist` mode. */
  readonly channels: ReadonlyArray<Pick<ChannelMembershipStatus, "id" | "membership" | "members" | "ageSeconds">>;
  readonly directMessages: {
    readonly mode: AgentTagConfig["access"]["directMessages"]["mode"];
    /** DM routes in `routes`. */
    readonly routed: number;
    readonly autoRouteProfileId: string | null;
  };
  /** Read scopes a membership walk was refused for (`channels:read` for C…, `groups:read` for G…). */
  readonly missingScopes: readonly string[];
}

/** `conversations.members` over the doctor's fetch (form-encoded, like the other Slack calls here). */
function doctorMembersList(dependencies: DoctorDependencies, token: SecretString) {
  return async (args: { readonly channel: string; readonly limit: number; readonly cursor?: string }): Promise<unknown> => {
    const form = new URLSearchParams({ channel: args.channel, limit: String(args.limit) });
    if (args.cursor !== undefined) form.set("cursor", args.cursor);
    const response = await fetchWithTimeout(dependencies, "https://slack.com/api/conversations.members", {
      method: "POST",
      headers: { authorization: `Bearer ${token.exposeToBoundary()}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) throw new Error(`Slack conversations.members returned HTTP ${response.status}`);
    return response.json();
  };
}

/**
 * The access block and its check. In `channel-members` mode it walks each routed channel's membership
 * once; a channel the bot cannot read degrades to allowlist-only, which is a warning, not a failure.
 */
export async function checkAccess(
  config: AgentTagConfig,
  token: SecretString | undefined,
  dependencies: DoctorDependencies,
): Promise<{ readonly check: DoctorCheck; readonly report: AccessReport }> {
  const id = "access";
  const access = config.access;
  const directMessages = {
    mode: access.directMessages.mode,
    routed: config.routes.filter((route) => route.conversationType === "dm").length,
    autoRouteProfileId: access.directMessages.autoRouteProfileId ?? null,
  };
  const dmSummary = `DMs ${directMessages.mode}`;
  if (access.mode === "allowlist") {
    return {
      check: { id, status: "pass", summary: `access mode allowlist (${access.allowedUserIds.length} user(s)); ${dmSummary}` },
      report: { mode: access.mode, channels: [], directMessages, missingScopes: [] },
    };
  }
  const ids = membershipChannels(config);
  if (token === undefined) {
    return {
      check: skipped(id, "access mode channel-members; Slack bot token is not usable, so membership was not read"),
      report: { mode: access.mode, channels: ids.map((channel) => ({ id: channel, membership: "pending", members: null, ageSeconds: null })), directMessages, missingScopes: [] },
    };
  }
  const cache = new ChannelMembershipCache({
    list: doctorMembersList(dependencies, token),
    settings: access.membership,
    now: () => dependencies.now().getTime(),
    logger: () => undefined,
  });
  await cache.refreshAll(ids);
  const channels = ids.map((channel) => {
    const { membership, members, ageSeconds } = cache.status(channel);
    return { id: channel, membership, members, ageSeconds };
  });
  const missingScopes = [...new Set(channels
    .filter((channel) => channel.membership === "missing_scope")
    .map((channel) => (channel.id.startsWith("G") ? "groups:read" : "channels:read")))].sort();
  const degraded = channels.filter((channel) => channel.membership !== "ok");
  const report: AccessReport = { mode: access.mode, channels, directMessages, missingScopes };
  if (degraded.length === 0) {
    return {
      check: { id, status: "pass", summary: `access mode channel-members; ${channels.length} channel(s) readable; ${dmSummary}` },
      report,
    };
  }
  return {
    check: {
      id,
      status: "warn",
      summary: `access mode channel-members; allowlist-only in ${degraded.map((channel) => `${channel.id} (${channel.membership})`).join(", ")}`,
      hint: missingScopes.length > 0
        ? `grant ${missingScopes.join(", ")} (reinstall the Slack app from config/slack-manifest.example.json)`
        : "membership could not be read; only allowedUserIds can use the agent there until it can",
    },
    report,
  };
}
