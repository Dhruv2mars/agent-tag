import { z } from "zod";

import { slackErrorCode } from "./users.ts";

// The thread window: earlier messages of a Slack thread, read once when the agent is first mentioned
// partway into it. Fetching is bounded (pages, ring buffer, wall clock) and selection is pure, so the
// window is deterministic for a given set of replies.

export interface ThreadContextPolicy {
  readonly maxMessages: number;
  readonly maxChars: number;
  readonly maxMessageChars: number;
  readonly includeBotMessages: "none" | "root-only" | "all";
  readonly includeNonAllowedUsers: boolean;
}

export interface ThreadWindowMessage {
  readonly ts: string;
  readonly speakerKind: "human" | "bot";
  /** A user ID for humans, a bot ID (or user ID when Slack sends no bot ID) for bots. */
  readonly speakerId: string;
  /** Bots: `bot_profile.name ?? username`, unsanitized. Humans: null, resolved by the user directory. */
  readonly speakerLabel: string | null;
  /** Raw Slack markup, capped at `maxMessageChars`; resolved at compose time. */
  readonly text: string;
  readonly isRoot: boolean;
  readonly edited: boolean;
  /** False for humans outside `access.allowedUserIds` (and for bots): context, never a request. */
  readonly steeringAllowed: boolean;
  readonly fileNames: readonly string[];
}

export interface ThreadWindow {
  /** Chronological, root first when it is eligible. */
  readonly messages: readonly ThreadWindowMessage[];
  /** Eligible messages left out by the message or character budget. */
  readonly omitted: number;
  /**
   * True when the thread had more replies than the fetch ceiling. Slack pages oldest first, so the
   * replies closest to the mention were never read and the window ends early.
   */
  readonly truncated: boolean;
}

/** Wraps `client.conversations.replies(args)`. May resolve `{ ok: false, error }` or throw a Web API error. */
export type SlackRepliesPage = (
  args: {
    readonly channel: string;
    readonly ts: string;
    readonly latest: string;
    readonly inclusive: false;
    readonly limit: number;
    readonly cursor?: string;
  },
  signal?: AbortSignal,
) => Promise<unknown>;

/** The window could not be read. `code` is a Slack error code or `timeout`; never message text. */
export class SlackContextUnavailable extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Slack thread context unavailable: ${code}`);
    this.name = "SlackContextUnavailable";
    this.code = code;
  }
}

export const THREAD_CONTEXT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PAGE_SIZE = 200;
/** A rate-limited page is retried once, and only when Slack asks for a short wait. */
const MAX_RETRY_AFTER_SECONDS = 3;
const MAX_FILE_NAMES = 20;
const ELLIPSIS = "…";
const ALLOWED_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share", "me_message", "bot_message"]);

const slackTimestamp = z.string().regex(/^\d{1,20}\.\d{1,9}$/);
const rawReplySchema = z.object({
  ts: slackTimestamp,
  text: z.string().optional(),
  user: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
  username: z.string().optional(),
  bot_profile: z.object({ name: z.string().optional() }).optional(),
  subtype: z.string().optional(),
  edited: z.object({}).passthrough().optional(),
  files: z.array(z.object({ name: z.string().optional(), title: z.string().optional() })).optional(),
});
export type RawReply = z.infer<typeof rawReplySchema>;

const repliesResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.array(z.unknown()).default([]),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const repliesErrorSchema = z.object({ ok: z.literal(false), error: z.string().min(1) });

export interface ThreadWindowContext {
  readonly rootTs: string;
  readonly botUserId: string;
  readonly selfBotId?: string;
  readonly allowedUserIds: readonly string[];
  readonly policy: ThreadContextPolicy;
}

function capText(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) return text;
  return codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join("") + ELLIPSIS;
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * Maps one raw reply to a window message, or null when it is not eligible: the agent's own
 * messages, unsupported subtypes, bots and non-allowlisted humans per policy (the root is always
 * kept for humans, and for bots unless the policy is "none").
 */
export function classifyReply(raw: unknown, context: ThreadWindowContext): ThreadWindowMessage | null {
  const parsed = rawReplySchema.safeParse(raw);
  if (!parsed.success) return null;
  const reply = parsed.data;
  if (reply.user === context.botUserId) return null;
  if (context.selfBotId !== undefined && reply.bot_id === context.selfBotId) return null;
  if (!ALLOWED_SUBTYPES.has(reply.subtype)) return null;
  const isRoot = reply.ts === context.rootTs;
  const isBot = reply.bot_id !== undefined || reply.subtype === "bot_message";
  let speakerId: string;
  let steeringAllowed: boolean;
  if (isBot) {
    const mode = context.policy.includeBotMessages;
    if (mode === "none" || (mode === "root-only" && !isRoot)) return null;
    const botId = reply.bot_id ?? reply.user;
    if (botId === undefined) return null;
    speakerId = botId;
    steeringAllowed = false;
  } else {
    if (reply.user === undefined) return null;
    steeringAllowed = context.allowedUserIds.includes(reply.user);
    if (!steeringAllowed && !context.policy.includeNonAllowedUsers && !isRoot) return null;
    speakerId = reply.user;
  }
  const fileNames = (reply.files ?? [])
    .slice(0, MAX_FILE_NAMES)
    .flatMap((file) => {
      const name = file.name ?? file.title;
      return name === undefined || name === "" ? [] : [name];
    });
  return {
    ts: reply.ts,
    speakerKind: isBot ? "bot" : "human",
    speakerId,
    speakerLabel: isBot ? (reply.bot_profile?.name ?? reply.username ?? null) : null,
    text: capText(reply.text ?? "", context.policy.maxMessageChars),
    isRoot,
    edited: reply.edited !== undefined,
    steeringAllowed,
    fileNames,
  };
}

/** Root plus the newest replies within `maxMessages`, then the newest that fit `maxChars`. */
function budgetWindow(
  root: ThreadWindowMessage | null,
  replies: readonly ThreadWindowMessage[],
  droppedEarlier: number,
  truncated: boolean,
  policy: ThreadContextPolicy,
): ThreadWindow {
  let used = root === null ? 0 : codePointLength(root.text);
  const kept: ThreadWindowMessage[] = [];
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index];
    if (reply === undefined) continue;
    const length = codePointLength(reply.text);
    if (used + length > policy.maxChars) break;
    used += length;
    kept.push(reply);
  }
  kept.reverse();
  return {
    messages: root === null ? kept : [root, ...kept],
    omitted: droppedEarlier + (replies.length - kept.length),
    truncated,
  };
}

/** Collects eligible replies into the root plus a ring buffer of the newest `maxMessages - 1`. */
class WindowAccumulator {
  readonly #context: ThreadWindowContext;
  readonly #capacity: number;
  readonly #seen = new Set<string>();
  #root: ThreadWindowMessage | null = null;
  #replies: ThreadWindowMessage[] = [];
  #dropped = 0;

  constructor(context: ThreadWindowContext) {
    this.#context = context;
    this.#capacity = Math.max(0, context.policy.maxMessages - 1);
  }

  add(raw: unknown): void {
    const message = classifyReply(raw, this.#context);
    if (message === null || this.#seen.has(message.ts)) return;
    this.#seen.add(message.ts);
    if (message.isRoot) {
      this.#root = message;
      return;
    }
    this.#replies.push(message);
    if (this.#replies.length > this.#capacity) {
      // Evict the oldest by ts, not by arrival, so page order cannot change which replies are kept.
      let oldest = 0;
      for (let index = 1; index < this.#replies.length; index += 1) {
        const candidate = this.#replies[index];
        const current = this.#replies[oldest];
        if (candidate !== undefined && current !== undefined && compareTs(candidate.ts, current.ts) < 0) oldest = index;
      }
      this.#replies.splice(oldest, 1);
      this.#dropped += 1;
    }
  }

  window(truncated: boolean): ThreadWindow {
    const ordered = [...this.#replies].sort((left, right) => compareTs(left.ts, right.ts));
    return budgetWindow(this.#root, ordered, this.#dropped, truncated, this.#context.policy);
  }
}

function compareTs(left: string, right: string): number {
  const [leftSeconds = "0", leftFraction = ""] = left.split(".");
  const [rightSeconds = "0", rightFraction = ""] = right.split(".");
  const seconds = BigInt(leftSeconds) - BigInt(rightSeconds);
  if (seconds !== 0n) return seconds < 0n ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, "0");
  const rightPadded = rightFraction.padEnd(width, "0");
  return leftPadded === rightPadded ? 0 : leftPadded < rightPadded ? -1 : 1;
}

/** Pure selection over chronological replies (root included). The fetch path uses the same rules. */
export function selectThreadWindow(raw: readonly unknown[], context: ThreadWindowContext): ThreadWindow {
  const accumulator = new WindowAccumulator(context);
  const ordered = raw
    .flatMap((reply) => {
      const parsed = rawReplySchema.safeParse(reply);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => compareTs(left.ts, right.ts));
  for (const reply of ordered) accumulator.add(reply);
  return accumulator.window(false);
}

export interface FetchThreadWindowInput extends ThreadWindowContext {
  readonly replies: SlackRepliesPage;
  readonly channel: string;
  /** The triggering message; it and anything newer are excluded (`latest`, `inclusive: false`). */
  readonly beforeTs: string;
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
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

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return raceSignal(Bun.sleep(milliseconds), signal);
}

function retryAfterSeconds(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { retryAfter?: unknown }).retryAfter;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reads the thread through `conversations.replies` and selects the window. Throws
 * SlackContextUnavailable for Slack errors and the wall-clock timeout; an abort of `signal` itself
 * propagates as that signal's reason so callers can tell shutdown from an outage.
 */
export async function fetchThreadWindow(input: FetchThreadWindowInput): Promise<ThreadWindow> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? THREAD_CONTEXT_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const sleep = input.sleep ?? defaultSleep;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const accumulator = new WindowAccumulator(input);
  try {
    let cursor: string | undefined;
    let retried = false;
    for (let page = 0; page < maxPages; ) {
      let response: unknown;
      try {
        response = await raceSignal(
          input.replies(
            {
              channel: input.channel,
              ts: input.rootTs,
              latest: input.beforeTs,
              inclusive: false,
              limit: input.pageSize ?? DEFAULT_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor }),
            },
            signal,
          ),
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const code = slackErrorCode(error);
        const wait = retryAfterSeconds(error);
        if (code === "ratelimited" && !retried && wait !== null && wait <= MAX_RETRY_AFTER_SECONDS) {
          retried = true;
          await sleep(wait * 1_000, signal);
          continue;
        }
        throw new SlackContextUnavailable(code);
      }
      const failure = repliesErrorSchema.safeParse(response);
      if (failure.success) throw new SlackContextUnavailable(failure.data.error);
      const parsed = repliesResponseSchema.safeParse(response);
      if (!parsed.success) throw new SlackContextUnavailable("invalid_response");
      for (const message of parsed.data.messages) accumulator.add(message);
      page += 1;
      const next = parsed.data.response_metadata?.next_cursor;
      if (next === undefined || next === "") return accumulator.window(false);
      cursor = next;
    }
    return accumulator.window(true);
  } catch (error) {
    if (input.signal?.aborted === true) throw abortReason(input.signal);
    if (timeout.aborted) throw new SlackContextUnavailable("timeout");
    throw error;
  }
}
