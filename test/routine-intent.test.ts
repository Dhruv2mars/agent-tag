import { describe, expect, test } from "bun:test";

import { detectRoutineIntent, type RoutineIntent } from "../src/routines/intent.ts";

describe("detectRoutineIntent: create", () => {
  test.each([
    // Recurring leads whose timing parses.
    ["every weekday at 9am summarize open PRs", "recurring"],
    ["<@U0BOT> every weekday at 9am summarize open PRs", "recurring"],
    ["please every day at 9am check CI", "recurring"],
    ["please, every day at 9am check CI", "recurring"],
    ["Please, remind me tomorrow at 3pm to deploy", "reminder"],
    ["every day at 9am (PT) check CI", "recurring"],
    ["Every Monday at 10am: triage new issues", "recurring"],
    ["each morning at 8 post the weather", "recurring"],
    ["daily at 9am summarize PRs", "recurring"],
    ["daily: summarize PRs", "recurring"],
    ["weekly on friday at 4pm write the update", "recurring"],
    ["monthly on the 1st at 9am send the invoice", "recurring"],
    ["hourly, check the deploy status", "recurring"],
    ["weekdays at 9am post standup", "recurring"],
    ["every 15 minutes check the deploy status", "recurring"],
    ["every weekday at 9am PT summarize open PRs", "recurring"],
    ["every day at 9am in Europe/London check CI", "recurring"],
    // Too frequent still counts as a request: the create path explains the limit.
    ["every 2 minutes check CI", "recurring"],
    // Explicit leads.
    ["schedule tomorrow at 3pm: run the release checklist", "schedule"],
    ["Schedule every day at 9 ET check CI", "schedule"],
    ["routine: every monday at 10am post the digest", "schedule"],
    ["cron: 0 9 * * 1-5 summarize", "cron"],
    ["remind me tomorrow at 3pm to deploy", "reminder"],
    ["remind me to deploy tomorrow at 3pm", "reminder"],
    ["remind <@U2> at 5pm to file the report", "reminder"],
    ["remind the team every friday at 4pm to fill in timesheets", "reminder"],
    ["Remind us in 2 hours that the build is ready", "reminder"],
    ["set a reminder: tomorrow at 9am stand up", "reminder"],
    ["reminder: in 30 minutes check the oven", "reminder"],
    // A misspelled zone is still a scheduling request; the create path reports it.
    ["remind me at 3pm in Europe/Lndon to deploy", "reminder"],
  ])("%s", (text, lead) => {
    expect(detectRoutineIntent(text)).toEqual({ kind: "create", lead } as RoutineIntent);
  });
});

describe("detectRoutineIntent: list", () => {
  test.each([
    "list routines",
    "List the routines",
    "show routines",
    "show me the reminders in this channel",
    "what are the routines here?",
    "what's scheduled jobs",
    "whats the reminders",
    "list scheduled tasks",
    "please list my schedules",
    "<@U0BOT> list routines",
    "!routines",
    "routines",
    "reminders?",
  ])("%s", (text) => {
    expect(detectRoutineIntent(text)).toEqual({ kind: "list" });
  });
});

describe("detectRoutineIntent: cancel", () => {
  test.each<[string, RoutineIntent]>([
    ["cancel routine a1b2c3", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3" } }],
    ["cancel routine A1B2C3D4", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3d4" } }],
    ["turn off reminder `a1b2c3`", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3" } }],
    ["cancel routine with id a1b2c3-d4", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3d4" } }],
    ["cancel routine 2", { kind: "cancel", ref: { kind: "index", index: 2 } }],
    ["cancel routine 100", { kind: "cancel", ref: { kind: "index", index: 100 } }],
    ["cancel routine #10000", { kind: "cancel", ref: { kind: "index", index: 10_000 } }],
    ["cancel routine `a1b2c3`.", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3" } }],
    ["cancel routine \"a1b2c3\"!", { kind: "cancel", ref: { kind: "id", prefix: "a1b2c3" } }],
    ["stop routine #3", { kind: "cancel", ref: { kind: "index", index: 3 } }],
    ["delete the reminder number 12", { kind: "cancel", ref: { kind: "index", index: 12 } }],
    ["cancel this routine", { kind: "cancel", ref: { kind: "only" } }],
    ["cancel the routine", { kind: "cancel", ref: { kind: "only" } }],
    ["stop the routine.", { kind: "cancel", ref: { kind: "only" } }],
    ["unschedule it", { kind: "none" }],
    ["unschedule routine", { kind: "cancel", ref: { kind: "only" } }],
    ["disable the schedule here", { kind: "cancel", ref: { kind: "only" } }],
    ["cancel the reminder about deploys", { kind: "cancel", ref: { kind: "text", text: "deploys" } }],
    ["remove the scheduled job called \"nightly report\"", { kind: "cancel", ref: { kind: "text", text: "nightly report" } }],
    ["please cancel my reminder: standup notes", { kind: "cancel", ref: { kind: "text", text: "standup notes" } }],
  ])("%s", (text, intent) => {
    expect(detectRoutineIntent(text)).toEqual(intent);
  });
});

describe("detectRoutineIntent: normal prompts stay normal", () => {
  test.each([
    "",
    "   ",
    "<@U0BOT>",
    "schedule",
    "fix the cron job that runs every day at 9",
    "why did the reminder fail",
    "every test is failing",
    "every build fails at 3am",
    "every build fails every day at 9am",
    "every week the build breaks at 9am",
    "every day check CI at 9am",
    "remind me how DST differs in Europe/London and in America/New_York",
    "remind me what Europe/Lndon means",
    "daily standup notes are wrong",
    "hourly backups failed last night",
    "each of these files needs a header",
    "remind me how the deploy script works",
    "what's the schedule for the release?",
    "list the failing tests",
    "show me the code that handles reminders",
    "list the tests for routines",
    "what is the module that sends reminders",
    "show the slow routines",
    "show me the routines module in src",
    "stop the build",
    "cancel the deploy",
    "summarize open PRs every day at 9am",
    "tomorrow at 3pm run the release checklist",
    "weekly report is broken",
  ])("%j", (text) => {
    expect(detectRoutineIntent(text)).toEqual({ kind: "none" });
  });
});
