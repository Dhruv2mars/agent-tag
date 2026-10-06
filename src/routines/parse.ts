import type { ScheduleSpec } from "../scheduler.ts";
import { nextCronOccurrence, parseCron, type ScheduleRecurrence } from "./cron.ts";
import {
  addDays,
  daysInMonth,
  fromLocal,
  isValidTimeZone,
  toLocal,
  weekdayOf,
  type LocalDate,
} from "./zoned.ts";

/**
 * Deterministic natural-language schedule parser for Slack routines.
 *
 * Interpretation rules (kept deliberately simple and predictable):
 * - Times without am/pm are 24-hour ("at 9:30" is 09:30, "at 15" is 15:00),
 *   except after "tonight" where hours before 12 are read as pm.
 * - Date-only phrases ("tomorrow", "on friday", "every day") default to 9:00.
 * - "on friday" is the next Friday, today included if the time is still ahead;
 *   "next friday" is never today.
 * - Calendar recurrences become cron in the user's time zone, so they stay at
 *   the same wall-clock time across DST changes. Minute/hour intervals use a
 *   fixed cadence and are not DST-adjusted (they don't need to be).
 */

export const MIN_INTERVAL_SECONDS = 300;
const DEFAULT_HOUR = 9;
const TONIGHT_DEFAULT_HOUR = 20;
const MAX_CADENCE_SECONDS = 31_536_000;
const MAX_TIMING_WORDS = 16;

export const GENERIC_PARSE_ERROR =
  "I couldn't understand that time. Try 'every weekday at 9am' or 'in 2 hours'.";

export interface ParseScheduleOptions {
  /** Reference instant. */
  readonly now: Date;
  /** IANA time zone, e.g. from the Slack user's profile (`tz`). */
  readonly timeZone: string;
}

/** Timing portion of a schedule spec; feed it to {@link toScheduleSpec}. */
export interface ParsedSchedule {
  readonly runAt: string;
  readonly cadenceSeconds?: number;
  readonly recurrence?: ScheduleRecurrence;
}

export type ScheduleParseResult =
  | {
      readonly kind: "ok";
      readonly schedule: ParsedSchedule;
      readonly recurring: boolean;
      readonly humanReadable: string;
      readonly nextRunAt: string;
    }
  | { readonly kind: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Intermediate representation

interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: boolean;
}

type DayRef =
  | { readonly type: "none" }
  | { readonly type: "today" }
  | { readonly type: "tonight" }
  | { readonly type: "tomorrow" }
  | { readonly type: "weekday"; readonly weekday: number; readonly strictlyFuture: boolean }
  | { readonly type: "date"; readonly year?: number; readonly month: number; readonly day: number };

type CalendarPattern =
  | { readonly type: "daily" }
  | { readonly type: "weekdays"; readonly days: ReadonlyArray<number> }
  | { readonly type: "same-weekday" }
  | { readonly type: "monthly"; readonly day: number };

type Timing =
  | { readonly kind: "relative"; readonly days: number; readonly minutes: number }
  | { readonly kind: "at"; readonly day: DayRef; readonly time?: TimeOfDay }
  | { readonly kind: "interval"; readonly seconds: number }
  | { readonly kind: "calendar"; readonly pattern: CalendarPattern; readonly time: TimeOfDay }
  | { readonly kind: "cron"; readonly expression: string };

type TimingResult =
  | { readonly kind: "ok"; readonly timing: Timing }
  /** Recognized as a timing phrase, but not acceptable (e.g. interval too short). */
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unrecognized" };

const UNRECOGNIZED: TimingResult = { kind: "unrecognized" };

// ---------------------------------------------------------------------------
// Vocabulary

const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45,
};

type Unit = "minute" | "hour" | "day" | "week";
const UNITS: Readonly<Record<string, Unit>> = {
  m: "minute", min: "minute", mins: "minute", minute: "minute", minutes: "minute",
  h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", wk: "week", wks: "week", week: "week", weeks: "week",
};

function isPluralWeekday(token: string): boolean {
  return WEEKDAYS[token] !== undefined && token.endsWith("s") && !["tues", "weds", "thurs"].includes(token);
}

// ---------------------------------------------------------------------------
// Tokenizing

function normalize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[\s.,;:!?\-–—]+$/g, "")
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/(\d)\s+(am|pm)\b/g, "$1$2")
    .replace(/[,;]|\band\b|&/g, " and ")
    .trim();
  return cleaned.length === 0 ? [] : cleaned.split(/\s+/);
}

function parseNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (/^\d{1,4}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token];
}

function parseTimeToken(token: string | undefined): TimeOfDay | undefined {
  if (token === undefined) return undefined;
  if (token === "noon" || token === "midday") return { hour: 12, minute: 0, meridiem: true };
  if (token === "midnight") return { hour: 0, minute: 0, meridiem: true };
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token);
  if (match === null) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3];
  if (minute > 59) return undefined;
  if (suffix === undefined) {
    if (hour > 23) return undefined;
    return { hour, minute, meridiem: false };
  }
  if (hour < 1 || hour > 12) return undefined;
  if (suffix === "am" && hour === 12) hour = 0;
  if (suffix === "pm" && hour !== 12) hour += 12;
  return { hour, minute, meridiem: true };
}

/** A time token that can stand alone without "at" (has am/pm, a colon, or is a word). */
function isStandaloneTime(token: string | undefined): boolean {
  return token !== undefined && parseTimeToken(token) !== undefined && !/^\d{1,2}$/.test(token);
}

interface TimeExtraction {
  readonly time?: TimeOfDay;
  readonly rest: ReadonlyArray<string>;
}

/** Pull an "at 9am" / "9:30" clause off the front or back of the tokens. */
function extractTime(tokens: ReadonlyArray<string>): TimeExtraction {
  const length = tokens.length;
  const last = tokens[length - 1];
  if (length >= 2 && tokens[length - 2] === "at") {
    const time = parseTimeToken(last);
    if (time !== undefined) return { time, rest: tokens.slice(0, -2) };
  }
  if (tokens[0] === "at") {
    const time = parseTimeToken(tokens[1]);
    if (time !== undefined) return { time, rest: tokens.slice(2) };
  }
  if (length >= 2 && isStandaloneTime(last)) {
    return { time: parseTimeToken(last) as TimeOfDay, rest: tokens.slice(0, -1) };
  }
  if (isStandaloneTime(tokens[0])) return { time: parseTimeToken(tokens[0]) as TimeOfDay, rest: tokens.slice(1) };
  return { rest: tokens };
}

function parseOrdinal(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(token);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return value >= 1 && value <= 31 ? value : undefined;
}

/** Parses "monday and thursday", "mon wed fri". Returns sorted unique days. */
function parseWeekdayList(tokens: ReadonlyArray<string>): number[] | undefined {
  const days = new Set<number>();
  for (const token of tokens) {
    if (token === "and" || token === "or") continue;
    const day = WEEKDAYS[token];
    if (day === undefined) return undefined;
    days.add(day);
  }
  return days.size === 0 ? undefined : [...days].sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------
// Grammar

function parseCronPhrase(text: string): TimingResult {
  const match = /^\s*cron\s*:?\s+(.+?)\s*$/i.exec(text);
  if (match === null) return UNRECOGNIZED;
  const expression = (match[1] ?? "").replace(/^`|`$/g, "").trim().split(/\s+/).join(" ");
  const parsed = parseCron(expression);
  if (parsed.kind === "error") {
    return { kind: "invalid", message: `That cron expression isn't valid: ${parsed.message}.` };
  }
  return { kind: "ok", timing: { kind: "cron", expression } };
}

function intervalResult(amount: number, unit: Unit): TimingResult {
  if (unit === "day" || unit === "week") {
    return amount === 1
      ? UNRECOGNIZED
      : {
          kind: "invalid",
          message: `Repeating every ${amount} ${unit}s isn't supported yet. Try 'every day at 9am' or 'every monday at 9am'.`,
        };
  }
  const seconds = amount * (unit === "minute" ? 60 : 3_600);
  if (seconds < MIN_INTERVAL_SECONDS) {
    return {
      kind: "invalid",
      message: `That's too frequent. Routines can repeat at most every ${MIN_INTERVAL_SECONDS / 60} minutes.`,
    };
  }
  if (seconds > MAX_CADENCE_SECONDS) {
    return { kind: "invalid", message: "That interval is too long. Try a calendar schedule like 'every month on the 1st'." };
  }
  return { kind: "ok", timing: { kind: "interval", seconds } };
}

function parseRecurringBody(body: ReadonlyArray<string>, time: TimeOfDay | undefined): TimingResult {
  const at = time ?? { hour: DEFAULT_HOUR, minute: 0, meridiem: true };
  const calendar = (pattern: CalendarPattern): TimingResult => ({
    kind: "ok",
    timing: { kind: "calendar", pattern, time: at },
  });
  const [first, second, ...others] = body;
  if (first === undefined) return UNRECOGNIZED;

  // every 15 minutes / every 2 hours / every minute / every half hour
  const amount = parseNumber(first);
  const amountUnit = second === undefined ? undefined : UNITS[second];
  if (amount !== undefined && amountUnit !== undefined && others.length === 0 && time === undefined) {
    if (!/^\d/.test(first) && amount === 1 && first !== "one") return UNRECOGNIZED;
    return intervalResult(amount, amountUnit);
  }
  if (first === "half" && (second === "hour" || second === "an") && time === undefined) {
    const tail = second === "an" ? others : [];
    if (second === "an" && !(tail.length === 1 && tail[0] === "hour")) return UNRECOGNIZED;
    if (second === "hour" && others.length !== 0) return UNRECOGNIZED;
    return intervalResult(30, "minute");
  }
  const compact = /^(\d+)(m|min|mins|h|hr|hrs)$/.exec(first);
  if (compact !== null && body.length === 1 && time === undefined) {
    return intervalResult(Number(compact[1]), UNITS[compact[2] ?? ""] ?? "minute");
  }

  if (body.length === 1) {
    if ((first === "minute" || first === "hour") && time === undefined) return intervalResult(1, first);
    if (first === "day" || first === "morning") return calendar({ type: "daily" });
    if (first === "weekday" || first === "weekdays") return calendar({ type: "weekdays", days: [1, 2, 3, 4, 5] });
    if (first === "weekend" || first === "weekends") return calendar({ type: "weekdays", days: [0, 6] });
    if (first === "week") return calendar({ type: "same-weekday" });
    if (first === "month") return calendar({ type: "monthly", day: 1 });
  }
  if (first === "weekend" && second === "day" && others.length === 0) {
    return calendar({ type: "weekdays", days: [0, 6] });
  }

  // every week on monday and thursday
  if (first === "week" && second === "on") {
    const days = parseWeekdayList(others);
    return days === undefined ? UNRECOGNIZED : calendar({ type: "weekdays", days });
  }

  // every month on the 1st / every month on 15
  if (first === "month" && second === "on") {
    const rest = others[0] === "the" ? others.slice(1) : others;
    const day = parseOrdinal(rest[0]);
    const trailing = rest.slice(1);
    if (day === undefined) return UNRECOGNIZED;
    if (trailing.length > 0 && !(trailing.length === 1 && trailing[0] === "day")) return UNRECOGNIZED;
    return calendar({ type: "monthly", day });
  }

  const days = parseWeekdayList(body);
  if (days !== undefined) return calendar({ type: "weekdays", days });
  return UNRECOGNIZED;
}

const RECURRING_SHORTHAND: Readonly<Record<string, ReadonlyArray<string>>> = {
  daily: ["day"],
  hourly: ["hour"],
  weekly: ["week"],
  monthly: ["month"],
};

function parseRecurring(tokens: ReadonlyArray<string>): TimingResult {
  const { time, rest } = extractTime(tokens);
  const [head, ...tail] = rest;
  if (head === undefined) return UNRECOGNIZED;

  if (head === "every" || head === "each") return parseRecurringBody(tail, time);

  const shorthand = RECURRING_SHORTHAND[head];
  if (shorthand !== undefined) {
    // "weekly on monday", "monthly on the 1st", "daily"
    return parseRecurringBody([...shorthand, ...tail], time);
  }

  // "weekdays at 9", "on weekdays at 9", "on mondays and thursdays at 10"
  const body = head === "on" ? tail : rest;
  if (body.length === 1 && (body[0] === "weekdays" || body[0] === "weekends")) {
    return parseRecurringBody(body, time);
  }
  if (body.length > 0 && body.every((token) => token === "and" || isPluralWeekday(token))) {
    return parseRecurringBody(body, time);
  }

  // "on the 1st of every month"
  const monthly = /^(?:on )?(?:the )?(\d{1,2}(?:st|nd|rd|th)?) (?:day )?of (?:every|each) month$/.exec(rest.join(" "));
  if (monthly !== null) {
    const day = parseOrdinal(monthly[1]);
    if (day === undefined) return UNRECOGNIZED;
    return parseRecurringBody(["month", "on", String(day)], time);
  }
  return UNRECOGNIZED;
}

function parseRelative(tokens: ReadonlyArray<string>): TimingResult {
  if (tokens[0] !== "in") return UNRECOGNIZED;
  let days = 0;
  let minutes = 0;
  let index = 1;
  let matchedAny = false;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (matchedAny && token === "and") {
      index += 1;
      continue;
    }
    let amount: number | undefined;
    let unit: Unit | undefined;
    const compact = /^(\d+)(m|min|mins|h|hr|hrs|d|w)$/.exec(token);
    if (compact !== null) {
      amount = Number(compact[1]);
      unit = UNITS[compact[2] ?? ""];
      index += 1;
    } else if (token === "half" && tokens[index + 1] === "an" && tokens[index + 2] === "hour") {
      amount = 30;
      unit = "minute";
      index += 3;
    } else {
      amount = parseNumber(token);
      unit = UNITS[tokens[index + 1] ?? ""];
      index += 2;
    }
    if (amount === undefined || unit === undefined) return UNRECOGNIZED;
    matchedAny = true;
    if (unit === "minute") minutes += amount;
    else if (unit === "hour") minutes += amount * 60;
    else if (unit === "day") days += amount;
    else days += amount * 7;
  }
  if (!matchedAny) return UNRECOGNIZED;
  if (days === 0 && minutes === 0) return { kind: "invalid", message: "That time is right now. Try 'in 5 minutes'." };
  if (days > 366) return { kind: "invalid", message: "That's too far ahead. Pick something within a year." };
  return { kind: "ok", timing: { kind: "relative", days, minutes } };
}

function parseDayRef(tokens: ReadonlyArray<string>): DayRef | undefined {
  const phrase = tokens.join(" ");
  if (phrase === "") return { type: "none" };
  if (phrase === "today") return { type: "today" };
  if (phrase === "tonight") return { type: "tonight" };
  if (phrase === "tomorrow" || phrase === "tmrw" || phrase === "tmr") return { type: "tomorrow" };

  const weekday = /^(?:(on|next|this|on next|on this) )?([a-z]+)$/.exec(phrase);
  if (weekday !== null) {
    const day = WEEKDAYS[weekday[2] ?? ""];
    if (day !== undefined && !isPluralWeekday(weekday[2] ?? "")) {
      return { type: "weekday", weekday: day, strictlyFuture: (weekday[1] ?? "").endsWith("next") };
    }
  }

  const iso = /^(?:on )?(\d{4})-(\d{2})-(\d{2})$/.exec(phrase);
  if (iso !== null) {
    return { type: "date", year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  // on october 12 / oct 12th 2026 / 12 october / the 12th of october
  const monthFirst = /^(?:on )?([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(phrase);
  const dayFirst = /^(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/.exec(phrase);
  const monthName = monthFirst?.[1] ?? dayFirst?.[2];
  const dayText = monthFirst?.[2] ?? dayFirst?.[1];
  const yearText = monthFirst?.[3] ?? dayFirst?.[3];
  const month = monthName === undefined ? undefined : MONTHS[monthName];
  if (month !== undefined && dayText !== undefined) {
    return {
      type: "date",
      ...(yearText === undefined ? {} : { year: Number(yearText) }),
      month,
      day: Number(dayText),
    };
  }
  return undefined;
}

function parseOneShot(tokens: ReadonlyArray<string>): TimingResult {
  const { time, rest } = extractTime(tokens);
  const day = parseDayRef(rest);
  if (day === undefined) return UNRECOGNIZED;
  if (day.type === "none" && time === undefined) return UNRECOGNIZED;
  return { kind: "ok", timing: { kind: "at", day, ...(time === undefined ? {} : { time }) } };
}

function parseTiming(text: string): TimingResult {
  const cron = parseCronPhrase(text);
  if (cron.kind !== "unrecognized") return cron;
  const tokens = normalize(text);
  if (tokens.length === 0 || tokens.length > MAX_TIMING_WORDS) return UNRECOGNIZED;
  for (const parser of [parseRelative, parseRecurring, parseOneShot]) {
    const result = parser(tokens);
    if (result.kind !== "unrecognized") return result;
  }
  return UNRECOGNIZED;
}

// ---------------------------------------------------------------------------
// Resolution against a clock and time zone

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${pad(minute)} ${suffix}`;
}

function formatInstant(instant: Date, timeZone: string): string {
  const local = toLocal(instant, timeZone);
  const weekday = WEEKDAY_NAMES[weekdayOf(local)]?.slice(0, 3) ?? "";
  return `${weekday}, ${MONTH_NAMES[local.month - 1] ?? ""} ${local.day}, ${local.year} at ${formatTime(local.hour, local.minute)}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function cronList(days: ReadonlyArray<number>): string {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "1-5";
  return key;
}

function describeCalendar(pattern: CalendarPattern, weekday: number): string {
  switch (pattern.type) {
    case "daily":
      return "every day";
    case "same-weekday":
      return `every ${WEEKDAY_NAMES[weekday]}`;
    case "monthly":
      return `every month on the ${ordinal(pattern.day)}`;
    case "weekdays": {
      const key = pattern.days.join(",");
      if (key === "1,2,3,4,5") return "every weekday";
      if (key === "0,6") return "every weekend day";
      if (key === "0,1,2,3,4,5,6") return "every day";
      return `every ${joinWords(pattern.days.map((day) => WEEKDAY_NAMES[day] ?? ""))}`;
    }
  }
}

function describeInterval(seconds: number): string {
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  return `every ${seconds / 60} minutes`;
}

function minimumCronGapOk(expression: string, timeZone: string, now: Date): boolean {
  const parsed = parseCron(expression);
  if (parsed.kind === "error") return false;
  let previous = nextCronOccurrence(parsed.cron, timeZone, now);
  for (let index = 0; index < 24 && previous !== null; index += 1) {
    const next = nextCronOccurrence(parsed.cron, timeZone, previous);
    if (next === null) return true;
    if (next.getTime() - previous.getTime() < MIN_INTERVAL_SECONDS * 1_000) return false;
    previous = next;
  }
  return true;
}

function isValidDate(date: LocalDate): boolean {
  return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= daysInMonth(date.year, date.month);
}

const PAST_ERROR = "That time has already passed. Try a time in the future.";

function resolveAt(
  day: DayRef,
  time: TimeOfDay | undefined,
  now: Date,
  timeZone: string,
): { readonly kind: "ok"; readonly instant: Date } | { readonly kind: "error"; readonly message: string } {
  const local = toLocal(now, timeZone);
  const today: LocalDate = { year: local.year, month: local.month, day: local.day };
  let clock = time ?? { hour: DEFAULT_HOUR, minute: 0, meridiem: true };
  const at = (date: LocalDate): Date => fromLocal({ ...date, hour: clock.hour, minute: clock.minute }, timeZone);
  const future = (instant: Date): boolean => instant.getTime() > now.getTime();

  switch (day.type) {
    case "none": {
      const candidate = at(today);
      return { kind: "ok", instant: future(candidate) ? candidate : at(addDays(today, 1)) };
    }
    case "today":
    case "tonight": {
      if (day.type === "tonight") {
        if (time === undefined) clock = { hour: TONIGHT_DEFAULT_HOUR, minute: 0, meridiem: true };
        else if (!time.meridiem && time.hour < 12) clock = { ...time, hour: time.hour + 12 };
      } else if (time === undefined) {
        return { kind: "error", message: "What time today? Try 'today at 5pm'." };
      }
      const candidate = at(today);
      return future(candidate) ? { kind: "ok", instant: candidate } : { kind: "error", message: PAST_ERROR };
    }
    case "tomorrow":
      return { kind: "ok", instant: at(addDays(today, 1)) };
    case "weekday": {
      let ahead = (day.weekday - weekdayOf(today) + 7) % 7;
      if (ahead === 0 && (day.strictlyFuture || !future(at(today)))) ahead = 7;
      return { kind: "ok", instant: at(addDays(today, ahead)) };
    }
    case "date": {
      const explicit = day.year !== undefined;
      let date: LocalDate = { year: day.year ?? today.year, month: day.month, day: day.day };
      if (!explicit && !(isValidDate(date) && future(at(date)))) date = { ...date, year: date.year + 1 };
      if (!explicit && !isValidDate(date)) {
        // Feb 29 without a year: find the next leap year.
        for (let offset = 1; offset <= 8 && !isValidDate(date); offset += 1) date = { ...date, year: today.year + offset };
      }
      if (!isValidDate(date)) {
        return { kind: "error", message: `${MONTH_NAMES[day.month - 1] ?? "That month"} doesn't have a day ${day.day}.` };
      }
      const instant = at(date);
      if (!future(instant)) return { kind: "error", message: PAST_ERROR };
      if (instant.getTime() - now.getTime() > MAX_CADENCE_SECONDS * 1_000 * 5) {
        return { kind: "error", message: "That's too far ahead. Pick something within the next few years." };
      }
      return { kind: "ok", instant };
    }
  }
}

function resolveTiming(timing: Timing, options: ParseScheduleOptions): ScheduleParseResult {
  const { now, timeZone } = options;
  const zone = ` (${timeZone})`;
  const oneShot = (instant: Date, prefix = "once on"): ScheduleParseResult => ({
    kind: "ok",
    schedule: { runAt: instant.toISOString() },
    recurring: false,
    humanReadable: `${prefix} ${formatInstant(instant, timeZone)}${zone}`,
    nextRunAt: instant.toISOString(),
  });
  const cronSchedule = (expression: string, description: string): ScheduleParseResult => {
    if (!minimumCronGapOk(expression, timeZone, now)) {
      return {
        kind: "error",
        message: `That's too frequent. Routines can repeat at most every ${MIN_INTERVAL_SECONDS / 60} minutes.`,
      };
    }
    const parsed = parseCron(expression);
    const next = parsed.kind === "ok" ? nextCronOccurrence(parsed.cron, timeZone, now) : null;
    if (next === null) return { kind: "error", message: "That schedule never runs. Check the date and try again." };
    const runAt = next.toISOString();
    return {
      kind: "ok",
      schedule: { runAt, recurrence: { kind: "cron", expression, timeZone } },
      recurring: true,
      humanReadable: `${description}${zone}`,
      nextRunAt: runAt,
    };
  };

  switch (timing.kind) {
    case "relative": {
      let base = now;
      if (timing.days > 0) {
        // Calendar days keep the same wall-clock time across DST changes.
        const local = toLocal(now, timeZone);
        const shifted = fromLocal({ ...addDays(local, timing.days), hour: local.hour, minute: local.minute }, timeZone);
        base = new Date(shifted.getTime() + (now.getTime() % 60_000 + 60_000) % 60_000);
      }
      return oneShot(new Date(base.getTime() + timing.minutes * 60_000));
    }
    case "at": {
      const resolved = resolveAt(timing.day, timing.time, now, timeZone);
      return resolved.kind === "ok" ? oneShot(resolved.instant) : resolved;
    }
    case "interval": {
      const runAt = new Date(now.getTime() + timing.seconds * 1_000).toISOString();
      return {
        kind: "ok",
        schedule: { runAt, cadenceSeconds: timing.seconds },
        recurring: true,
        humanReadable: describeInterval(timing.seconds),
        nextRunAt: runAt,
      };
    }
    case "calendar": {
      const { hour, minute } = timing.time;
      const todayWeekday = weekdayOf(toLocal(now, timeZone));
      const pattern = timing.pattern;
      const field =
        pattern.type === "daily"
          ? "* * *"
          : pattern.type === "monthly"
            ? `${pattern.day} * *`
            : pattern.type === "same-weekday"
              ? `* * ${todayWeekday}`
              : pattern.days.length === 7
                ? "* * *"
                : `* * ${cronList(pattern.days)}`;
      const description = `${describeCalendar(pattern, todayWeekday)} at ${formatTime(hour, minute)}`;
      return cronSchedule(`${minute} ${hour} ${field}`, description);
    }
    case "cron":
      return cronSchedule(timing.expression, `on cron schedule \`${timing.expression}\``);
  }
}

/** Parse a timing phrase like "every weekday at 9am" or "in 2 hours". */
export function parseSchedule(text: string, options: ParseScheduleOptions): ScheduleParseResult {
  if (!isValidTimeZone(options.timeZone)) {
    return { kind: "error", message: `I don't recognize the time zone "${options.timeZone}".` };
  }
  if (Number.isNaN(options.now.getTime())) return { kind: "error", message: "Invalid reference time." };
  const parsed = parseTiming(text);
  if (parsed.kind === "unrecognized") return { kind: "error", message: GENERIC_PARSE_ERROR };
  if (parsed.kind === "invalid") return { kind: "error", message: parsed.message };
  return resolveTiming(parsed.timing, options);
}

// ---------------------------------------------------------------------------
// Spec conversion

export interface ScheduleSpecDefaults {
  readonly kind: ScheduleSpec["kind"];
  readonly prompt: string;
  readonly missedRunPolicy?: ScheduleSpec["missedRunPolicy"];
  readonly misfireGraceSeconds?: number;
  readonly overlapPolicy?: ScheduleSpec["overlapPolicy"];
}

/**
 * Build a scheduler spec. Defaults: one-shot runs still fire if missed
 * ("run-once"); recurring runs skip missed occurrences after a 5 minute grace.
 */
export function toScheduleSpec(schedule: ParsedSchedule, defaults: ScheduleSpecDefaults): ScheduleSpec {
  const recurring = schedule.cadenceSeconds !== undefined || schedule.recurrence !== undefined;
  return {
    kind: defaults.kind,
    prompt: defaults.prompt.trim(),
    runAt: schedule.runAt,
    ...(schedule.cadenceSeconds === undefined ? {} : { cadenceSeconds: schedule.cadenceSeconds }),
    ...(schedule.recurrence === undefined ? {} : { recurrence: schedule.recurrence }),
    missedRunPolicy: defaults.missedRunPolicy ?? (recurring ? "skip" : "run-once"),
    misfireGraceSeconds: defaults.misfireGraceSeconds ?? 300,
    overlapPolicy: defaults.overlapPolicy ?? "skip",
  };
}

// ---------------------------------------------------------------------------
// Splitting "<timing> <task>" requests

export type RoutineSplitResult =
  | {
      readonly kind: "ok";
      readonly scheduleKind: ScheduleSpec["kind"];
      readonly timing: string;
      readonly task: string;
    }
  | { readonly kind: "error"; readonly message: string };

const REMINDER_LEAD = /^(?:please\s+)?(?:set\s+(?:a\s+)?reminder\s*:?|reminder\s*:|remind\s+(?:me|us|everyone|the\s+team|<[@#!][^>]+>))\s*/i;
const AGENT_LEAD = /^(?:(?:please|can\s+you|could\s+you|schedule|routine\s*:)\s+)+/i;
const TASK_LEAD = /^(?:(?:to|that|about|and)\s+|[:,\-–—]+\s*)+/i;

function cleanTask(words: ReadonlyArray<string>): string {
  return words
    .join(" ")
    .replace(TASK_LEAD, "")
    .replace(/[\s,:;\-–—]+$/, "")
    .replace(/\s+(?:to|and)$/i, "")
    .trim();
}

interface TimingSplit {
  readonly timing: string;
  readonly taskWords: ReadonlyArray<string>;
}

/**
 * Longest leading phrase, else longest trailing phrase, whose parse result is
 * accepted. Prefers the timing at the start ("<timing> <task>").
 */
function findTiming(words: ReadonlyArray<string>, accept: (result: TimingResult) => boolean): TimingSplit | undefined {
  const limit = Math.min(words.length, MAX_TIMING_WORDS);
  for (let size = limit; size >= 1; size -= 1) {
    const candidate = words.slice(0, size).join(" ");
    if (accept(parseTiming(candidate))) return { timing: candidate, taskWords: words.slice(size) };
  }
  for (let start = Math.max(1, words.length - MAX_TIMING_WORDS); start < words.length; start += 1) {
    const candidate = words.slice(start).join(" ");
    if (accept(parseTiming(candidate))) return { timing: candidate, taskWords: words.slice(0, start) };
  }
  return undefined;
}

/**
 * Separate the timing phrase from the task text.
 * "every weekday at 9am summarize open PRs" -> agent, "every weekday at 9am", "summarize open PRs"
 * "remind me tomorrow at 3pm to deploy"      -> reminder, "tomorrow at 3pm", "deploy"
 * The timing may also trail the task: "remind me to deploy tomorrow at 3pm".
 */
export function splitRoutineRequest(text: string): RoutineSplitResult {
  let rest = text.trim().replace(/^(?:<@[^>]+>\s*)+/, "");
  let scheduleKind: ScheduleSpec["kind"] = "agent";
  const reminder = REMINDER_LEAD.exec(rest);
  if (reminder !== null) {
    scheduleKind = "reminder";
    rest = rest.slice(reminder[0].length);
  } else {
    rest = rest.replace(AGENT_LEAD, "");
  }
  const words = rest.split(/\s+/).filter((word) => word.length > 0);
  // Prefer a valid timing; fall back to a recognized-but-invalid one so the
  // caller can surface its specific error (e.g. "too frequent").
  const found =
    findTiming(words, (result) => result.kind === "ok") ??
    findTiming(words, (result) => result.kind === "invalid");
  if (found === undefined) return { kind: "error", message: GENERIC_PARSE_ERROR };
  const { timing, taskWords } = found;
  const task = cleanTask(taskWords);
  if (task.length === 0) {
    return {
      kind: "error",
      message:
        scheduleKind === "reminder"
          ? "What should I remind you about? Try 'remind me tomorrow at 3pm to deploy'."
          : "What should I do then? Try 'every weekday at 9am summarize open PRs'.",
    };
  }
  return { kind: "ok", scheduleKind, timing: timing.replace(/[\s,:;\-–—]+$/, ""), task };
}

export type RoutineParseResult =
  | {
      readonly kind: "ok";
      readonly spec: ScheduleSpec;
      readonly task: string;
      readonly recurring: boolean;
      readonly humanReadable: string;
      readonly nextRunAt: string;
    }
  | { readonly kind: "error"; readonly message: string };

/** Split + parse + convert in one step: Slack text -> scheduler spec. */
export function parseRoutineRequest(text: string, options: ParseScheduleOptions): RoutineParseResult {
  const split = splitRoutineRequest(text);
  if (split.kind === "error") return split;
  const parsed = parseSchedule(split.timing, options);
  if (parsed.kind === "error") return parsed;
  return {
    kind: "ok",
    spec: toScheduleSpec(parsed.schedule, { kind: split.scheduleKind, prompt: split.task }),
    task: split.task,
    recurring: parsed.recurring,
    humanReadable: parsed.humanReadable,
    nextRunAt: parsed.nextRunAt,
  };
}
