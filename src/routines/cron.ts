import { z } from "zod";

import {
  addDays,
  fromLocal,
  isValidTimeZone,
  offsetTransitions,
  toLocal,
  weekdayOf,
  type LocalDate,
} from "./zoned.ts";

/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week) evaluated
 * in an IANA time zone. Supports `*`, numbers, `a-b` ranges, `,` lists and
 * `/n` steps; day-of-week accepts 0-7 (0 and 7 are Sunday). When both
 * day-of-month and day-of-week are restricted, a day matches either (Vixie cron).
 */
export interface CronExpression {
  readonly minutes: ReadonlyArray<number>;
  readonly hours: ReadonlyArray<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

export type CronParseResult =
  | { readonly kind: "ok"; readonly cron: CronExpression }
  | { readonly kind: "error"; readonly message: string };

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELDS: ReadonlyArray<FieldSpec> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseField(source: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (match === null) return `invalid ${spec.name} field "${source}"`;
    const range = match[1] ?? "";
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) return `invalid step in ${spec.name} field`;
    let low = spec.min;
    let high = spec.max;
    if (range !== "*") {
      const [first, second] = range.split("-");
      low = Number(first);
      high = second === undefined ? (match[2] === undefined ? low : spec.max) : Number(second);
    }
    if (low < spec.min || high > spec.max || low > high) {
      return `${spec.name} value out of range in "${source}"`;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronParseResult {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { kind: "error", message: "cron expressions need exactly 5 fields (minute hour day month weekday)" };
  }
  const parsed: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const field = parseField(parts[index] ?? "", spec);
    if (typeof field === "string") return { kind: "error", message: field };
    parsed.push(field);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    kind: "ok",
    cron: {
      minutes: [...minutes].sort((left, right) => left - right),
      hours: [...hours].sort((left, right) => left - right),
      daysOfMonth,
      months,
      daysOfWeek,
      domRestricted: !(parts[2] ?? "").startsWith("*"),
      dowRestricted: !(parts[4] ?? "").startsWith("*"),
    },
  };
}

function dayMatches(cron: CronExpression, date: LocalDate): boolean {
  if (!cron.months.has(date.month)) return false;
  const domOk = cron.daysOfMonth.has(date.day);
  const dowOk = cron.daysOfWeek.has(weekdayOf(date));
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Covers leap-day-only expressions (Feb 29 recurs at most every 8 years). */
const MAX_SCAN_DAYS = 366 * 8 + 2;
const DST_SLACK_MS = 3 * 3_600_000;

/** First occurrence strictly after `after`, or null if the expression never fires. */
export function nextCronOccurrence(cron: CronExpression, timeZone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  const start = toLocal(after, timeZone);
  // Start one local day early so DST-shifted candidates near midnight are not missed.
  const startWall = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute);
  let date: LocalDate = addDays(start, -1);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1, date = addDays(date, 1)) {
    if (!dayMatches(cron, date)) continue;
    let best: number | null = null;
    let bestWall = 0;
    scan: for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
        // Wall order tracks instant order except inside DST shifts (< 3h), so
        // candidates far before `after` or far beyond the best can be skipped.
        if (wall < startWall - DST_SLACK_MS) continue;
        if (best !== null && wall > bestWall + DST_SLACK_MS) break scan;
        const instant = fromLocal({ ...date, hour, minute }, timeZone).getTime();
        if (instant > afterMs && (best === null || instant < best)) {
          best = instant;
          bestWall = wall;
        }
      }
    }
    if (best !== null) return new Date(best);
  }
  return null;
}

/** Weekday/date alignment repeats every 28 years (within 1901-2099). */
const CONSECUTIVE_DAY_SCAN = 366 * 28 + 7;
/** Two years of transitions captures a zone's recurring DST rules. */
const TRANSITION_HORIZON_MS = 2 * 366 * 86_400_000;
const MINUTES_PER_DAY = 1_440;

function hasConsecutiveMatchingDays(cron: CronExpression, from: Date): boolean {
  let date: LocalDate = { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() };
  let previous = dayMatches(cron, date);
  for (let index = 0; index < CONSECUTIVE_DAY_SCAN; index += 1) {
    date = addDays(date, 1);
    const current = dayMatches(cron, date);
    if (previous && current) return true;
    previous = current;
  }
  return false;
}

interface ClockTransition {
  /** Local minute of day (old offset) at which the offset changes. */
  readonly minute: number;
  /** New offset minus old offset, in minutes; positive for spring-forward. */
  readonly delta: number;
}

/** Distinct (time of day, delta) offset changes the zone makes. */
function clockTransitions(timeZone: string, from: Date): ClockTransition[] {
  const unique = new Map<string, ClockTransition>();
  const to = new Date(from.getTime() + TRANSITION_HORIZON_MS);
  for (const { at, deltaMs } of offsetTransitions(timeZone, from, to)) {
    const before = toLocal(new Date(at.getTime() - 60_000), timeZone);
    const minute = (before.hour * 60 + before.minute + 1) % MINUTES_PER_DAY;
    const delta = Math.round(deltaMs / 60_000);
    unique.set(`${minute}/${delta}`, { minute, delta });
  }
  return [...unique.values()];
}

/**
 * Real minutes (from local midnight, old offset) at which clock `times` fire
 * on a day whose offset changes at `transition`. Mirrors `fromLocal`: times
 * before the change keep the old offset (fall-back repeats resolve to the
 * first occurrence), times in a spring-forward gap shift forward by the gap,
 * and later times use the new offset.
 */
function realMinutes(times: ReadonlyArray<number>, transition: ClockTransition, at: number): number[] {
  const unshiftedUntil = at + Math.max(transition.delta, 0);
  const real = times.map((time) => (time < unshiftedUntil ? time : time - transition.delta));
  // Times that land on the same instant fire once.
  return [...new Set(real)].sort((left, right) => left - right);
}

function gapsAtLeast(sorted: ReadonlyArray<number>, minGapMs: number): boolean {
  for (let index = 1; index < sorted.length; index += 1) {
    if (((sorted[index] ?? 0) - (sorted[index - 1] ?? 0)) * 60_000 < minGapMs) return false;
  }
  return true;
}

/**
 * Whether consecutive runs are always at least `minGapMs` apart, for any
 * date. Outside UTC offset changes the real gap equals the wall-clock gap.
 * Offset changes can compress gaps (1:58 EST -> 3:00 EDT is 2 minutes), so
 * each of the zone's transition times is applied to the clock times as if a
 * matching day fell on it, ignoring day/month restrictions (conservative).
 * `from` only seeds the transition and consecutive-day searches.
 */
export function hasMinimumSpacing(cron: CronExpression, timeZone: string, from: Date, minGapMs: number): boolean {
  const times: number[] = [];
  for (const hour of cron.hours) for (const minute of cron.minutes) times.push(hour * 60 + minute);
  if (!gapsAtLeast(times, minGapMs)) return false;

  let consecutive: boolean | undefined;
  const consecutiveDays = (): boolean => (consecutive ??= hasConsecutiveMatchingDays(cron, from));
  const wrap = (times[0] ?? 0) + MINUTES_PER_DAY - (times[times.length - 1] ?? 0);
  if (wrap * 60_000 < minGapMs && consecutiveDays()) return false;

  for (const transition of clockTransitions(timeZone, from)) {
    if (consecutiveDays()) {
      // Two days in a row, with the change on either day, covers pairs across midnight.
      const twoDays = [...times, ...times.map((time) => time + MINUTES_PER_DAY)];
      for (const at of [transition.minute, transition.minute + MINUTES_PER_DAY]) {
        if (!gapsAtLeast(realMinutes(twoDays, transition, at), minGapMs)) return false;
      }
    } else if (!gapsAtLeast(realMinutes(times, transition, transition.minute), minGapMs)) {
      return false;
    }
  }
  return true;
}

export const scheduleRecurrenceSchema = z
  .object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(9).max(200),
    timeZone: z.string().trim().min(1).max(100),
  })
  .refine((value) => parseCron(value.expression).kind === "ok", { message: "invalid cron expression" })
  .refine((value) => isValidTimeZone(value.timeZone), { message: "invalid time zone" });

export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;

/** Next run for a persisted recurrence; throws only if the stored value is corrupt. */
export function nextRecurrenceRun(recurrence: ScheduleRecurrence, after: Date): Date | null {
  const parsed = parseCron(recurrence.expression);
  if (parsed.kind === "error") throw new Error(`invalid stored cron expression: ${parsed.message}`);
  return nextCronOccurrence(parsed.cron, recurrence.timeZone, after);
}
