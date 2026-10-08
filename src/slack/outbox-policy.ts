// Slack outbox delivery policy: classify chat.postMessage and chat.update failures, compute retry
// backoff, and build the plain-text fallback for payloads Slack rejected deterministically.
//
// Every failure lands in exactly one class:
// - retryable: Slack definitely did not post the message (rate limited, connection never opened,
//   documented "try again" platform errors). Requeued with capped exponential backoff + jitter,
//   honoring Retry-After, up to an attempt cap.
// - ambiguous: Slack may have posted it (fatal_error, internal_error, timeouts, connection resets
//   after the request may have been written, anything unknown). Quarantined, never resent.
// - terminal: Slack deterministically rejected it (invalid_blocks, channel_not_found, invalid_auth,
//   ...). Failed. invalid_blocks / msg_too_long get one plain-text fallback attempt first (posts only;
//   an edit that Slack rejects leaves the message as last rendered).
import type { SlackOutboxPayload } from "../store/store.ts";
import { escapeSlackText, SLACK_MESSAGE_TEXT_LIMIT, truncateBlockText } from "./render.ts";

export type SlackDeliveryFailure =
  | { readonly kind: "retryable"; readonly errorCode: string; readonly retryAfterMs?: number }
  | { readonly kind: "ambiguous"; readonly errorCode: string }
  | { readonly kind: "terminal"; readonly errorCode: string; readonly plainTextFallback: boolean };

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Total claims (including the first send) after which a retryable failure becomes terminal. */
  readonly maxAttempts: number;
}

/** About 30 minutes of retries in total, similar to the Slack SDK's own default retry budget. */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  baseDelayMs: 5_000,
  maxDelayMs: 600_000,
  maxAttempts: 10,
};

/** Platform errors that Slack documents as "nothing happened, try again". */
const RETRYABLE_PLATFORM_ERRORS = new Set([
  "ratelimited",
  "rate_limited",
  "service_unavailable",
  "request_timeout",
  "team_added_to_org",
]);

/** Retryable error codes that mean Slack rate limited the call, not just this message. */
const RATE_LIMIT_ERROR_CODES = new Set(["ratelimited", "rate_limited", "http_429"]);

/** True when the failure is a Slack rate limit, which pauses every outbox send, not one row. */
export function isRateLimitFailure(failure: SlackDeliveryFailure): boolean {
  return failure.kind === "retryable" && RATE_LIMIT_ERROR_CODES.has(failure.errorCode);
}

/** Deterministic rejections of the payload shape or size; worth one plain-text fallback. */
const PLAIN_FALLBACK_PLATFORM_ERRORS = new Set([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_too_long",
  "msg_blocks_too_long",
]);

/** chat.update rejections: the message is gone or can no longer be edited by this bot. */
const EDIT_TERMINAL_PLATFORM_ERRORS = new Set(["message_not_found", "cant_update_message", "edit_window_closed"]);

/** Deterministic rejections: resending the same request can never succeed. */
const TERMINAL_PLATFORM_ERRORS = new Set([
  ...PLAIN_FALLBACK_PLATFORM_ERRORS,
  ...EDIT_TERMINAL_PLATFORM_ERRORS,
  "account_inactive",
  "as_user_not_supported",
  "cannot_reply_to_message",
  "channel_not_found",
  "ekm_access_denied",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_auth",
  "invalid_charset",
  "invalid_form_data",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "invalid_post_type",
  "is_archived",
  "metadata_too_large",
  "missing_post_type",
  "missing_scope",
  "no_permission",
  "no_text",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
  "too_many_attachments",
]);

/**
 * Network error codes that can only happen before a connection exists, so no request bytes reached
 * Slack. Bun's fetch reports refused and unresolvable hosts as "ConnectionRefused"/"FailedToOpenSocket";
 * Node and undici use the errno names.
 */
const PRE_SEND_NETWORK_CODES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** The WebClient's message when a 429 carried no usable Retry-After header. */
const RATE_LIMIT_WITHOUT_RETRY_AFTER = "Retry header did not contain a valid timeout";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === "string" && found !== "" ? found : undefined;
}

/**
 * Platform errors Slack documents as "may or may not have happened". Listed so their codes are
 * reported verbatim; they classify as ambiguous like any unrecognized error.
 */
const AMBIGUOUS_PLATFORM_ERRORS = new Set(["fatal_error", "internal_error"]);

/** Every platform error code that is safe to store and log as-is. */
const KNOWN_PLATFORM_ERRORS = new Set([
  ...RETRYABLE_PLATFORM_ERRORS,
  ...TERMINAL_PLATFORM_ERRORS,
  ...AMBIGUOUS_PLATFORM_ERRORS,
]);

/**
 * Stored and logged in place of any platform error we do not recognize. The WebClient puts a whole
 * non-JSON response body into `data.error`, so unrecognized text may hold response contents or tokens.
 */
const UNRECOGNIZED_PLATFORM_ERROR = "unrecognized_platform_error";

/** Errno-style codes (ECONNRESET, UND_ERR_SOCKET): upper-case letters, digits, underscores only. */
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Exception class names (TypeError, SlackDeliveryError): a plain identifier, nothing else. */
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function secondsToMs(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : undefined;
}

/** The error itself, then its `original` (WebAPIRequestError) and `cause` chain. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 5 && !chain.includes(current)) {
    chain.push(current);
    current = field(current, "original") ?? field(current, "cause");
  }
  return chain;
}

function classifyNetworkError(error: unknown): SlackDeliveryFailure | null {
  for (const link of errorChain(error)) {
    const code = stringField(link, "code");
    const name = stringField(link, "name");
    if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
      return { kind: "ambiguous", errorCode: "timeout" };
    }
    if (code === undefined) continue;
    if (PRE_SEND_NETWORK_CODES.has(code)) return { kind: "retryable", errorCode: code };
    // A reset while connecting means the request was never written; after that it may have been.
    if (code === "ECONNRESET" && stringField(link, "syscall") === "connect") {
      return { kind: "retryable", errorCode: "ECONNRESET" };
    }
    if (code.startsWith("E") || code.startsWith("UND_ERR")) {
      return { kind: "ambiguous", errorCode: ERRNO_CODE.test(code) ? code : "network_error" };
    }
  }
  return null;
}

function classifyPlatformError(errorName: string, retryAfterMs: number | undefined): SlackDeliveryFailure {
  const errorCode = KNOWN_PLATFORM_ERRORS.has(errorName) ? errorName : UNRECOGNIZED_PLATFORM_ERROR;
  if (RETRYABLE_PLATFORM_ERRORS.has(errorName)) {
    return retryAfterMs === undefined ? { kind: "retryable", errorCode } : { kind: "retryable", errorCode, retryAfterMs };
  }
  if (TERMINAL_PLATFORM_ERRORS.has(errorName)) {
    return { kind: "terminal", errorCode, plainTextFallback: PLAIN_FALLBACK_PLATFORM_ERRORS.has(errorName) };
  }
  // fatal_error, internal_error and anything undocumented: Slack may have acted on the request.
  return { kind: "ambiguous", errorCode };
}

/** Classify an error thrown by `chat.postMessage` or `chat.update` (Slack WebClient or network errors). */
export function classifySlackDeliveryError(error: unknown): SlackDeliveryFailure {
  const code = stringField(error, "code");
  if (code === "slack_webapi_rate_limited_error") {
    const retryAfterMs = secondsToMs(field(error, "retryAfter"));
    return retryAfterMs === undefined
      ? { kind: "retryable", errorCode: "rate_limited" }
      : { kind: "retryable", errorCode: "rate_limited", retryAfterMs };
  }
  if (code === "slack_webapi_platform_error") {
    const data = field(error, "data");
    return classifyPlatformError(
      stringField(data, "error") ?? UNRECOGNIZED_PLATFORM_ERROR,
      secondsToMs(field(field(data, "response_metadata"), "retryAfter")),
    );
  }
  if (code === "slack_webapi_http_error") {
    const status = field(error, "statusCode");
    if (status === 429) {
      const retryAfterMs = secondsToMs(field(field(error, "headers"), "retry-after"));
      return retryAfterMs === undefined
        ? { kind: "retryable", errorCode: "http_429" }
        : { kind: "retryable", errorCode: "http_429", retryAfterMs };
    }
    return { kind: "ambiguous", errorCode: typeof status === "number" ? `http_${status}` : "http_error" };
  }
  const message = stringField(error, "message");
  if (message?.startsWith(RATE_LIMIT_WITHOUT_RETRY_AFTER)) return { kind: "retryable", errorCode: "rate_limited" };
  const network = classifyNetworkError(error);
  if (network !== null) return network;
  if (code === "slack_webapi_request_error") return { kind: "ambiguous", errorCode: "request_error" };
  const name = stringField(error, "name");
  return { kind: "ambiguous", errorCode: name !== undefined && CLASS_NAME.test(name) ? name : "SlackDeliveryError" };
}

/**
 * Delay before the next claim: capped exponential backoff with "equal jitter" (half fixed, half
 * random), never shorter than Slack's Retry-After.
 */
export function outboxRetryDelayMs(input: {
  readonly attempt: number;
  readonly retryAfterMs?: number;
  readonly policy?: OutboxRetryPolicy;
  readonly random?: () => number;
}): number {
  const policy = input.policy ?? DEFAULT_OUTBOX_RETRY_POLICY;
  const random = input.random ?? Math.random;
  const exponent = Math.min(Math.max(input.attempt - 1, 0), 30);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jittered = Math.round(ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random(), 0), 1));
  return Math.max(jittered, input.retryAfterMs ?? 0);
}

function decodeEntities(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

const BUTTONS_UNAVAILABLE_NOTE = "\n\n_(Slack rejected this message's buttons; respond to this request in T3.)_";

/**
 * Plain escaped text for a payload Slack rejected: the readable text of its blocks (or its `text`),
 * re-escaped through the renderer so no mention or control sequence survives, cut to one message.
 */
export function plainTextFallback(payload: SlackOutboxPayload): SlackOutboxPayload {
  const blocks = payload.blocks ?? [];
  const parts = blocks.flatMap((block) => {
    if (block.type === "section") return [block.text.text];
    if (block.type === "context") return block.elements.map((element) => element.text);
    return [];
  });
  const source = parts.length > 0 ? parts.join("\n\n") : payload.text;
  const note = blocks.some((block) => block.type === "actions") ? BUTTONS_UNAVAILABLE_NOTE : "";
  const body = truncateBlockText(escapeSlackText(decodeEntities(source)), SLACK_MESSAGE_TEXT_LIMIT - note.length);
  return { text: `${body}${note}` };
}
