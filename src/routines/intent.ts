import { GENERIC_PARSE_ERROR, normalizeRoutineRequest, REMINDER_LEAD, splitRoutineRequest } from "./parse.ts";
import { extractTimeZone } from "./timezone.ts";

/**
 * Detects routine requests (create / list / cancel) in an @mention or DM. Pure and deterministic.
 *
 * Precision over recall: a normal request swallowed as a routine is the worst failure, while a
 * missed routine just runs now as a normal prompt. So create needs an explicit lead ("remind",
 * "schedule", "routine:", "cron:") or a recurring lead ("every", "daily", ...) whose timing parses,
 * and "fix the cron job that runs every day at 9" stays a normal prompt.
 */

/** Which routine a cancel request points at. */
export type RoutineCancelRef =
  /** "cancel this routine" / "cancel the routine": the thread's only active routine. */
  | { readonly kind: "only" }
  /** "cancel routine 2" / "#2": 1-based position in the list order. */
  | { readonly kind: "index"; readonly index: number }
  /** "cancel routine a1b2c3": a schedule id prefix (lower case, no dashes). */
  | { readonly kind: "id"; readonly prefix: string }
  /** "cancel the reminder about deploys": case-insensitive substring of the prompt. */
  | { readonly kind: "text"; readonly text: string };

export type RoutineCreateLead = "reminder" | "schedule" | "recurring" | "cron";

export type RoutineIntent =
  | { readonly kind: "none" }
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly ref: RoutineCancelRef }
  | { readonly kind: "create"; readonly lead: RoutineCreateLead };

const NONE: RoutineIntent = { kind: "none" };

const LIST = new RegExp(
  "^(?:list|show|what are|what's|whats|what is)\\b" +
    // Only qualifiers between the verb and the noun: "show me the code that handles reminders" is a prompt.
    "(?:\\s+(?:me|us|all|the|my|our|your|these|any|active|current|existing|upcoming|recurring|pending|scheduled))*\\s+" +
    "(?:routines?|reminders?|schedules?|scheduled\\s+(?:jobs|tasks))" +
    "(?:\\s+(?:here|in\\s+(?:this|the)\\s+(?:channel|thread|conversation|dm)|for\\s+this\\s+(?:channel|thread)))?" +
    "\\s*\\??$",
  "i",
);
const LIST_BARE = /^!?(?:routines|reminders)\??$/i;
const CANCEL =
  /^(?:cancel|stop|delete|remove|disable|turn\s+off|unschedule)\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:routine|reminder|schedule|scheduled\s+job)s?\b\s*(?<ref>.*)$/i;
/** Words between the noun and the reference: "cancel the reminder about deploys". */
const REF_LEAD = /^(?:(?:about|for|called|named|titled|that|which|with\s+id|id|number|no\.?)\s+|[:\-–—]\s*)+/i;
/** List positions up to `limits.maxActiveSchedules` (at most 10,000). */
const INDEX_REF = /^#?([1-9]\d{0,4})$/;
const ID_REF = /^[0-9a-f][0-9a-f-]{5,35}$/i;

const RECURRING_LEADS = new Set(["every", "each", "daily", "weekly", "monthly", "hourly", "weekdays", "weeknights"]);

/**
 * A recurring lead is a routine only when its timing parses and is more than one bare word, or the
 * word is set off with punctuation: "daily at 9am summarize PRs" and "daily: summarize PRs" are
 * routines, "daily standup notes are wrong" and "hourly backups failed" are not.
 */
function isRecurringRequest(request: string): boolean {
  const extracted = extractTimeZone(request);
  const text = extracted.kind === "ok" ? extracted.text : request;
  const split = splitRoutineRequest(text);
  if (split.kind !== "ok") return false;
  const timing = split.timing.toLowerCase().split(/\s+/);
  // The timing must be the leading phrase: "every build fails at 3am" is not a routine.
  if (timing[0] !== leadWord(text)) return false;
  return timing.length > 1 || /^[^\s:,\-–—]+\s*[:,\-–—]/.test(text);
}

function leadWord(text: string): string {
  return (text.split(/\s+/, 1)[0] ?? "").toLowerCase().replace(/[:,\-–—]+$/, "");
}

function cancelRef(raw: string): RoutineCancelRef {
  const ref = raw
    .replace(REF_LEAD, "")
    .replace(/[\s.!?]+$/, "")
    .replace(/^`(.*)`$/, "$1")
    .replace(/^["'“‘](.*)["'”’]$/, "$1")
    .trim();
  if (ref === "" || /^(?:this|that|it|here)$/i.test(ref)) return { kind: "only" };
  const index = INDEX_REF.exec(ref);
  if (index !== null) return { kind: "index", index: Number(index[1]) };
  if (ID_REF.test(ref)) return { kind: "id", prefix: ref.replaceAll("-", "").toLowerCase() };
  return { kind: "text", text: ref };
}

/** Whether the request names a timing the parser understands (time zone phrases removed first). */
function hasRecognizedTiming(text: string): boolean {
  const extracted = extractTimeZone(text);
  // A misspelled zone is still a scheduling request: let the create path explain the error.
  if (extracted.kind === "error") return true;
  const split = splitRoutineRequest(extracted.text);
  return split.kind === "ok" || split.message !== GENERIC_PARSE_ERROR;
}

export function detectRoutineIntent(text: string): RoutineIntent {
  const request = normalizeRoutineRequest(text);
  if (request === "") return NONE;
  if (LIST_BARE.test(request) || LIST.test(request)) return { kind: "list" };

  const cancel = CANCEL.exec(request);
  if (cancel !== null) return { kind: "cancel", ref: cancelRef(cancel.groups?.ref ?? "") };

  // Reminders: "remind me how X works" is a question, so the lead only counts with a timing.
  if (REMINDER_LEAD.test(request)) return hasRecognizedTiming(request) ? { kind: "create", lead: "reminder" } : NONE;
  if (/^cron\s*:/i.test(request)) return { kind: "create", lead: "cron" };
  if (/^(?:schedule\s+\S|routine\s*:\s*\S)/i.test(request)) return { kind: "create", lead: "schedule" };

  return RECURRING_LEADS.has(leadWord(request)) && isRecurringRequest(request) ? { kind: "create", lead: "recurring" } : NONE;
}
