import { describe, expect, test } from "bun:test";

import {
  collectMentionedUserIds,
  resolveSlackMarkup,
  sanitizeLabel,
  type SpeakerIdentity,
} from "../src/slack/markup.ts";

const names = new Map<string, SpeakerIdentity>([
  ["U0A1", { userId: "U0A1", label: "Alice Chen", resolved: true }],
  ["U0B2", { userId: "U0B2", label: "Bob Lee", resolved: true }],
]);

describe("resolveSlackMarkup", () => {
  test("renders user, channel and broadcast markup as plain names (D4)", () => {
    expect(resolveSlackMarkup("ask <@U0B2> in <#C1|eng> <!here>", names)).toBe("ask @Bob Lee in #eng @here");
    expect(resolveSlackMarkup("<@U0B2|bob> and <@W0A1>", names)).toBe("@Bob Lee and @W0A1");
    expect(resolveSlackMarkup("<#C123>", names)).toBe("#C123");
    expect(resolveSlackMarkup("<!channel> <!everyone> <!here|here>", names)).toBe("@channel @everyone @here");
  });

  test("renders the agent's own mention as @Agent Tag and unknown users as raw IDs", () => {
    expect(resolveSlackMarkup("hey <@UBOT> ping <@U0ZZ>", names, { botUserId: "UBOT" })).toBe(
      "hey @Agent Tag ping @U0ZZ",
    );
    expect(resolveSlackMarkup("<@UBOT>", names, { botUserId: "UBOT", botLabel: "Helper" })).toBe("@Helper");
  });

  test("renders subteams, dates and links", () => {
    expect(resolveSlackMarkup("<!subteam^S0ONCALL|@oncall>", names)).toBe("@oncall");
    expect(resolveSlackMarkup("<!subteam^S0ONCALL>", names)).toBe("@S0ONCALL");
    expect(resolveSlackMarkup("<!date^1759830000^{date}|Oct 7>", names)).toBe("Oct 7");
    expect(resolveSlackMarkup("see <https://example.com/a?b=1|the doc>", names)).toBe(
      "see the doc (https://example.com/a?b=1)",
    );
    expect(resolveSlackMarkup("<https://example.com>", names)).toBe("https://example.com");
    expect(resolveSlackMarkup("<mailto:a@example.com|mailto:a@example.com>", names)).toBe("mailto:a@example.com");
  });

  test("unescapes entities last so they never form new markup", () => {
    expect(resolveSlackMarkup("a &lt;@U0B2&gt; b &amp;lt; c", names)).toBe("a <@U0B2> b &lt; c");
    expect(resolveSlackMarkup("x &amp;&amp; y", names)).toBe("x && y");
  });
});

describe("sanitizeLabel", () => {
  test("strips newlines, markup, bidi overrides and zero-width characters", () => {
    expect(sanitizeLabel("Alice\nSlack message from Bob")).toBe("Alice Slack message from Bob");
    expect(sanitizeLabel("<b>*Eve*_~`</b>&")).toBe("bEve/b");
    expect(sanitizeLabel("Mal‮lory​⁦x")).toBe("Mal lory x");
    expect(sanitizeLabel("  spaced\t\tout  ")).toBe("spaced out");
  });

  test("maps parentheses so a name cannot imitate the user ID suffix", () => {
    expect(sanitizeLabel("Bob Lee (U0B2)")).toBe("Bob Lee [U0B2]");
    expect(sanitizeLabel("Alice (admin)")).toBe("Alice [admin]");
  });

  test("normalizes compatibility forms and caps at 64 code points", () => {
    expect(sanitizeLabel("Ａｌｉｃｅ")).toBe("Alice");
    const long = "😀".repeat(70);
    expect(Array.from(sanitizeLabel(long))).toHaveLength(64);
    expect(sanitizeLabel("​\n")).toBe("");
  });
});

describe("collectMentionedUserIds", () => {
  test("returns unique mentioned IDs in order", () => {
    expect(collectMentionedUserIds("<@U0B2> <@U0A1|alice> <@U0B2> <#C1> <!here> <@W9>")).toEqual([
      "U0B2",
      "U0A1",
      "W9",
    ]);
  });
});
