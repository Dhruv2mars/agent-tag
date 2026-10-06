/**
 * Minimal, dependency-free wall-clock <-> instant conversion built on Intl.
 * All "local" values are wall-clock fields in an IANA time zone.
 */

export interface LocalDateTime {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
}

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts extends LocalDateTime {
  readonly second: number;
}

function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Wall-clock fields for an instant in the given zone. */
export function toLocal(instant: Date, timeZone: string): LocalDateTime {
  const { year, month, day, hour, minute } = zonedParts(instant.getTime(), timeZone);
  return { year, month, day, hour, minute };
}

function wallMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
}

/** UTC offset (ms) in effect at an instant. */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = zonedParts(instantMs, timeZone);
  const asWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asWall - Math.floor(instantMs / 1_000) * 1_000;
}

/**
 * Convert wall-clock fields to an instant. Ambiguous times (DST fall-back)
 * resolve to the earlier instant; nonexistent times (DST spring-forward gap)
 * shift forward by the length of the gap, matching common cron behaviour.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): Date {
  const wall = wallMs(local);
  const before = offsetAt(wall - 18 * 3_600_000, timeZone);
  const after = offsetAt(wall + 18 * 3_600_000, timeZone);
  const candidates = [wall - before, wall - after]
    .filter((instant) => wallMs(toLocal(new Date(instant), timeZone)) === wall)
    .sort((left, right) => left - right);
  return new Date(candidates[0] ?? wall - before);
}

/** Calendar arithmetic on local dates (no time zone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
