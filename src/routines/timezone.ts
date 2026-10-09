import { normalizeRoutineRequest, parseRoutineRequest, splitRoutineRequest, type RoutineParseResult } from "./parse.ts";
import { isValidTimeZone } from "./zoned.ts";

/**
 * Time zones for Slack routine requests. Pure: no I/O and no clock of its own.
 *
 * Priority: a zone written in the request, then the requester's Slack profile zone, then the
 * configured default. Abbreviations map to a DST-aware IANA zone ("9am PST" in July is 9am PDT),
 * because the confirmation always names the zone the schedule runs in.
 */

/** IANA areas a written zone may start with; anything else ("src/app") is ordinary task text. */
const IANA_AREAS = [
  "Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific", "Etc",
  "US", "Canada",
];

/** Abbreviations, only recognized right after a clock time ("9am PT"). */
export const TIME_ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  PT: "America/Los_Angeles", PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  MT: "America/Denver", MST: "America/Denver", MDT: "America/Denver",
  CT: "America/Chicago", CST: "America/Chicago", CDT: "America/Chicago",
  ET: "America/New_York", EST: "America/New_York", EDT: "America/New_York",
  BST: "Europe/London",
  CET: "Europe/Paris", CEST: "Europe/Paris",
  IST: "Asia/Kolkata",
  JST: "Asia/Tokyo",
  AEST: "Australia/Sydney", AEDT: "Australia/Sydney",
  UTC: "UTC", GMT: "UTC",
};

/** Areas match capitalized ("Europe/London") or, except the short legacy ones, lower case ("europe/london"). */
const AREA = IANA_AREAS.flatMap((area) => (area.length <= 3 ? [area] : [area, area.toLowerCase()])).join("|");
/** "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+5". Case-sensitive, so "us/eu" is task text. */
const IANA_NAME = `(?:${AREA})(?:\\/[A-Za-z0-9_+\\-]+)+`;
const ABBREVIATION = Object.keys(TIME_ZONE_ABBREVIATIONS).join("|");
/** A word in any letter case, for patterns that are otherwise case-sensitive ("NOON", "Noon"). */
const anyCase = (word: string): string => [...word].map((char) => `[${char.toUpperCase()}${char.toLowerCase()}]`).join("");
/** Clock-shaped (any letter case): has am/pm or a colon, or follows "at" ("at 9"), or is a named time. */
const CLOCK =
  `(?:\\d{1,2}(?::\\d{2})?\\s*[AaPp]\\.?[Mm]\\.?|\\d{1,2}:\\d{2}|\\b${anyCase("at")}\\s+\\d{1,2}|` +
  `\\b(?:${["noon", "midday", "midnight"].map(anyCase).join("|")})\\b)`;
/** The zone ends at a word boundary that is not part of a longer name. */
const END = "(?![A-Za-z0-9_/+\\-])";

/** Inline and fenced code spans. */
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

interface ZonePattern {
  readonly pattern: RegExp;
  /** Text that replaces the match (the clock time before the zone, if any). */
  readonly keep: (match: RegExpExecArray) => string;
}

const ZONE_PATTERNS: ReadonlyArray<ZonePattern> = [
  // "in Europe/London", "(America/New_York)"
  { pattern: new RegExp(`(?:\\b[Ii][Nn]\\s+|\\()(?<zone>${IANA_NAME})${END}\\)?`, "g"), keep: () => "" },
  // "in UTC", "(GMT)"
  { pattern: new RegExp(`(?:\\bin\\s+|\\()(?<zone>UTC|GMT)${END}\\)?`, "gi"), keep: () => "" },
  // "9am Europe/London", "at 9 UTC"
  {
    pattern: new RegExp(`(?<clock>${CLOCK})\\s+(?<zone>${IANA_NAME})${END}`, "g"),
    keep: (match) => match.groups?.clock ?? "",
  },
  // "9am PT", "09:00 cet", "9am (PT)": abbreviations only right after a clock time
  {
    pattern: new RegExp(`(?<clock>${CLOCK})\\s*(?:\\((?<paren>${ABBREVIATION})\\)|\\s(?<zone>${ABBREVIATION})${END})`, "gi"),
    keep: (match) => match.groups?.clock ?? "",
  },
];

export type TimeZoneExtraction =
  | {
      readonly kind: "ok";
      /** The request with the zone phrase removed, ready for the parser. */
      readonly text: string;
      /** Canonical IANA zone the request names, if any. */
      readonly explicit?: string;
    }
  | { readonly kind: "error"; readonly message: string; readonly token: string };

/** Canonical IANA spelling ("europe/london" -> "Europe/London"), or null when the zone is unknown. */
export function canonicalTimeZone(timeZone: string): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  return resolved === "Etc/UTC" || resolved === "Etc/GMT" ? "UTC" : resolved;
}

function zoneFor(token: string): string | null {
  const abbreviation = TIME_ZONE_ABBREVIATIONS[token.toUpperCase()];
  if (abbreviation !== undefined && !token.includes("/")) return abbreviation;
  return canonicalTimeZone(token);
}

export function unknownTimeZoneMessage(token: string): string {
  return `I don't know the time zone \`${token.replaceAll("`", "'")}\`. Use a name like America/New_York.`;
}

/**
 * Find a time zone written in a routine request and remove it from the text.
 * Recognized: an IANA name after "in" or in parentheses, or right after a clock time; `UTC`/`GMT`
 * after "in"; and abbreviations (PT, ET, BST, IST, ...) only right after a clock time, so "ET"
 * elsewhere stays task text. An unknown IANA-looking name is an error, not task text.
 */
export function extractTimeZone(text: string): TimeZoneExtraction {
  // Zones inside code are task content ("run `date --date='9am UTC'`"): blank them out for the scan
  // with a filler no pattern matches, keeping offsets aligned with the original text.
  const scan = text.replace(CODE_SPAN, (span) => "\u0000".repeat(span.length));
  const candidates: ZoneCandidate[] = [];
  for (const { pattern, keep } of ZONE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(scan); match !== null; match = pattern.exec(scan)) {
      const start = match.index;
      const end = start + match[0].length;
      if (candidates.some((other) => start < other.end && other.start < end)) continue;
      const token = match.groups?.zone ?? match.groups?.paren ?? "";
      const clock = match.groups?.clock;
      candidates.push({ start, end, keep: keep(match), token, zone: zoneFor(token), ...(clock === undefined ? {} : { clock }) });
    }
  }
  if (candidates.length === 0) return { kind: "ok", text: text.trim() };

  // Only zones attached to the schedule's timing count; "check the 10am PT incident" is task text.
  const timing = timingSpan(splice(scan, candidates));
  const found = timing === null ? candidates : candidates.filter((entry) => belongsToTiming(scan, candidates, entry, timing));
  const unknown = found.find((entry) => entry.zone === null);
  if (unknown !== undefined) return { kind: "error", message: unknownTimeZoneMessage(unknown.token), token: unknown.token };
  if (found.length === 0) return { kind: "ok", text: text.trim() };
  const zones = [...new Set(found.map((entry) => entry.zone as string))];
  if (zones.length > 1) {
    return {
      kind: "error",
      message: `That names more than one time zone (${zones.join(", ")}). Use just one.`,
      token: zones.join(", "),
    };
  }
  return { kind: "ok", text: splice(text, found), explicit: zones[0] as string };
}

interface ZoneCandidate {
  readonly start: number;
  readonly end: number;
  /** Text that replaces the match (the clock time before the zone, if any). */
  readonly keep: string;
  readonly token: string;
  /** Canonical zone, or null when the token is unknown. */
  readonly zone: string | null;
  /** The clock the zone follows ("9am PT"); absent for "in Europe/London" and "(UTC)". */
  readonly clock?: string;
}

/** Word positions [start, end) of the parsed timing in the zone-free request. */
interface TimingSpan {
  readonly start: number;
  readonly end: number;
  readonly words: readonly string[];
}

/** Lower-case words without surrounding punctuation, for comparing text with the parsed timing. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[(\[{"'“‘]+|[)\]}"'”’:,;.!?\-–—]+$/g, ""))
    .filter((word) => word.length > 0);
}

/** Where the timing sits in the zone-free request, or null when it does not split (create reports it). */
function timingSpan(stripped: string): TimingSpan | null {
  const split = splitRoutineRequest(stripped);
  if (split.kind !== "ok") return null;
  const all = words(stripped);
  const timing = words(split.timing);
  // The parser takes the timing from the start ("every day at 9am …") or the end ("… every day at 9am").
  const matches = (at: number): boolean => timing.every((word, offset) => all[at + offset] === word);
  const start = matches(0) ? 0 : all.length - timing.length;
  if (start < 0 || !matches(start)) return null;
  return { start, end: start + timing.length, words: all };
}

const CONNECTORS = new Set(["and", "or", "&", "then"]);

/**
 * A clock-anchored zone ("9am PT") counts when its clock is inside the timing, or follows it with
 * only "and"/"or" between ("at 9am PT and 10am ET" names two zones). A bare zone ("in
 * Europe/London", "(UTC)") counts when it sits in or next to the timing, or ends the request.
 */
function belongsToTiming(scan: string, all: readonly ZoneCandidate[], entry: ZoneCandidate, timing: TimingSpan): boolean {
  const at = words(splice(scan.slice(0, entry.start), all.filter((other) => other.end <= entry.start))).length;
  if (entry.clock !== undefined) {
    const clockEnd = at + words(entry.clock).length;
    if (at >= timing.start && clockEnd <= timing.end) return true;
    return at > timing.end && timing.words.slice(timing.end, at).every((word) => CONNECTORS.has(word));
  }
  return (at >= timing.start && at <= timing.end) || scan.slice(entry.end).trim() === "";
}

/** Splice zone phrases out, tidying spaces only at the seams so the rest of the text is unchanged. */
function splice(text: string, entries: ReadonlyArray<ZoneCandidate>): string {
  let stripped = text;
  for (const entry of [...entries].sort((left, right) => right.start - left.start)) {
    const before = entry.keep === "" ? stripped.slice(0, entry.start).trimEnd() : stripped.slice(0, entry.start) + entry.keep;
    const after = stripped.slice(entry.end).trimStart();
    const seam = before === "" || after === "" || /^[,.:;!?)]/.test(after) ? "" : " ";
    stripped = `${before}${seam}${after}`;
  }
  return stripped.trim();
}

export type TimeZoneSource = "explicit" | "profile" | "default";

export interface ResolvedTimeZone {
  readonly timeZone: string;
  readonly source: TimeZoneSource;
}

/**
 * The zone a request is interpreted in: explicit > Slack profile > configured fallback > UTC.
 * Unknown or empty zones at any level are skipped, so a bad profile value never breaks a request.
 */
export function resolveTimeZone(input: {
  readonly explicit?: string | null;
  readonly profileTz?: string | null;
  readonly fallback?: string | null;
}): ResolvedTimeZone {
  const candidates: ReadonlyArray<readonly [string | null | undefined, TimeZoneSource]> = [
    [input.explicit, "explicit"],
    [input.profileTz, "profile"],
    [input.fallback, "default"],
  ];
  for (const [candidate, source] of candidates) {
    if (candidate === undefined || candidate === null || candidate.trim() === "") continue;
    const zone = canonicalTimeZone(candidate.trim());
    if (zone !== null) return { timeZone: zone, source };
  }
  return { timeZone: "UTC", source: "default" };
}

export interface RoutineScheduleInput {
  /** The request with the bot mention stripped. */
  readonly text: string;
  /** Injected clock. */
  readonly now: Date;
  /** The requester; `remind me` notifies them. */
  readonly actorUserId?: string;
  /** The requester's Slack profile zone (`users.info` `tz`), or null when unavailable. */
  readonly profileTimeZone?: string | null;
  /** `routines.defaultTimeZone`. */
  readonly defaultTimeZone?: string;
}

export type RoutineScheduleResult =
  | (Extract<RoutineParseResult, { readonly kind: "ok" }> & {
      readonly timeZone: string;
      readonly timeZoneSource: TimeZoneSource;
    })
  | { readonly kind: "error"; readonly message: string };

const PAST_ERROR = "That time has already passed. Try a time in the future.";

/**
 * Turn a create request into a scheduler spec in the right time zone. The caller looks up the
 * profile zone only when {@link extractTimeZone} found no explicit one (it is the only I/O).
 */
export function resolveRoutineSchedule(input: RoutineScheduleInput): RoutineScheduleResult {
  const extracted = extractTimeZone(normalizeRoutineRequest(input.text));
  if (extracted.kind === "error") return { kind: "error", message: extracted.message };
  const zone = resolveTimeZone({
    explicit: extracted.explicit ?? null,
    profileTz: input.profileTimeZone ?? null,
    fallback: input.defaultTimeZone ?? null,
  });
  const parsed = parseRoutineRequest(extracted.text, {
    now: input.now,
    timeZone: zone.timeZone,
    ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
  });
  if (parsed.kind === "error") return parsed;
  // The parser already refuses past one-shot times; this keeps the guarantee for every path.
  if (Date.parse(parsed.nextRunAt) <= input.now.getTime()) return { kind: "error", message: PAST_ERROR };
  return { ...parsed, timeZone: zone.timeZone, timeZoneSource: zone.source };
}
