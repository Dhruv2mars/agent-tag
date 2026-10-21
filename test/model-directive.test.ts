// P2c: the plain-language model directive parser (PR-P2 §3.5, §4).
import { describe, expect, test } from "bun:test";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { allowedChoices } from "../src/policy/models.ts";
import { type ModelDirective, parseModelDirective } from "../src/slack/model-directive.ts";
import { type T3ServerInfo, t3ServerConfigSchema } from "../src/t3/gateway.ts";

const catalog: T3ServerInfo = t3ServerConfigSchema.parse(
  await Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json(),
);
const example: unknown = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

function config(): AgentTagConfig {
  const input = structuredClone(example) as Record<string, any>;
  Object.assign(input.profiles[0], {
    defaultProviderInstanceId: "codex",
    defaultModel: "gpt-5.6-sol",
    allowedModels: [
      { instanceId: "codex", model: "gpt-5.6-sol", label: "Sol", aliases: ["sol"] },
      { instanceId: "codex", model: "gpt-5.6-mini", label: "GPT Mini", aliases: ["mini"] },
      { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", aliases: ["opus"] },
      { instanceId: "claudeAgent", model: "claude-sonnet-5", label: "Sonnet", aliases: ["sonnet"] },
    ],
  });
  return agentTagConfigSchema.parse(input);
}

const parsed = config();
const choices = allowedChoices(parsed.profiles[0]!, parsed.routes[0]!);

/** The parse reduced to what a reader checks: kind, the chosen `instance/model`, the remainder. */
function summary(directive: ModelDirective | null): string | null {
  if (directive === null) return null;
  switch (directive.kind) {
    case "match":
      return `match ${directive.choice.instanceId}/${directive.choice.model} | ${directive.remainder}`;
    case "ambiguous":
      return `ambiguous ${directive.candidates.map((choice) => choice.model).join(",")} | ${directive.remainder}`;
    case "not-allowed":
      return `not-allowed ${directive.known === null ? "?" : `${directive.known.instanceId}/${directive.known.model}`} | ${directive.remainder}`;
  }
}

describe("parseModelDirective", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    // The spec's matching phrases.
    ["switch to opus", "match claudeAgent/claude-opus-5-5 | "],
    ["use `codex/gpt-5.6-mini`: fix x", "match codex/gpt-5.6-mini | fix x"],
    ["Use Opus 5.5 for the rest of this thread", "match claudeAgent/claude-opus-5-5 | "],
    ["model: sonnet", "match claudeAgent/claude-sonnet-5 | "],
    // Verb forms, "please", case and spacing.
    ["please switch to mini", "match codex/gpt-5.6-mini | "],
    ["change the model to sonnet", "match claudeAgent/claude-sonnet-5 | "],
    ["Switch the model to Opus", "match claudeAgent/claude-opus-5-5 | "],
    ["change to sol", "match codex/gpt-5.6-sol | "],
    ["USE OPUS", "match claudeAgent/claude-opus-5-5 | "],
    ["Model:opus", "match claudeAgent/claude-opus-5-5 | "],
    ["use opus model", "match claudeAgent/claude-opus-5-5 | "],
    ["use sonnet for this thread", "match claudeAgent/claude-sonnet-5 | "],
    ["  use opus  ", "match claudeAgent/claude-opus-5-5 | "],
    // Names: slug, label, quoted, instance/model, bare instance.
    ["use gpt-5.6-mini", "match codex/gpt-5.6-mini | "],
    ["use GPT Mini", "match codex/gpt-5.6-mini | "],
    ["use \"Opus 5.5\": review the PR", "match claudeAgent/claude-opus-5-5 | review the PR"],
    ["use 'sonnet', then summarize", "match claudeAgent/claude-sonnet-5 | then summarize"],
    ["use claudeAgent/claude-sonnet-5", "match claudeAgent/claude-sonnet-5 | "],
    ["use claudeAgent", "ambiguous claude-opus-5-5,claude-sonnet-5 | "],
    // Where the directive ends; the rest is the request.
    ["use opus: fix the flaky test", "match claudeAgent/claude-opus-5-5 | fix the flaky test"],
    ["use opus, fix the flaky test", "match claudeAgent/claude-opus-5-5 | fix the flaky test"],
    ["use opus; fix it", "match claudeAgent/claude-opus-5-5 | fix it"],
    ["switch to opus. Then fix it", "match claudeAgent/claude-opus-5-5 | Then fix it"],
    ["use opus — fix it", "match claudeAgent/claude-opus-5-5 | fix it"],
    ["use opus\nfix the bug\nand add a test", "match claudeAgent/claude-opus-5-5 | fix the bug\nand add a test"],
    ["Use Opus 5.5 for the rest of this thread: refactor x", "match claudeAgent/claude-opus-5-5 | refactor x"],
    ["use opus... fix it", "match claudeAgent/claude-opus-5-5 | fix it"],
    ["use opus: ...", "match claudeAgent/claude-opus-5-5 | "],
    ["use opus: .env is broken", "match claudeAgent/claude-opus-5-5 | .env is broken"],
    ["use opus: ./x fails", "match claudeAgent/claude-opus-5-5 | ./x fails"],
    ["use opus\n.github/ci.yml fails", "match claudeAgent/claude-opus-5-5 | .github/ci.yml fails"],
    // A catalog model the profile does not allow is refused, not run as a prompt.
    ["switch to grok-5", "not-allowed grok/grok-5 | "],
    ["use codex-work/gpt-5.6-sol: x", "not-allowed codex-work/gpt-5.6-sol | x"],
    // Ordinary prompts stay prompts.
    ["use the README to fix the install docs", null],
    ["switch to dark mode", null],
    ["please use tabs", null],
    ["use opus to fix the bug", null],
    ["use opus and sonnet together", null],
    ["I'd use opus here", null],
    ["can you switch to opus?", null],
    ["use", null],
    ["use ``: x", null],
    ["model:", null],
    ["modeling: write the doc", null],
    ["use grok-5 to write it", null],
    ["use `opus\nnow`", null],
    ["switch to sonnet-ish", null],
    ["", null],
  ];
  test(`covers at least 40 cases (${cases.length})`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(summary(parseModelDirective(input, choices, catalog))).toBe(expected);
    });
  }

  test("without a catalog a model outside the allowlist stays a prompt", () => {
    expect(parseModelDirective("switch to grok-5", choices, null)).toBeNull();
    expect(summary(parseModelDirective("switch to opus", choices, null))).toBe("match claudeAgent/claude-opus-5-5 | ");
  });

  test("a catalog slug served by several instances is not allowed with no single target", () => {
    const sol = choices.filter((choice) => choice.model !== "gpt-5.6-sol");
    expect(summary(parseModelDirective("use gpt-5.6-sol", sol, catalog))).toBe("not-allowed ? | ");
  });

  test("the longest allowed name wins over a shorter one", () => {
    const withShort = [...choices, { ...choices[2]!, model: "opus-x", label: "Opus", aliases: [] }];
    expect(summary(parseModelDirective("use Opus 5.5", withShort, catalog))).toBe("match claudeAgent/claude-opus-5-5 | ");
  });
});
