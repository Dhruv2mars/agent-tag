import { describe, expect, test } from "bun:test";

import {
  describeSchedule,
  oneLine,
  promptPreview,
  reminderText,
  shortScheduleId,
  slackDateToken,
  type DescribableSchedule,
} from "../src/routines/describe.ts";

const base: DescribableSchedule = {
  humanReadable: null,
  recurrence: null,
  cadenceSeconds: null,
  nextRunAt: "2026-10-10T09:30:00.000Z",
  timeZone: null,
};

describe("ids, dates and previews", () => {
  test("shortScheduleId is the first six hex characters", () => {
    expect(shortScheduleId("A1B2C3D4-0000-4000-8000-000000000000")).toBe("a1b2c3");
    expect(shortScheduleId("a1-b2-c3d4")).toBe("a1b2c3");
  });

  test("slackDateToken renders in the viewer's zone with an ISO fallback", () => {
    expect(slackDateToken("2026-10-10T09:30:00.000Z")).toBe(
      "<!date^1791624600^{date_short_pretty} at {time}|2026-10-10T09:30:00.000Z>",
    );
  });

  test("oneLine collapses whitespace and truncates with an ellipsis", () => {
    expect(oneLine("  a\n\tb  c ", 10)).toBe("a b c");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });

  test("promptPreview is inert inside bold text", () => {
    expect(promptPreview("ping <!channel> and <@U2> about *this*")).toBe("ping @​channel and @​U2 about this");
    expect(promptPreview("x".repeat(400))).toHaveLength(150);
  });
});

describe("describeSchedule", () => {
  test("prefers the parser's stored description", () => {
    expect(describeSchedule({ ...base, humanReadable: "every weekday at 9:00 AM (America/New_York)" })).toBe(
      "every weekday at 9:00 AM (America/New_York)",
    );
    expect(describeSchedule({ ...base, humanReadable: "at <!here> & co" })).toBe("at @​here &amp; co");
  });

  test("falls back to cron, cadence, then the one-shot time", () => {
    expect(
      describeSchedule({
        ...base,
        humanReadable: "  ",
        recurrence: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/London" },
      }),
    ).toBe("on cron schedule `0 9 * * 1-5` (Europe/London)");
    expect(describeSchedule({ ...base, cadenceSeconds: 3_600 })).toBe("every hour");
    expect(describeSchedule({ ...base, cadenceSeconds: 900 })).toBe("every 15 minutes");
    expect(describeSchedule({ ...base, cadenceSeconds: 90 })).toBe("every 90 seconds");
    expect(describeSchedule({ ...base, timeZone: "Asia/Kolkata" })).toBe(
      "once on Sat, Oct 10, 2026 at 3:00 PM (Asia/Kolkata)",
    );
    expect(describeSchedule(base)).toBe(`once on ${slackDateToken(base.nextRunAt)}`);
    expect(describeSchedule({ ...base, timeZone: "Bad/Zone" })).toBe(`once on ${slackDateToken(base.nextRunAt)}`);
  });
});

describe("reminderText", () => {
  test("mentions only the notify user, never broadcasts", () => {
    expect(reminderText({ prompt: "deploy", notifyUserId: "U2" })).toBe("<@U2> :alarm_clock: Reminder: deploy");
    expect(reminderText({ prompt: "tell <!channel> *now*", notifyUserId: "U2" })).toBe(
      "<@U2> :alarm_clock: Reminder: tell @​channel *now*",
    );
  });

  test("delivers the full prompt, not a lossy preview", () => {
    const prompt = `delete *.log files\nthen ${"x".repeat(300)}`;
    expect(reminderText({ prompt, notifyUserId: "U2" })).toBe(`<@U2> :alarm_clock: Reminder: ${prompt}`);
  });

  test("keeps the plain form without a valid notify user", () => {
    expect(reminderText({ prompt: " review the release ", notifyUserId: null })).toBe("Reminder: review the release");
    expect(reminderText({ prompt: "x", notifyUserId: "!channel" })).toBe("Reminder: x");
    expect(reminderText({ prompt: "<!here> x", notifyUserId: null })).toBe("Reminder: @​here x");
  });
});
