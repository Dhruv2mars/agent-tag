import { z } from "zod";

import type { ServiceLogger } from "../service.ts";
import { sanitizeLabel, type SpeakerIdentity } from "./markup.ts";

export type { SpeakerIdentity } from "./markup.ts";

/** Wraps `client.users.info({ user })`. May resolve `{ ok: false, error }` or throw a Web API error. */
export type SlackUserLookup = (userId: string, signal?: AbortSignal) => Promise<unknown>;

export interface SlackUserDirectoryOptions {
  readonly lookup: SlackUserLookup;
  /** Positive cache lifetime. Default one hour. */
  readonly ttlMs?: number;
  /** Failed lookups are cached this long so a missing user is not refetched per turn. Default 5 minutes. */
  readonly negativeTtlMs?: number;
  readonly maxEntries?: number;
  /** A lookup slower than this falls back to the raw ID so it cannot eat the operation lease. */
  readonly lookupTimeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: ServiceLogger;
}

/**
 * The fields read from `users.info`. Extend this schema and `identityFromUser` to surface more
 * profile data (for example `tz`); the cache stores whatever identity those produce.
 */
const slackUserSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  real_name: z.string().optional(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
      bot_id: z.string().optional(),
    })
    .optional(),
});
const usersInfoResponseSchema = z.object({ ok: z.literal(true), user: slackUserSchema });
const usersInfoErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

type SlackUser = z.infer<typeof slackUserSchema>;

/** Token or scope problems that will not fix themselves until the app is reinstalled. */
const DISABLING_ERRORS = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
]);

export class SlackUserLookupError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Slack users.info failed: ${code}`);
    this.name = "SlackUserLookupError";
    this.code = code;
  }
}

/** Fallback identity: the raw Slack ID, which is always a safe, stable label. */
export function unresolvedSpeaker(userId: string): SpeakerIdentity {
  return { userId, label: userId, resolved: false };
}

function identityFromUser(userId: string, user: SlackUser): SpeakerIdentity {
  const candidates = [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name];
  let label = "";
  for (const candidate of candidates) {
    label = sanitizeLabel(candidate ?? "");
    if (label !== "") break;
  }
  if (label === "") label = userId;
  if (user.deleted === true) label = `${label} (deactivated)`;
  else if (user.is_bot === true) label = `${label} (bot)`;
  return { userId, label, resolved: true };
}

/** Slack error code from a thrown @slack/web-api error, or a generic name. */
export function slackErrorCode(error: unknown): string {
  if (error instanceof SlackUserLookupError) return error.code;
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; data?: { error?: unknown } };
    if (typeof record.data?.error === "string" && record.data.error !== "") return record.data.error;
    if (record.code === "slack_webapi_rate_limited_error") return "ratelimited";
    if (typeof record.code === "string" && record.code !== "") return record.code;
  }
  return error instanceof Error && error.name ? error.name : "unknown_error";
}

interface CacheEntry {
  readonly identity: SpeakerIdentity;
  readonly expiresAt: number;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Rejects as soon as `signal` aborts; the shared lookup keeps running for other callers. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const LABEL_CONCURRENCY = 4;

/**
 * In-memory `users.info` cache that resolves Slack user IDs to display labels. It never fails a
 * caller: errors fall back to the raw ID, and a missing scope or bad token disables lookups for the
 * process after one warning. Only an abort of the caller's signal rejects.
 */
export class SlackUserDirectory {
  readonly #lookup: SlackUserLookup;
  readonly #ttlMs: number;
  readonly #negativeTtlMs: number;
  readonly #maxEntries: number;
  readonly #lookupTimeoutMs: number;
  readonly #now: () => number;
  readonly #logger: ServiceLogger;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<SpeakerIdentity>>();
  #disabledCode: string | null = null;

  constructor(options: SlackUserDirectoryOptions) {
    this.#lookup = options.lookup;
    this.#ttlMs = options.ttlMs ?? 3_600_000;
    this.#negativeTtlMs = options.negativeTtlMs ?? 300_000;
    this.#maxEntries = options.maxEntries ?? 2_000;
    this.#lookupTimeoutMs = options.lookupTimeoutMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? ((record) => console.error(JSON.stringify(record)));
  }

  /** The error code that disabled lookups for this process, if any. */
  get disabledCode(): string | null {
    return this.#disabledCode;
  }

  label(userId: string, signal?: AbortSignal): Promise<SpeakerIdentity> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.#disabledCode !== null) return Promise.resolve(unresolvedSpeaker(userId));
    const cached = this.#cache.get(userId);
    if (cached !== undefined) {
      if (cached.expiresAt > this.#now()) {
        this.#cache.delete(userId);
        this.#cache.set(userId, cached);
        return Promise.resolve(cached.identity);
      }
      this.#cache.delete(userId);
    }
    let pending = this.#inflight.get(userId);
    if (pending === undefined) {
      pending = this.#fetch(userId).finally(() => this.#inflight.delete(userId));
      this.#inflight.set(userId, pending);
    }
    return raceAbort(pending, signal);
  }

  async labels(ids: Iterable<string>, signal?: AbortSignal): Promise<Map<string, SpeakerIdentity>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, SpeakerIdentity>();
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const userId = unique[next++];
        if (userId === undefined) break;
        result.set(userId, await this.label(userId, signal));
      }
    };
    await Promise.all(Array.from({ length: Math.min(LABEL_CONCURRENCY, unique.length) }, worker));
    // Preserve caller order regardless of completion order.
    return new Map(unique.flatMap((id) => {
      const identity = result.get(id);
      return identity === undefined ? [] : [[id, identity] as const];
    }));
  }

  async #fetch(userId: string): Promise<SpeakerIdentity> {
    try {
      const response = await this.#withTimeout(this.#lookup(userId));
      const failure = usersInfoErrorSchema.safeParse(response);
      if (failure.success) throw new SlackUserLookupError(failure.data.error);
      const parsed = usersInfoResponseSchema.safeParse(response);
      if (!parsed.success) throw new SlackUserLookupError("invalid_response");
      const identity = identityFromUser(userId, parsed.data.user);
      this.#remember(userId, identity, this.#ttlMs);
      return identity;
    } catch (error) {
      const code = slackErrorCode(error);
      if (DISABLING_ERRORS.has(code)) {
        this.#disable(code);
      } else {
        // Includes `ratelimited`: no retry; the ID stands in until the negative entry expires.
        this.#remember(userId, unresolvedSpeaker(userId), this.#negativeTtlMs);
      }
      return unresolvedSpeaker(userId);
    }
  }

  #withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SlackUserLookupError("timeout")), this.#lookupTimeoutMs);
    });
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  #remember(userId: string, identity: SpeakerIdentity, ttlMs: number): void {
    this.#cache.delete(userId);
    this.#cache.set(userId, { identity, expiresAt: this.#now() + ttlMs });
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  #disable(code: string): void {
    if (this.#disabledCode !== null) return;
    this.#disabledCode = code;
    this.#cache.clear();
    this.#logger({
      level: "warn",
      event: "slack.users.disabled",
      at: new Date(this.#now()).toISOString(),
      errorCode: code,
    });
  }
}
