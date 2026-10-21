// Whether a routed channel is public or private (PR-K §3.7), for workspace-note writes. Fails
// closed: anything unknown refuses workspace writes, and reads are unaffected.
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import type { ConversationVisibility } from "../memory.ts";
import type { ServiceLogger } from "../service.ts";
import { slackErrorCode } from "./users.ts";

const conversationsInfoSchema = z.object({ ok: z.literal(true), channel: z.object({ is_private: z.boolean() }) });

export const VISIBILITY_TTL_MS = 900_000;
const VISIBILITY_CACHE_MAX = 500;

export interface ConversationVisibilityResolverOptions {
  /** A getter, so a config reload applies without rewiring. */
  readonly config: () => AgentTagConfig;
  /** `conversations.info` (channels:read for public channels, groups:read for private ones). */
  readonly conversationsInfo: (channel: string) => Promise<unknown>;
  readonly logger?: ServiceLogger;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export class ConversationVisibilityResolver {
  readonly #config: () => AgentTagConfig;
  readonly #conversationsInfo: (channel: string) => Promise<unknown>;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { readonly visibility: "public" | "private"; readonly expiresAt: number }>();
  /** Channels whose lookup failure was already logged, so a missing scope logs once per channel. */
  readonly #logged = new Set<string>();

  constructor(options: ConversationVisibilityResolverOptions) {
    this.#config = options.config;
    this.#conversationsInfo = options.conversationsInfo;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? VISIBILITY_TTL_MS;
  }

  /** Route override, then cached `conversations.info`; `unknown` on any failure. Never throws. */
  async resolve(input: { readonly conversationId: string; readonly conversationType: "channel" | "dm" }): Promise<ConversationVisibility> {
    if (input.conversationType === "dm") return "dm";
    const route = this.#config().routes.find((candidate) => candidate.conversationId === input.conversationId);
    if (route?.visibility !== undefined) return route.visibility;
    const now = this.#now();
    const cached = this.#cache.get(input.conversationId);
    if (cached !== undefined && cached.expiresAt > now) return cached.visibility;
    try {
      const parsed = conversationsInfoSchema.safeParse(await this.#conversationsInfo(input.conversationId));
      if (!parsed.success) throw new Error("invalid conversations.info response");
      const visibility = parsed.data.channel.is_private ? "private" : "public";
      this.#cache.delete(input.conversationId);
      if (this.#cache.size >= VISIBILITY_CACHE_MAX) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      this.#cache.set(input.conversationId, { visibility, expiresAt: now + this.#ttlMs });
      return visibility;
    } catch (error) {
      if (!this.#logged.has(input.conversationId)) {
        this.#logged.add(input.conversationId);
        this.#logger?.({
          level: "warn",
          event: "slack.visibility.lookup_failed",
          at: new Date(now).toISOString(),
          errorCode: slackErrorCode(error),
        });
      }
      return "unknown";
    }
  }
}
