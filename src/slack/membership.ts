// Channel membership snapshots for `access.mode: "channel-members"` (PR-Q §3.4). In memory only: a
// member list is cheap to refetch and persisting it would add a retention obligation.
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import type { AccessUserKind, MembershipState, MembershipView } from "../policy/access.ts";
import type { ServiceLogger } from "../service.ts";
import { slackErrorCode } from "./users.ts";

/** Wraps `client.conversations.members`. May resolve `{ ok: false, error }` or throw a Web API error. */
export type SlackConversationMembers = (args: {
  readonly channel: string;
  readonly limit: number;
  readonly cursor?: string;
}) => Promise<unknown>;

export type ChannelMembershipState = "ok" | "missing_scope" | "error" | "too-large";

export interface ChannelMembershipStatus {
  readonly id: string;
  /** `pending`: never fetched yet. */
  readonly membership: ChannelMembershipState | "pending";
  /** Members in the last good snapshot, or null when there is none. */
  readonly members: number | null;
  /** Age of the last good snapshot, or null when there is none. */
  readonly ageSeconds: number | null;
  readonly errorCode?: string;
}

const pageSchema = z.object({
  ok: z.literal(true),
  members: z.array(z.string()),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const errorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

/** Slack's general recommendation for cursor page size; the method's maximum is not documented. */
export const MEMBERS_PAGE_SIZE = 200;
/** A failed walk is not retried sooner than this, so a burst of events cannot hammer a failing call. */
const FAILURE_BACKOFF_MS = 30_000;

class MembershipFetchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Slack conversations.members failed: ${code}`);
    this.name = "MembershipFetchError";
    this.code = code;
  }
}

interface ChannelEntry {
  /** Last good snapshot; dropped on `missing_scope` and `too-large`, kept across transient errors. */
  members: ReadonlySet<string> | null;
  fetchedAt: number | null;
  state: ChannelMembershipState;
  errorCode: string | undefined;
  /** Earliest time the next walk may start after a failure. */
  retryAt: number;
}

export interface ChannelMembershipCacheOptions {
  readonly list: SlackConversationMembers;
  readonly settings: AgentTagConfig["access"]["membership"];
  /** Account kinds (guest, bot) from the speaker directory's cache. */
  readonly users?: { cachedKind(userId: string): AccessUserKind };
  readonly now?: () => number;
  readonly logger?: ServiceLogger;
  /** Called once per channel and state when a channel degrades to allowlist-only (audit row). */
  readonly onDegraded?: (input: { readonly conversationId: string; readonly state: ChannelMembershipState; readonly errorCode: string }) => void;
}

export class ChannelMembershipCache implements MembershipView {
  readonly #list: SlackConversationMembers;
  readonly #settings: AgentTagConfig["access"]["membership"];
  readonly #users: { cachedKind(userId: string): AccessUserKind } | undefined;
  readonly #now: () => number;
  readonly #logger: ServiceLogger;
  readonly #onDegraded: ChannelMembershipCacheOptions["onDegraded"];
  readonly #entries = new Map<string, ChannelEntry>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #reported = new Set<string>();

  constructor(options: ChannelMembershipCacheOptions) {
    this.#list = options.list;
    this.#settings = options.settings;
    this.#users = options.users;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? ((record) => console.error(JSON.stringify(record)));
    this.#onDegraded = options.onDegraded;
  }

  lookup(conversationId: string, userId: string): MembershipState {
    const entry = this.#entries.get(conversationId);
    if (entry?.members == null || entry.fetchedAt === null) return "unknown";
    if (this.#now() - entry.fetchedAt >= this.#settings.maxStaleSeconds * 1_000) return "unknown";
    return entry.members.has(userId) ? "member" : "not-member";
  }

  userKind(userId: string): AccessUserKind {
    return this.#users?.cachedKind(userId) ?? "unknown";
  }

  /** True when the last good snapshot is younger than `ttlSeconds`. */
  isFresh(conversationId: string): boolean {
    const fetchedAt = this.#entries.get(conversationId)?.fetchedAt ?? null;
    return fetchedAt !== null && this.#now() - fetchedAt < this.#settings.ttlSeconds * 1_000;
  }

  /**
   * Refreshes the channel's snapshot unless it is fresh (or a recent walk failed). Single-flight per
   * channel: concurrent callers share one walk. Never rejects; failures are recorded on the entry.
   */
  ensureFresh(conversationId: string): Promise<void> {
    const pending = this.#inflight.get(conversationId);
    if (pending !== undefined) return pending;
    if (this.isFresh(conversationId)) return Promise.resolve();
    const entry = this.#entries.get(conversationId);
    if (entry !== undefined && entry.retryAt > this.#now()) return Promise.resolve();
    const walk = this.#refresh(conversationId).finally(() => this.#inflight.delete(conversationId));
    this.#inflight.set(conversationId, walk);
    return walk;
  }

  /** Refreshes every channel that is due; the background worker calls this once per tick. */
  async refreshAll(conversationIds: Iterable<string>): Promise<void> {
    await Promise.all([...conversationIds].map((id) => this.ensureFresh(id)));
  }

  status(conversationId: string): ChannelMembershipStatus {
    const entry = this.#entries.get(conversationId);
    if (entry === undefined) return { id: conversationId, membership: "pending", members: null, ageSeconds: null };
    return {
      id: conversationId,
      membership: entry.state,
      members: entry.members?.size ?? null,
      ageSeconds: entry.fetchedAt === null ? null : Math.max(0, Math.floor((this.#now() - entry.fetchedAt) / 1_000)),
      ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    };
  }

  async #refresh(conversationId: string): Promise<void> {
    const previous = this.#entries.get(conversationId);
    try {
      const members = await this.#walk(conversationId);
      if (members === null) {
        this.#fail(conversationId, previous, "too-large", "too_many_members");
        return;
      }
      this.#entries.set(conversationId, {
        members,
        fetchedAt: this.#now(),
        state: "ok",
        errorCode: undefined,
        retryAt: 0,
      });
    } catch (error) {
      const code = error instanceof MembershipFetchError ? error.code : slackErrorCode(error);
      this.#fail(conversationId, previous, code === "missing_scope" ? "missing_scope" : "error", code);
    }
  }

  /** All member ids, or null when the channel has more than `maxMembers`. */
  async #walk(conversationId: string): Promise<ReadonlySet<string> | null> {
    const members = new Set<string>();
    // Slack may return short pages; the size check below is the real limit, this only bounds the walk.
    const maxPages = Math.ceil(this.#settings.maxMembers / MEMBERS_PAGE_SIZE) * 4 + 1;
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const response = await this.#list({
        channel: conversationId,
        limit: MEMBERS_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const failure = errorSchema.safeParse(response);
      if (failure.success) throw new MembershipFetchError(failure.data.error);
      const parsed = pageSchema.safeParse(response);
      if (!parsed.success) throw new MembershipFetchError("invalid_response");
      for (const member of parsed.data.members) members.add(member);
      if (members.size > this.#settings.maxMembers) return null;
      cursor = parsed.data.response_metadata?.next_cursor;
      if (cursor === undefined || cursor === "") return members;
    }
    return null;
  }

  #fail(
    conversationId: string,
    previous: ChannelEntry | undefined,
    state: ChannelMembershipState,
    errorCode: string,
  ): void {
    // A transient error keeps the last snapshot until maxStaleSeconds; a scope or size problem drops it.
    const keep = state === "error";
    this.#entries.set(conversationId, {
      members: keep ? previous?.members ?? null : null,
      fetchedAt: keep ? previous?.fetchedAt ?? null : null,
      state,
      errorCode,
      retryAt: this.#now() + (state === "error" ? FAILURE_BACKOFF_MS : this.#settings.ttlSeconds * 1_000),
    });
    const key = `${conversationId}:${state}`;
    const first = !this.#reported.has(key);
    if (first) this.#reported.add(key);
    this.#logger({
      level: first ? "warn" : "info",
      event: state === "error" ? "slack.membership.failed" : "slack.membership.degraded",
      at: new Date(this.#now()).toISOString(),
      conversationId,
      errorCode,
    });
    if (first && state !== "error") this.#onDegraded?.({ conversationId, state, errorCode });
  }
}

/** The channels whose membership matters: routed, allowed, non-DM conversations. */
export function membershipChannels(config: AgentTagConfig): ReadonlyArray<string> {
  return config.routes
    .filter((route) => route.conversationType !== "dm" && config.access.allowedChannelIds.includes(route.conversationId))
    .map((route) => route.conversationId);
}

/** How often the service's membership worker looks for channels whose snapshot is past `ttlSeconds`. */
export const MEMBERSHIP_WORKER_TICK_MS = 15_000;

/**
 * Maintenance worker: keeps routed channels' snapshots fresh in `channel-members` mode, so execution-time
 * re-checks (which never call Slack) see a membership change within about one TTL. The first tick runs
 * at service start.
 */
export function createMembershipWorker(input: {
  readonly refresh: () => Promise<void>;
  readonly now: () => Date;
}): { readonly processNext: () => Promise<{ readonly kind: string }> } {
  let nextAt = 0;
  return {
    async processNext() {
      const current = input.now().getTime();
      if (current < nextAt) return { kind: "idle" };
      nextAt = current + MEMBERSHIP_WORKER_TICK_MS;
      await input.refresh();
      return { kind: "idle" };
    },
  };
}
