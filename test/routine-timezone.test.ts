import { describe, expect, test } from "bun:test";

import {
  canonicalTimeZone,
  extractTimeZone,
  resolveRoutineSchedule,
  resolveTimeZone,
  unknownTimeZoneMessage,
} from "../src/routines/timezone.ts";
import { scheduleSpecSchema } from "../src/scheduler.ts";

// Friday 2026-10-09 12:00 UTC (08:00 EDT, 17:30 IST).
const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("extractTimeZone", () => {
  test.each([
    ["every day at 9am in Europe/London check CI", "every day at 9am check CI", "Europe/London"],
    ["every day at 9am check CI in Europe/London", "every day at 9am check CI", "Europe/London"],
    ["every day at 9am in europe/london check CI", "every day at 9am check CI", "Europe/London"],
    ["9am (America/New_York) daily check", "9am daily check", "America/New_York"],
    ["every day at 9am America/Argentina/Buenos_Aires post", "every day at 9am post", "America/Argentina/Buenos_Aires"],
    ["every day at 9am PT summarize", "every day at 9am summarize", "America/Los_Angeles"],
    ["every day at 9am pst summarize", "every day at 9am summarize", "America/Los_Angeles"],
    ["tomorrow at 09:00 CET: deploy", "tomorrow at 09:00: deploy", "Europe/Paris"],
    ["at 3pm IST remind me", "at 3pm remind me", "Asia/Kolkata"],
    ["every day at noon UTC check", "every day at noon check", "UTC"],
    ["remind me tomorrow at midday PT to deploy", "remind me tomorrow at midday to deploy", "America/Los_Angeles"],
    ["every day at NOON Europe/London check CI", "every day at NOON check CI", "Europe/London"],
    ["every day at Midnight pt check", "every day at Midnight check", "America/Los_Angeles"],
    ["every day at 9am PT, check CI", "every day at 9am, check CI", "America/Los_Angeles"],
    ["every day at 9am PT summarize\n- PRs\n-  issues", "every day at 9am summarize\n- PRs\n-  issues", "America/Los_Angeles"],
    ["every day at 9am PT run `date  --utc`", "every day at 9am run `date  --utc`", "America/Los_Angeles"],
    ["every day at midnight CET check", "every day at midnight check", "Europe/Paris"],
    ["at 9 in utc every day check", "at 9 every day check", "UTC"],
    ["every day at 9am GMT check", "every day at 9am check", "UTC"],
    ["every day at 9am (GMT) check", "every day at 9am check", "UTC"],
    ["every day at 9am ET and 5pm ET check", "every day at 9am and 5pm check", "America/New_York"],
    ["every day at 9am (PT) check CI", "every day at 9am check CI", "America/Los_Angeles"],
    ["every day at 9am et check CI", "every day at 9am check CI", "America/New_York"],
    // Zones in the task text stay there; only the timing's zone counts.
    ["every day at 9am ET check the 10am PT incident", "every day at 9am check the 10am PT incident", "America/New_York"],
    ["check the 10am PT incident every day at 9am ET", "check the 10am PT incident every day at 9am", "America/New_York"],
    ["remind me every day at 9am ET to check the 10am PT incident", "remind me every day at 9am to check the 10am PT incident", "America/New_York"],
    ["schedule tomorrow at 9am PT: review the noon UTC report", "schedule tomorrow at 9am: review the noon UTC report", "America/Los_Angeles"],
  ])("%s", (input, text, explicit) => {
    expect(extractTimeZone(input)).toEqual({ kind: "ok", text, explicit });
  });

  test.each([
    "fix the ET bug every day at 9am",
    "every day at 9am summarize PT tickets",
    "edit src/app every day at 9am",
    "every day at 9am in Mars/Olympus check",
    "every day at 9am check us/eu traffic",
    "post IST updates daily at 9am",
    'every day at 9am run `date --date="9am UTC"`',
    "every day at 9am:\n```\necho 9am in Europe/London\n```",
    "every day at 9am check `noon PT` handling",
    "every day at 9am check the 10am PT incident",
    "every day at 9am check the 9am PT incident",
    "every day at 9am review the noon UTC report",
    "every day at 9am compare 9am ET with 9am PT",
    "remind me every day at 9am to check the 10am PT incident",
    "routine: every day at 9am check the 10am PT incident",
    "schedule tomorrow at 9am: review the noon UTC report",
  ])("keeps %j as task text", (input) => {
    expect(extractTimeZone(input)).toEqual({ kind: "ok", text: input });
  });

  test("rejects an unknown IANA-looking zone", () => {
    expect(extractTimeZone("every day at 9am in Europe/Lndon check")).toEqual({
      kind: "error",
      message: "I don't know the time zone `Europe/Lndon`. Use a name like America/New_York.",
      token: "Europe/Lndon",
    });
    expect(unknownTimeZoneMessage("a`b")).toContain("`a'b`");
  });

  test("rejects two different zones", () => {
    expect(extractTimeZone("every day at 9am PT and 10am ET check")).toMatchObject({
      kind: "error",
      message: "That names more than one time zone (America/Los_Angeles, America/New_York). Use just one.",
    });
  });
});

describe("resolveTimeZone", () => {
  test("priority is explicit > profile > default > UTC", () => {
    expect(resolveTimeZone({ explicit: "Asia/Tokyo", profileTz: "America/New_York", fallback: "Europe/Paris" })).toEqual({
      timeZone: "Asia/Tokyo",
      source: "explicit",
    });
    expect(resolveTimeZone({ explicit: null, profileTz: "America/New_York", fallback: "Europe/Paris" })).toEqual({
      timeZone: "America/New_York",
      source: "profile",
    });
    expect(resolveTimeZone({ profileTz: null, fallback: "Europe/Paris" })).toEqual({
      timeZone: "Europe/Paris",
      source: "default",
    });
    expect(resolveTimeZone({})).toEqual({ timeZone: "UTC", source: "default" });
  });

  test("skips empty or unknown zones at every level", () => {
    expect(resolveTimeZone({ explicit: " ", profileTz: "Bad/Zone", fallback: "Europe/Paris" })).toEqual({
      timeZone: "Europe/Paris",
      source: "default",
    });
    expect(resolveTimeZone({ profileTz: "Bad/Zone", fallback: "Also/Bad" })).toEqual({ timeZone: "UTC", source: "default" });
  });

  test("canonicalizes spelling", () => {
    expect(canonicalTimeZone("europe/london")).toBe("Europe/London");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    expect(canonicalTimeZone("Mars/Base")).toBeNull();
    expect(resolveTimeZone({ profileTz: "america/new_york" })).toEqual({ timeZone: "America/New_York", source: "profile" });
  });
});

describe("resolveRoutineSchedule", () => {
  test("uses the Slack profile zone when the request names none", () => {
    const result = resolveRoutineSchedule({
      text: "every weekday at 9am summarize open PRs",
      now: NOW,
      actorUserId: "U1",
      profileTimeZone: "America/New_York",
      defaultTimeZone: "UTC",
    });
    expect(result).toMatchObject({
      kind: "ok",
      task: "summarize open PRs",
      recurring: true,
      humanReadable: "every weekday at 9:00 AM (America/New_York)",
      nextRunAt: "2026-10-09T13:00:00.000Z",
      timeZone: "America/New_York",
      timeZoneSource: "profile",
      spec: { kind: "agent", recurrence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" } },
    });
    if (result.kind !== "ok") throw new Error(result.message);
    expect(scheduleSpecSchema.parse(result.spec)).toEqual(result.spec);
    expect(result).not.toHaveProperty("notifyUserId");
  });

  test("an explicit zone beats the profile and carries the reminder target", () => {
    expect(
      resolveRoutineSchedule({
        text: "remind me tomorrow at 3pm IST to deploy",
        now: NOW,
        actorUserId: "U1",
        profileTimeZone: "America/New_York",
      }),
    ).toMatchObject({
      kind: "ok",
      task: "deploy",
      nextRunAt: "2026-10-10T09:30:00.000Z",
      humanReadable: "once on Sat, Oct 10, 2026 at 3:00 PM (Asia/Kolkata)",
      notifyUserId: "U1",
      timeZone: "Asia/Kolkata",
      timeZoneSource: "explicit",
      spec: { kind: "reminder", prompt: "deploy" },
    });
  });

  test("falls back to the default zone when the profile zone is missing or invalid", () => {
    for (const profileTimeZone of [null, "Bad/Zone"]) {
      expect(
        resolveRoutineSchedule({ text: "tomorrow at 3pm: deploy", now: NOW, profileTimeZone, defaultTimeZone: "Europe/Paris" }),
      ).toMatchObject({ kind: "ok", nextRunAt: "2026-10-10T13:00:00.000Z", timeZone: "Europe/Paris", timeZoneSource: "default" });
    }
  });

  test("parses the same normalized text the detector saw", () => {
    for (const text of ["please, remind me tomorrow at 3pm to deploy", "<@U0BOT> Please   remind me tomorrow at 3pm to deploy"]) {
      expect(resolveRoutineSchedule({ text, now: NOW, actorUserId: "U1", profileTimeZone: "America/New_York" })).toMatchObject({
        kind: "ok",
        task: "deploy",
        nextRunAt: "2026-10-10T19:00:00.000Z",
        notifyUserId: "U1",
      });
    }
    expect(resolveRoutineSchedule({ text: "please, every day at 9am check CI", now: NOW })).toMatchObject({
      kind: "ok",
      task: "check CI",
    });
  });

  test("colon leads without a space parse like the spaced forms", () => {
    expect(resolveRoutineSchedule({ text: "routine:every day at 9am check CI", now: NOW })).toMatchObject({
      kind: "ok",
      task: "check CI",
      recurring: true,
    });
    expect(resolveRoutineSchedule({ text: "cron:0 9 * * 1-5 check CI", now: NOW })).toMatchObject({
      kind: "ok",
      task: "check CI",
      spec: { recurrence: { kind: "cron", expression: "0 9 * * 1-5" } },
    });
  });

  test("a zone in the task text does not change or conflict with the schedule", () => {
    expect(
      resolveRoutineSchedule({ text: "every day at 9am ET check the 10am PT incident", now: NOW, profileTimeZone: "Asia/Tokyo" }),
    ).toMatchObject({ kind: "ok", task: "check the 10am PT incident", timeZone: "America/New_York", timeZoneSource: "explicit" });
    expect(
      resolveRoutineSchedule({ text: "every day at 9am check the 10am PT incident", now: NOW, profileTimeZone: "Asia/Tokyo" }),
    ).toMatchObject({ kind: "ok", task: "check the 10am PT incident", timeZone: "Asia/Tokyo", timeZoneSource: "profile" });
    expect(
      resolveRoutineSchedule({
        text: "remind me every day at 9am to check the 10am PT incident",
        now: NOW,
        actorUserId: "U1",
        profileTimeZone: "Asia/Tokyo",
      }),
    ).toMatchObject({ kind: "ok", task: "check the 10am PT incident", timeZone: "Asia/Tokyo", timeZoneSource: "profile" });
  });

  test("reports zone and parse errors as user-facing messages", () => {
    expect(resolveRoutineSchedule({ text: "every day at 9am in Europe/Lndon check", now: NOW })).toEqual({
      kind: "error",
      message: "I don't know the time zone `Europe/Lndon`. Use a name like America/New_York.",
    });
    expect(resolveRoutineSchedule({ text: "every 2 minutes check CI", now: NOW })).toMatchObject({
      kind: "error",
      message: expect.stringContaining("too frequent"),
    });
  });
});
