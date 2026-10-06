import { describe, expect, test } from "bun:test";

import { nextCronOccurrence, nextRecurrenceRun, parseCron } from "../src/routines/cron.ts";
import {
  GENERIC_PARSE_ERROR,
  parseRoutineRequest,
  parseSchedule,
  splitRoutineRequest,
  toScheduleSpec,
  type ParseScheduleOptions,
  type ScheduleParseResult,
} from "../src/routines/parse.ts";
import { fromLocal, offsetTransitions, toLocal } from "../src/routines/zoned.ts";
import { scheduleSpecSchema } from "../src/scheduler.ts";

const NEW_YORK = "America/New_York";
const KOLKATA = "Asia/Kolkata";
// Tuesday 2026-10-06 10:00 EDT / 19:30 IST.
const NOW = new Date("2026-10-06T14:00:00.000Z");
const ny: ParseScheduleOptions = { now: NOW, timeZone: NEW_YORK };
const ist: ParseScheduleOptions = { now: NOW, timeZone: KOLKATA };

function ok(result: ScheduleParseResult) {
  if (result.kind !== "ok") throw new Error(`expected ok, got: ${result.message}`);
  return result;
}

function errorOf(result: ScheduleParseResult): string {
  if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
  return result.message;
}

function runAt(text: string, options: ParseScheduleOptions): string {
  return ok(parseSchedule(text, options)).nextRunAt;
}

describe("one-shot schedules", () => {
  test.each([
    ["in 20 minutes", "2026-10-06T14:20:00.000Z"],
    ["in 2 hours", "2026-10-06T16:00:00.000Z"],
    ["in an hour", "2026-10-06T15:00:00.000Z"],
    ["in half an hour", "2026-10-06T14:30:00.000Z"],
    ["in 2 hours and 30 minutes", "2026-10-06T16:30:00.000Z"],
    ["in 1h 30m", "2026-10-06T15:30:00.000Z"],
    ["tomorrow at 9am", "2026-10-07T13:00:00.000Z"],
    ["tomorrow", "2026-10-07T13:00:00.000Z"],
    ["at 3:30pm", "2026-10-06T19:30:00.000Z"],
    ["at 3:30 p.m.", "2026-10-06T19:30:00.000Z"],
    ["at 9am", "2026-10-07T13:00:00.000Z"], // already past today -> tomorrow
    ["at 15", "2026-10-06T19:00:00.000Z"], // bare hours are 24-hour
    ["3pm tomorrow", "2026-10-07T19:00:00.000Z"],
    ["on friday at 10", "2026-10-09T14:00:00.000Z"],
    ["friday at noon", "2026-10-09T16:00:00.000Z"],
    ["on tuesday at 11am", "2026-10-06T15:00:00.000Z"], // later today
    ["on tuesday at 9am", "2026-10-13T13:00:00.000Z"], // passed today -> next week
    ["next tuesday at 11am", "2026-10-13T15:00:00.000Z"], // "next" never means today
    ["on 2026-10-12 14:00", "2026-10-12T18:00:00.000Z"],
    ["2026-10-12 at 2pm", "2026-10-12T18:00:00.000Z"],
    ["next monday 9am", "2026-10-12T13:00:00.000Z"],
    ["on oct 12th at 9:15am", "2026-10-12T13:15:00.000Z"],
    ["on the 3rd of march at 8am", "2027-03-03T13:00:00.000Z"], // rolls to next year
    ["tonight at 8", "2026-10-07T00:00:00.000Z"],
    ["today at 5pm", "2026-10-06T21:00:00.000Z"],
    ["at midnight", "2026-10-07T04:00:00.000Z"],
  ])("%s (New York)", (text, expected) => {
    const result = ok(parseSchedule(text, ny));
    expect(result.nextRunAt).toBe(expected);
    expect(result.schedule).toEqual({ runAt: expected });
    expect(result.recurring).toBe(false);
  });

  test.each([
    ["in 20 minutes", "2026-10-06T14:20:00.000Z"],
    ["tomorrow at 9am", "2026-10-07T03:30:00.000Z"],
    ["at 3:30pm", "2026-10-07T10:00:00.000Z"], // 19:30 IST now -> tomorrow
    ["at 9:45pm", "2026-10-06T16:15:00.000Z"],
    ["on friday at 10", "2026-10-09T04:30:00.000Z"],
    ["on 2026-10-12 14:00", "2026-10-12T08:30:00.000Z"],
    ["next monday 9am", "2026-10-12T03:30:00.000Z"],
  ])("%s (Kolkata)", (text, expected) => {
    expect(runAt(text, ist)).toBe(expected);
  });

  test("human readable text uses the user's wall clock and zone", () => {
    expect(ok(parseSchedule("tomorrow at 9am", ny)).humanReadable).toBe(
      "once on Wed, Oct 7, 2026 at 9:00 AM (America/New_York)",
    );
    expect(ok(parseSchedule("tomorrow at 9am", ist)).humanReadable).toBe(
      "once on Wed, Oct 7, 2026 at 9:00 AM (Asia/Kolkata)",
    );
  });
});

describe("recurring schedules", () => {
  test.each([
    ["every day at 9am", "0 9 * * *", "2026-10-07T13:00:00.000Z", "every day at 9:00 AM (America/New_York)"],
    ["daily at 6:15pm", "15 18 * * *", "2026-10-06T22:15:00.000Z", "every day at 6:15 PM (America/New_York)"],
    ["every weekday at 9:30", "30 9 * * 1-5", "2026-10-07T13:30:00.000Z", "every weekday at 9:30 AM (America/New_York)"],
    ["weekdays at 9am", "0 9 * * 1-5", "2026-10-07T13:00:00.000Z", "every weekday at 9:00 AM (America/New_York)"],
    ["at 9am every weekday", "0 9 * * 1-5", "2026-10-07T13:00:00.000Z", "every weekday at 9:00 AM (America/New_York)"],
    [
      "every monday and thursday at 10am",
      "0 10 * * 1,4",
      "2026-10-08T14:00:00.000Z",
      "every Monday and Thursday at 10:00 AM (America/New_York)",
    ],
    [
      "on mondays, wednesdays and fridays at 5pm",
      "0 17 * * 1,3,5",
      "2026-10-07T21:00:00.000Z",
      "every Monday, Wednesday and Friday at 5:00 PM (America/New_York)",
    ],
    ["every weekend at 10am", "0 10 * * 0,6", "2026-10-10T14:00:00.000Z", "every weekend day at 10:00 AM (America/New_York)"],
    ["every week on friday at 4pm", "0 16 * * 5", "2026-10-09T20:00:00.000Z", "every Friday at 4:00 PM (America/New_York)"],
    ["weekly", "0 9 * * 2", "2026-10-13T13:00:00.000Z", "every Tuesday at 9:00 AM (America/New_York)"],
    [
      "every month on the 1st at 9am",
      "0 9 1 * *",
      "2026-11-01T14:00:00.000Z",
      "every month on the 1st at 9:00 AM (America/New_York)",
    ],
    [
      "on the 15th of every month at noon",
      "0 12 15 * *",
      "2026-10-15T16:00:00.000Z",
      "every month on the 15th at 12:00 PM (America/New_York)",
    ],
    ["cron: 0 9 * * 1-5", "0 9 * * 1-5", "2026-10-07T13:00:00.000Z", "on cron schedule `0 9 * * 1-5` (America/New_York)"],
    ["cron 30 8 1,15 * *", "30 8 1,15 * *", "2026-10-15T12:30:00.000Z", "on cron schedule `30 8 1,15 * *` (America/New_York)"],
  ])("%s", (text, expression, next, humanReadable) => {
    const result = ok(parseSchedule(text, ny));
    expect(result.recurring).toBe(true);
    expect(result.schedule).toEqual({
      runAt: next,
      recurrence: { kind: "cron", expression, timeZone: NEW_YORK },
    });
    expect(result.nextRunAt).toBe(next);
    expect(result.humanReadable).toBe(humanReadable);
  });

  test.each([
    ["every hour", 3_600, "every hour"],
    ["hourly", 3_600, "every hour"],
    ["every 15 minutes", 900, "every 15 minutes"],
    ["every 5 min", 300, "every 5 minutes"],
    ["every half hour", 1_800, "every 30 minutes"],
    ["every 2 hours", 7_200, "every 2 hours"],
  ])("%s uses a fixed cadence", (text, seconds, humanReadable) => {
    const result = ok(parseSchedule(text, ny));
    expect(result.schedule).toEqual({
      runAt: new Date(NOW.getTime() + seconds * 1_000).toISOString(),
      cadenceSeconds: seconds,
    });
    expect(result.humanReadable).toBe(humanReadable);
  });

  test("calendar recurrences resolve in Kolkata", () => {
    const result = ok(parseSchedule("every weekday at 9:30", ist));
    expect(result.schedule.recurrence).toEqual({ kind: "cron", expression: "30 9 * * 1-5", timeZone: KOLKATA });
    expect(result.nextRunAt).toBe("2026-10-07T04:00:00.000Z");
    expect(runAt("every month on the 1st at 9am", ist)).toBe("2026-11-01T03:30:00.000Z");
    expect(runAt("every day at 9:45pm", ist)).toBe("2026-10-06T16:15:00.000Z");
  });
});

describe("DST correctness", () => {
  // Saturday 2026-10-31 12:00 EDT; clocks fall back at 02:00 on Sunday 2026-11-01.
  const beforeFallBack: ParseScheduleOptions = { now: new Date("2026-10-31T16:00:00.000Z"), timeZone: NEW_YORK };

  test("one-shot wall-clock times across the fall-back boundary", () => {
    expect(runAt("tomorrow at 9am", beforeFallBack)).toBe("2026-11-01T14:00:00.000Z");
    expect(runAt("in 2 days", beforeFallBack)).toBe("2026-11-02T17:00:00.000Z"); // still 12:00 local
    expect(runAt("in 48 hours", beforeFallBack)).toBe("2026-11-02T16:00:00.000Z"); // 11:00 EST
    // 01:30 happens twice; we pick the first (EDT) occurrence.
    expect(runAt("tomorrow at 1:30am", beforeFallBack)).toBe("2026-11-01T05:30:00.000Z");
  });

  test("daily cron keeps 9am local across fall-back", () => {
    const result = ok(parseSchedule("every day at 9am", { ...beforeFallBack, now: new Date("2026-10-30T12:00:00.000Z") }));
    const recurrence = result.schedule.recurrence;
    if (recurrence === undefined) throw new Error("expected recurrence");
    const runs = [new Date(result.nextRunAt)];
    for (let index = 0; index < 3; index += 1) {
      const next = nextRecurrenceRun(recurrence, runs[runs.length - 1] as Date);
      if (next === null) throw new Error("expected another run");
      runs.push(next);
    }
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  test("ambiguous local times fire once, not twice", () => {
    const cron = parseCron("30 1 * * *");
    if (cron.kind !== "ok") throw new Error("cron");
    const first = nextCronOccurrence(cron.cron, NEW_YORK, new Date("2026-10-31T16:00:00.000Z"));
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronOccurrence(cron.cron, NEW_YORK, first as Date)?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("nonexistent spring-forward times shift forward by the gap", () => {
    const beforeSpring: ParseScheduleOptions = { now: new Date("2026-03-07T17:00:00.000Z"), timeZone: NEW_YORK };
    expect(runAt("tomorrow at 2:30am", beforeSpring)).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(runAt("every day at 2:30am", beforeSpring)).toBe("2026-03-08T07:30:00.000Z");
    expect(fromLocal({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, NEW_YORK).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  test("Kolkata has no DST and a half-hour offset", () => {
    expect(toLocal(new Date("2026-11-01T06:30:00.000Z"), KOLKATA)).toEqual({
      year: 2026, month: 11, day: 1, hour: 12, minute: 0,
    });
    const options: ParseScheduleOptions = { now: new Date("2026-10-31T16:00:00.000Z"), timeZone: KOLKATA };
    expect(runAt("tomorrow at 9am", options)).toBe("2026-11-01T03:30:00.000Z");
    expect(runAt("in 2 days", options)).toBe("2026-11-02T16:00:00.000Z");
  });
});

describe("errors", () => {
  test.each([
    ["blah", GENERIC_PARSE_ERROR],
    ["", GENERIC_PARSE_ERROR],
    ["at 25:00", GENERIC_PARSE_ERROR],
    ["at 13pm", GENERIC_PARSE_ERROR],
    ["every 2 minutes", "That's too frequent. Routines can repeat at most every 5 minutes."],
    ["every minute", "That's too frequent. Routines can repeat at most every 5 minutes."],
    ["cron: * * * * *", "That's too frequent. Routines can repeat at most every 5 minutes."],
    ["cron: 0,2 9 * * *", "That's too frequent. Routines can repeat at most every 5 minutes."],
    ["cron: 0 9 * *", "That cron expression isn't valid: cron expressions need exactly 5 fields (minute hour day month weekday)."],
    ["cron: 61 9 * * *", 'That cron expression isn\'t valid: minute value out of range in "61".'],
    ["cron: 0 0 31 2 *", "That schedule never runs. Check the date and try again."],
    ["every 3 days", "Repeating every 3 days isn't supported yet. Try 'every day at 9am' or 'every monday at 9am'."],
    ["today at 9am", "That time has already passed. Try a time in the future."],
    ["on 2026-01-05 09:00", "That time has already passed. Try a time in the future."],
    ["on 2026-02-30 09:00", "Feb doesn't have a day 30."],
    ["today", "What time today? Try 'today at 5pm'."],
  ])("%s", (text, message) => {
    expect(errorOf(parseSchedule(text, ny))).toBe(message);
  });

  test("rejects unknown time zones", () => {
    expect(errorOf(parseSchedule("in 2 hours", { now: NOW, timeZone: "Mars/Olympus" }))).toBe(
      'I don\'t recognize the time zone "Mars/Olympus".',
    );
  });
});

describe("cron engine", () => {
  test("supports ranges, steps, lists and Sunday as 7", () => {
    const cron = parseCron("*/20 9-17/4 * * 7");
    if (cron.kind !== "ok") throw new Error(cron.message);
    expect(cron.cron.minutes).toEqual([0, 20, 40]);
    expect(cron.cron.hours).toEqual([9, 13, 17]);
    expect([...cron.cron.daysOfWeek]).toEqual([0]);
  });

  test("day-of-month and day-of-week are OR'd when both are restricted", () => {
    const cron = parseCron("0 9 13 * 5");
    if (cron.kind !== "ok") throw new Error(cron.message);
    // Friday 2026-10-09 comes before the 13th.
    expect(nextCronOccurrence(cron.cron, "UTC", new Date("2026-10-06T00:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-09T09:00:00.000Z",
    );
    expect(nextCronOccurrence(cron.cron, "UTC", new Date("2026-10-10T00:00:00.000Z"))?.toISOString()).toBe(
      "2026-10-13T09:00:00.000Z",
    );
  });

  test("finds leap days years ahead", () => {
    const cron = parseCron("0 0 29 2 *");
    if (cron.kind !== "ok") throw new Error(cron.message);
    expect(nextCronOccurrence(cron.cron, "UTC", NOW)?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("splitRoutineRequest", () => {
  test.each([
    ["every weekday at 9am summarize open PRs", "agent", "every weekday at 9am", "summarize open PRs"],
    ["remind me tomorrow at 3pm to deploy", "reminder", "tomorrow at 3pm", "deploy"],
    ["remind me to deploy tomorrow at 3pm", "reminder", "tomorrow at 3pm", "deploy"],
    ["Remind us in 2 hours that the build is ready", "reminder", "in 2 hours", "the build is ready"],
    ["<@U0BOT> every monday and thursday at 10am: triage new issues", "agent", "every monday and thursday at 10am", "triage new issues"],
    ["every 15 minutes, check the deploy status", "agent", "every 15 minutes", "check the deploy status"],
    ["cron: 0 9 * * 1-5 run the nightly report", "agent", "cron: 0 9 * * 1-5", "run the nightly report"],
    ["please summarize open PRs every day at 9am", "agent", "every day at 9am", "summarize open PRs"],
    ["on friday at 10 - write the weekly update", "agent", "on friday at 10", "write the weekly update"],
    ["every month on the 1st at 9am rotate the API keys", "agent", "every month on the 1st at 9am", "rotate the API keys"],
  ])("%s", (text, scheduleKind, timing, task) => {
    expect(splitRoutineRequest(text)).toEqual({ kind: "ok", scheduleKind, timing, task } as never);
  });

  test("errors without timing or without a task", () => {
    expect(splitRoutineRequest("summarize open PRs")).toEqual({ kind: "error", message: GENERIC_PARSE_ERROR });
    expect(splitRoutineRequest("remind me tomorrow at 3pm")).toEqual({
      kind: "error",
      message: "What should I remind you about? Try 'remind me tomorrow at 3pm to deploy'.",
    });
    expect(splitRoutineRequest("every weekday at 9am")).toMatchObject({ kind: "error" });
  });
});

describe("scheduler spec conversion", () => {
  test("parseRoutineRequest produces a spec the scheduler accepts", () => {
    const recurring = parseRoutineRequest("every weekday at 9am summarize open PRs", ist);
    if (recurring.kind !== "ok") throw new Error(recurring.message);
    expect(recurring.spec).toEqual({
      kind: "agent",
      prompt: "summarize open PRs",
      runAt: "2026-10-07T03:30:00.000Z",
      recurrence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: KOLKATA },
      missedRunPolicy: "skip",
      misfireGraceSeconds: 300,
      overlapPolicy: "skip",
    });
    expect(scheduleSpecSchema.safeParse(recurring.spec).success).toBe(true);

    const reminder = parseRoutineRequest("remind me tomorrow at 3pm to deploy", ny);
    if (reminder.kind !== "ok") throw new Error(reminder.message);
    expect(reminder.spec).toEqual({
      kind: "reminder",
      prompt: "deploy",
      runAt: "2026-10-07T19:00:00.000Z",
      missedRunPolicy: "run-once",
      misfireGraceSeconds: 300,
      overlapPolicy: "skip",
    });
    expect(scheduleSpecSchema.safeParse(reminder.spec).success).toBe(true);

    const interval = ok(parseSchedule("every 15 minutes", ny));
    const spec = toScheduleSpec(interval.schedule, { kind: "agent", prompt: "poll", overlapPolicy: "queue" });
    expect(spec).toMatchObject({ cadenceSeconds: 900, overlapPolicy: "queue", missedRunPolicy: "skip" });
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(true);
  });

  test("parseRoutineRequest surfaces timing errors", () => {
    expect(parseRoutineRequest("every 2 minutes ping me", ny)).toEqual({
      kind: "error",
      message: "That's too frequent. Routines can repeat at most every 5 minutes.",
    });
  });

  test("spec schema rejects cadence combined with recurrence and bad recurrences", () => {
    const base = {
      kind: "agent",
      prompt: "x",
      runAt: "2026-10-07T13:00:00.000Z",
      missedRunPolicy: "skip",
      misfireGraceSeconds: 0,
      overlapPolicy: "skip",
    };
    const recurrence = { kind: "cron", expression: "0 9 * * *", timeZone: NEW_YORK };
    expect(scheduleSpecSchema.safeParse({ ...base, recurrence }).success).toBe(true);
    expect(scheduleSpecSchema.safeParse({ ...base, recurrence, cadenceSeconds: 60 }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ ...base, recurrence: { ...recurrence, expression: "0 9 * *" } }).success).toBe(false);
    expect(scheduleSpecSchema.safeParse({ ...base, recurrence: { ...recurrence, timeZone: "Nope/Zone" } }).success).toBe(false);
  });
});

describe("review regressions", () => {
  test.each([
    "in 99999999999999999m",
    "in 9999999999999h",
    "in 9999 hours",
    "in 367 days",
    "in 366 days and 1 minute",
    "in 53 weeks",
  ])("rejects out-of-range relative offset %s without throwing", (text) => {
    expect(() => parseSchedule(text, ny)).not.toThrow();
    expect(parseSchedule(text, ny).kind).toBe("error");
  });

  test("relative offsets up to a year are still accepted", () => {
    expect(runAt("in 366 days", ny)).toBe("2027-10-07T14:00:00.000Z");
    expect(runAt("in 8784 hours", ny)).toBe("2027-10-07T14:00:00.000Z");
  });

  test("huge compact values in a routine request return an error", () => {
    expect(() => parseRoutineRequest("remind me in 99999999999999m to x", ny)).not.toThrow();
    expect(parseRoutineRequest("remind me in 99999999999999m to x", ny).kind).toBe("error");
    expect(parseSchedule("every 99999999999999999m", ny).kind).toBe("error");
  });

  test.each([
    ["every weekday post the standup at 9:30am", "every weekday at 9:30am", "post the standup", "30 9 * * 1-5"],
    ["every monday send the report at 5pm", "every monday at 5pm", "send the report", "0 17 * * 1"],
    ["every monday send the report 5:15pm", "every monday 5:15pm", "send the report", "15 17 * * 1"],
  ])("merges a trailing clock time into a leading day: %s", (text, timing, task, expression) => {
    expect(splitRoutineRequest(text)).toEqual({ kind: "ok", scheduleKind: "agent", timing, task });
    const parsed = parseRoutineRequest(text, ny);
    if (parsed.kind !== "ok") throw new Error(parsed.message);
    expect(parsed.spec.recurrence).toEqual({ kind: "cron", expression, timeZone: NEW_YORK });
  });

  test("trailing time merges into a leading one-shot day", () => {
    const parsed = parseRoutineRequest("tomorrow deploy the app at 3pm", ny);
    if (parsed.kind !== "ok") throw new Error(parsed.message);
    expect(parsed.task).toBe("deploy the app");
    expect(parsed.nextRunAt).toBe("2026-10-07T19:00:00.000Z");
  });

  test.each([
    ["tonight at midnight", "2026-10-07T04:00:00.000Z"],
    ["tonight at 12am", "2026-10-07T04:00:00.000Z"],
    ["tonight at 12", "2026-10-07T04:00:00.000Z"],
    ["tonight at 12:30", "2026-10-07T04:30:00.000Z"],
    ["tonight at 1am", "2026-10-07T05:00:00.000Z"],
    ["tonight at 11pm", "2026-10-07T03:00:00.000Z"],
    ["tonight", "2026-10-07T00:00:00.000Z"],
  ])("%s rolls into the coming night", (text, expected) => {
    expect(runAt(text, ny)).toBe(expected);
  });

  test("trailing bare day words that complete the task are not taken as timing", () => {
    expect(splitRoutineRequest("remind me to prepare for monday")).toEqual({ kind: "error", message: GENERIC_PARSE_ERROR });
    expect(splitRoutineRequest("remind me to check on sat")).toEqual({ kind: "error", message: GENERIC_PARSE_ERROR });
    expect(splitRoutineRequest("remind me to prepare for monday at 9am")).toEqual({
      kind: "ok",
      scheduleKind: "reminder",
      timing: "at 9am",
      task: "prepare for monday",
    });
    expect(splitRoutineRequest("remind me to check on sat at 5pm")).toEqual({
      kind: "ok",
      scheduleKind: "reminder",
      timing: "at 5pm",
      task: "check on sat",
    });
    expect(splitRoutineRequest("remind me to call mom on friday")).toEqual({
      kind: "ok",
      scheduleKind: "reminder",
      timing: "on friday",
      task: "call mom",
    });
  });

  test.each([
    ["every month on the 31st", "0 9 31 * *", "every month on the 31st at 9:00 AM, skipping months without a 31st (America/New_York)"],
    ["on the 30th of every month", "0 9 30 * *", "every month on the 30th at 9:00 AM, skipping months without a 30th (America/New_York)"],
    ["every month on the 28th", "0 9 28 * *", "every month on the 28th at 9:00 AM (America/New_York)"],
  ])("monthly days past the 28th warn about skipped months: %s", (text, expression, humanReadable) => {
    const result = ok(parseSchedule(text, ny));
    expect(result.schedule.recurrence).toEqual({ kind: "cron", expression, timeZone: NEW_YORK });
    expect(result.humanReadable).toBe(humanReadable);
  });
});

describe("codex review regressions", () => {
  const TOO_FREQUENT = "That's too frequent. Routines can repeat at most every 5 minutes.";

  test.each([
    ["remind me tomorrow at 13pm to deploy", "at 13pm"],
    ["remind me tomorrow at 25:00 to deploy", "at 25:00"],
    ["remind me tomorrow at 9:75 to deploy", "at 9:75"],
    ["remind me tomorrow at 13 pm to deploy", "13 pm"],
    ["remind me tomorrow at 25 to deploy", "at 25"],
    ["remind me tomorrow at 24 to deploy", "at 24"],
    ["remind me tomorrow at 9:60 to deploy", "at 9:60"],
    ["remind me to deploy at 13pm tomorrow", "at 13pm"],
    ["every monday at 25:00 send the report", "at 25:00"],
    ["every monday send the report at 25:00", "at 25:00"],
  ])("malformed clock after a timing phrase is an error, not a shortened schedule: %s", (text, clause) => {
    const error = { kind: "error", message: `"${clause}" isn't a valid time. Try something like 'at 1pm' or 'at 13:00'.` };
    expect(splitRoutineRequest(text)).toEqual(error as never);
    expect(parseRoutineRequest(text, ny)).toEqual(error as never);
  });

  test("valid clock continuations are unaffected", () => {
    const parsed = parseRoutineRequest("remind me tomorrow at 13 to deploy", ny);
    if (parsed.kind !== "ok") throw new Error(parsed.message);
    expect(parsed.task).toBe("deploy");
    expect(parsed.nextRunAt).toBe("2026-10-07T17:00:00.000Z");
  });

  test.each([
    ["every 2 minutes ping me at 5pm", "every 2 minutes", TOO_FREQUENT],
    [
      "every 3 days check backups at 5pm",
      "every 3 days",
      "Repeating every 3 days isn't supported yet. Try 'every day at 9am' or 'every monday at 9am'.",
    ],
  ])("an invalid leading schedule reports its error instead of using a trailing time: %s", (text, timing, message) => {
    expect(splitRoutineRequest(text)).toMatchObject({ kind: "ok", timing });
    expect(parseRoutineRequest(text, ny)).toEqual({ kind: "error", message });
  });

  test("offsetTransitions finds both New York DST changes in the next year", () => {
    const transitions = offsetTransitions(NEW_YORK, NOW, new Date(NOW.getTime() + 366 * 86_400_000));
    expect(transitions.map(({ at, deltaMs }) => [at.toISOString(), deltaMs])).toEqual([
      ["2026-11-01T06:00:00.000Z", -3_600_000],
      ["2027-03-14T07:00:00.000Z", 3_600_000],
    ]);
    expect(offsetTransitions(KOLKATA, NOW, new Date(NOW.getTime() + 366 * 86_400_000))).toEqual([]);
  });

  test("cron spacing accounts for a DST change months after creation", () => {
    // 01:58 EST and 03:00 EDT on 2027-03-14 are only 2 minutes apart.
    const cron = parseCron("0,58 1,3 * * *");
    if (cron.kind !== "ok") throw new Error(cron.message);
    const before = nextCronOccurrence(cron.cron, NEW_YORK, new Date("2027-03-14T06:00:00.000Z"));
    expect(before?.toISOString()).toBe("2027-03-14T06:58:00.000Z");
    expect(nextCronOccurrence(cron.cron, NEW_YORK, before as Date)?.toISOString()).toBe("2027-03-14T07:00:00.000Z");

    expect(errorOf(parseSchedule("cron: 0,58 1,3 * * *", ny))).toBe(TOO_FREQUENT);
    expect(errorOf(parseSchedule("cron: 0,59 1,3 * * *", ny))).toBe(TOO_FREQUENT);
    // No DST in Kolkata.
    expect(parseSchedule("cron: 0,58 1,3 * * *", ist).kind).toBe("ok");
    expect(parseSchedule("cron: */5 * * * *", ny).kind).toBe("ok");
  });

  test.each([
    ["cron: 0,10,20,30,40,58 0,2,4,6,8,10,20,21 * * *", TOO_FREQUENT], // 20:58 -> 21:00, late in the day
    ["cron: 0,58 0,23 * * *", TOO_FREQUENT], // 23:58 -> 00:00 the next day
  ])("cron wall-clock spacing is checked independent of creation time: %s", (text, message) => {
    expect(errorOf(parseSchedule(text, ny))).toBe(message);
    expect(errorOf(parseSchedule(text, ist))).toBe(message);
  });

  test("midnight wrap only counts when consecutive days both run", () => {
    expect(parseSchedule("cron: 0,58 0,23 * * 1", ny).kind).toBe("ok");
  });

  test("DST spacing is date independent: a March 13th-only cron meets DST on 2033-03-13", () => {
    const cron = parseCron("0,58 1,3 13 3 *");
    if (cron.kind !== "ok") throw new Error(cron.message);
    const before = nextCronOccurrence(cron.cron, NEW_YORK, new Date("2033-03-13T06:30:00.000Z"));
    expect(before?.toISOString()).toBe("2033-03-13T06:58:00.000Z");
    expect(nextCronOccurrence(cron.cron, NEW_YORK, before as Date)?.toISOString()).toBe("2033-03-13T07:00:00.000Z");
    expect(errorOf(parseSchedule("cron: 0,58 1,3 13 3 *", ny))).toBe(TOO_FREQUENT);
    // Day/month restrictions are ignored on purpose: any date could be a DST day.
    expect(errorOf(parseSchedule("cron: 0,58 1,3 * 6 *", ny))).toBe(TOO_FREQUENT);
  });

  test.each(["cron: 0 9,10 * * *", "cron: 0 1,3 * * *", "cron: 30 1,2 * * *", "every day at 2:30am", "cron: 30,58 1,2 * * *"])(
    "ordinary schedules across New York DST are still accepted: %s",
    (text) => {
      expect(parseSchedule(text, ny).kind).toBe("ok");
    },
  );

  test("the transition's size matters: Lord Howe's 30 minute shift compresses 01:58 -> 02:30", () => {
    const lordHowe: ParseScheduleOptions = { now: NOW, timeZone: "Australia/Lord_Howe" };
    expect(errorOf(parseSchedule("cron: 30,58 1,2 * * *", lordHowe))).toBe(TOO_FREQUENT);
    expect(parseSchedule("cron: 0 1,3 * * *", lordHowe).kind).toBe("ok");
  });
});
