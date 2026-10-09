import { escapeSlackText } from "../slack/render.ts";
import type { ScheduleSummary } from "../store/types.ts";
import { describeInterval, formatInstant } from "./parse.ts";
import { isValidTimeZone } from "./zoned.ts";

/**
 * Human-readable text for stored schedules: ids, dates and cadence as users see them in Slack.
 * Pure: output depends only on the arguments.
 */

/** First six hex characters of a schedule id, as shown to users (`a1b2c3`). */
export function shortScheduleId(scheduleId: string): string {
  return scheduleId.replaceAll("-", "").slice(0, 6).toLowerCase();
}

/** A Slack date token: rendered in each viewer's own time zone, with the ISO time as fallback text. */
export function slackDateToken(iso: string): string {
  const epoch = Math.floor(Date.parse(iso) / 1_000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${iso}>`;
}

/** Collapse whitespace to one line and cut it to `limit` characters (with an ellipsis). */
export function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Prompts are cut to this many characters in lists and notices. */
export const PROMPT_PREVIEW_LENGTH = 150;

/** A prompt as inert, single-line Slack text for use inside `*bold*` (no mentions, no stray `*`). */
export function promptPreview(prompt: string, limit = PROMPT_PREVIEW_LENGTH): string {
  return escapeSlackText(oneLine(prompt, limit)).replaceAll("*", "");
}

function describeCadence(seconds: number): string {
  return seconds % 60 === 0 ? describeInterval(seconds) : `every ${seconds} seconds`;
}

export type DescribableSchedule = Pick<
  ScheduleSummary,
  "humanReadable" | "recurrence" | "cadenceSeconds" | "nextRunAt" | "timeZone"
>;

/**
 * When a schedule runs, in words. Uses the parser's stored description when there is one
 * ("every weekday at 9:00 AM (America/New_York)"); otherwise (CLI-created rows) the cron
 * expression and its zone, the fixed cadence, or the one-shot time.
 */
export function describeSchedule(schedule: DescribableSchedule): string {
  const stored = schedule.humanReadable?.trim();
  if (stored !== undefined && stored !== "") return escapeSlackText(oneLine(stored, 200));
  if (schedule.recurrence !== null) {
    const expression = schedule.recurrence.expression.replaceAll("`", "");
    return escapeSlackText(`on cron schedule \`${expression}\` (${schedule.recurrence.timeZone})`);
  }
  if (schedule.cadenceSeconds !== null) return describeCadence(schedule.cadenceSeconds);
  if (schedule.timeZone !== null && isValidTimeZone(schedule.timeZone)) {
    return escapeSlackText(`once on ${formatInstant(new Date(schedule.nextRunAt), schedule.timeZone)} (${schedule.timeZone})`);
  }
  return `once on ${slackDateToken(schedule.nextRunAt)}`;
}

/**
 * The text a reminder posts when it fires. It @mentions only the requester or a user they named
 * (`notifyUserId`), never `@here`/`@channel`, and the prompt is escaped so it cannot mention anyone.
 */
export function reminderText(input: { readonly prompt: string; readonly notifyUserId: string | null }): string {
  const prompt = escapeSlackText(input.prompt.trim());
  const notify = input.notifyUserId === null ? null : /^[UW][A-Z0-9]+$/.exec(input.notifyUserId)?.[0];
  if (notify === null || notify === undefined) return `Reminder: ${prompt}`;
  return `<@${notify}> :alarm_clock: Reminder: ${prompt}`;
}
