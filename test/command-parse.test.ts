import { describe, expect, test } from "bun:test";

import {
  AGENT_COMMANDS,
  type CommandUsage,
  IMPLEMENTED_COMMANDS,
  isCommandUsage,
  MAX_REMEMBER_CHARS,
  type ParsedAgentCommand,
  parseAgentCommand,
} from "../src/commands/parse.ts";

const BOT = "U0BOT";

type Expected = ParsedAgentCommand | CommandUsage | null;

interface ParseCase {
  readonly text: string;
  readonly allowBare?: boolean;
  readonly expected: Expected;
}

const LONG_OK = "x".repeat(MAX_REMEMBER_CHARS);
const LONG_TOO_LONG = "x".repeat(MAX_REMEMBER_CHARS + 1);

const CASES: ReadonlyArray<ParseCase> = [
  // Standalone commands: bare mention form, case and whitespace, and extra words.
  { text: "<@U0BOT> !status", expected: { name: "status" } },
  { text: "<@U0BOT>  !STATUS ", expected: { name: "status" } },
  { text: "<@U0BOT> !status please", expected: null },
  { text: "<@U0BOT> !help", expected: { name: "help" } },
  { text: "<@U0BOT> !help please", expected: null },
  { text: "<@U0BOT> !restart", expected: { name: "restart" } },
  { text: "<@U0BOT> !restart now", expected: null },
  { text: "<@U0BOT> !stop", expected: { name: "stop" } },
  { text: "<@U0BOT> !stop now", expected: null },
  { text: "<@U0BOT> !mute", expected: { name: "mute" } },
  { text: "<@U0BOT> !mute now", expected: null },
  { text: "<@U0BOT> !unmute", expected: { name: "unmute" } },
  { text: "<@U0BOT> !unmute now", expected: null },
  { text: "<@U0BOT> !memory", expected: { name: "memory" } },
  { text: "<@U0BOT> !memory now", expected: null },

  // Mention placement and separators.
  { text: "hey <@U0BOT> !status", expected: null },
  { text: "!status", allowBare: false, expected: null },
  { text: "!status", allowBare: true, expected: { name: "status" } },
  { text: "<@U0BOT|agent> !help", expected: { name: "help" } },
  { text: "<@U0BOT>!help", expected: null },
  { text: "<@U0BOT>", expected: null },
  { text: "<@U0BOT>", allowBare: true, expected: null },
  { text: "<@U0OTHER> !help", expected: null },
  { text: "<@U0OTHER> !help", allowBare: true, expected: null },
  { text: "<@U0BOTX> !help", expected: null },
  { text: "<@U0BOT> <@U0BOT> !help", expected: null },
  { text: "<@U0BOT>\n!help", expected: { name: "help" } },
  { text: "<@U0BOT>\t!help", expected: { name: "help" } },
  { text: "  <@U0BOT> !help  \n", expected: { name: "help" } },
  { text: "\n\t<@U0BOT> !status\n", expected: { name: "status" } },
  { text: "  !help ", allowBare: true, expected: { name: "help" } },
  { text: "<@U0BOT> !help", allowBare: true, expected: { name: "help" } },
  { text: "<@U0BOT> hi", expected: null },

  // model
  { text: "<@U0BOT> !model", expected: { name: "model", action: { kind: "show" } } },
  { text: "!model", allowBare: true, expected: { name: "model", action: { kind: "show" } } },
  { text: "<@U0BOT> !model list", expected: { name: "model", action: { kind: "list" } } },
  { text: "<@U0BOT> !MODEL LIST", expected: { name: "model", action: { kind: "list" } } },
  { text: "<@U0BOT> !model reset", expected: { name: "model", action: { kind: "reset" } } },
  { text: "<@U0BOT> !model RESET", expected: { name: "model", action: { kind: "reset" } } },
  { text: "<@U0BOT> !model default", expected: { name: "model", action: { kind: "reset" } } },
  { text: "<@U0BOT> !model Default", expected: { name: "model", action: { kind: "reset" } } },
  { text: "<@U0BOT> !model Opus", expected: { name: "model", action: { kind: "set", query: "Opus" } } },
  {
    text: "<@U0BOT> !model codex/gpt-5.6-sol",
    expected: { name: "model", action: { kind: "set", query: "codex/gpt-5.6-sol" } },
  },
  { text: "<@U0BOT> !model a b", expected: null },
  { text: "<@U0BOT> !model list extra", expected: null },

  // routines
  { text: "<@U0BOT> !routines", expected: { name: "routines", action: { kind: "list", channelId: null } } },
  {
    text: "<@U0BOT> !routines <#C123ABC|eng>",
    expected: { name: "routines", action: { kind: "list", channelId: "C123ABC" } },
  },
  { text: "<@U0BOT> !routines <#C123ABC>", expected: { name: "routines", action: { kind: "list", channelId: "C123ABC" } } },
  { text: "<@U0BOT> !routines G1234567", expected: { name: "routines", action: { kind: "list", channelId: "G1234567" } } },
  { text: "<@U0BOT> !routines C12", expected: { name: "routines", usage: true } },
  { text: "<@U0BOT> !routines foo", expected: { name: "routines", usage: true } },
  { text: "<@U0BOT> !routines cancel", expected: { name: "routines", usage: true } },
  { text: "<@U0BOT> !routines cancel r-1", expected: { name: "routines", action: { kind: "cancel", ref: "r-1" } } },
  { text: "<@U0BOT> !routines CANCEL r-1", expected: { name: "routines", action: { kind: "cancel", ref: "r-1" } } },
  { text: "<@U0BOT> !routines cancel r-1 x", expected: null },
  { text: "<@U0BOT> !routines foo bar", expected: null },

  // remember
  { text: "<@U0BOT> !remember", expected: { name: "remember", usage: true } },
  { text: "!remember", allowBare: true, expected: { name: "remember", usage: true } },
  {
    text: "<@U0BOT> !remember workspace: x",
    expected: { name: "remember", scope: "workspace", content: "x" },
  },
  { text: "<@U0BOT> !remember WORKSPACE: x", expected: { name: "remember", scope: "workspace", content: "x" } },
  { text: "<@U0BOT> !remember workspace:x", expected: { name: "remember", scope: "workspace", content: "x" } },
  { text: "<@U0BOT> !remember thread: x", expected: { name: "remember", scope: "thread", content: "x" } },
  { text: "<@U0BOT> !remember channel: x", expected: { name: "remember", scope: "channel", content: "x" } },
  { text: "<@U0BOT> !remember here: x", expected: { name: "remember", scope: "channel", content: "x" } },
  { text: "<@U0BOT> !remember thread:", expected: { name: "remember", usage: true } },
  { text: "<@U0BOT> !remember workspace:   ", expected: { name: "remember", usage: true } },
  { text: "<@U0BOT> !remember here:", expected: { name: "remember", usage: true } },
  {
    text: "<@U0BOT> !remember ping <@U123> about <#C999|x>",
    expected: { name: "remember", scope: "default", content: "ping <@U123> about <#C999|x>" },
  },
  { text: "<@U0BOT> !remember a  b   c", expected: { name: "remember", scope: "default", content: "a  b   c" } },
  { text: "<@U0BOT> !remember remember this", expected: { name: "remember", scope: "default", content: "remember this" } },
  { text: "<@U0BOT> !remember nothread: x", expected: { name: "remember", scope: "default", content: "nothread: x" } },
  { text: `<@U0BOT> !remember ${LONG_OK}`, expected: { name: "remember", scope: "default", content: LONG_OK } },
  { text: `<@U0BOT> !remember ${LONG_TOO_LONG}`, expected: { name: "remember", usage: true, tooLong: true } },

  // forget
  { text: "<@U0BOT> !forget", expected: { name: "forget", usage: true } },
  { text: "<@U0BOT> !forget r-1", expected: { name: "forget", ref: "r-1" } },
  { text: "<@U0BOT> !forget r-1 r-2", expected: null },

  // Unknown or out-of-scope commands, and non-command text.
  { text: "<@U0BOT> !fork x", expected: null },
  { text: "<@U0BOT> !configure", expected: null },
  { text: "<@U0BOT> !fast", expected: null },
  { text: "<@U0BOT> !feedback hi", expected: null },
  { text: "<@U0BOT> !stat", expected: null },
  { text: "<@U0BOT> !help2", expected: null },
  { text: "<@U0BOT> !", expected: null },
  { text: "<@U0BOT> !!help", expected: null },
  { text: "<@U0BOT> ! help", expected: null },
  { text: "!fork x", allowBare: true, expected: null },
  { text: "!configure", allowBare: true, expected: null },
  { text: "!stat", allowBare: true, expected: null },
  { text: "!help2", allowBare: true, expected: null },
  { text: "hello there", expected: null },
  { text: "hello there", allowBare: true, expected: null },
  { text: "", expected: null },
  { text: "", allowBare: true, expected: null },
  { text: "   ", allowBare: true, expected: null },
];

describe("parseAgentCommand table", () => {
  for (const testCase of CASES) {
    const mode = testCase.allowBare === true ? "allowBare" : "mention-only";
    const title = `${mode} ${JSON.stringify(testCase.text).slice(0, 100)}`;
    test(title, () => {
      const result = parseAgentCommand(testCase.text, { botUserId: BOT, allowBare: testCase.allowBare ?? false });
      expect(result).toEqual(testCase.expected);
    });
  }
});

describe("isCommandUsage", () => {
  test("is true for usage results", () => {
    expect(isCommandUsage({ name: "remember", usage: true })).toBe(true);
    expect(isCommandUsage({ name: "remember", usage: true, tooLong: true })).toBe(true);
    expect(isCommandUsage(parseAgentCommand("<@U0BOT> !forget", { botUserId: BOT, allowBare: false })!)).toBe(true);
  });

  test("is false for parsed commands", () => {
    expect(isCommandUsage({ name: "status" })).toBe(false);
    expect(isCommandUsage({ name: "model", action: { kind: "show" } })).toBe(false);
    expect(isCommandUsage(parseAgentCommand("<@U0BOT> !forget r-1", { botUserId: BOT, allowBare: false })!)).toBe(false);
  });
});

describe("parseAgentCommand bot id validation", () => {
  test("throws for an invalid bot user id", () => {
    expect(() => parseAgentCommand("<@bad> !help", { botUserId: "bad", allowBare: false })).toThrow(
      "invalid bot user id",
    );
  });

  test("throws for a lowercase bot user id", () => {
    expect(() => parseAgentCommand("<@u0bot> !help", { botUserId: "u0bot", allowBare: false })).toThrow(
      "invalid bot user id",
    );
  });
});

describe("command registry", () => {
  test("IMPLEMENTED_COMMANDS lists the commands with handlers", () => {
    expect([...IMPLEMENTED_COMMANDS]).toEqual(["help", "status", "mute", "unmute"]);
  });

  test("every implemented command is a known agent command", () => {
    for (const name of IMPLEMENTED_COMMANDS) {
      expect(AGENT_COMMANDS).toContain(name);
    }
  });
});
