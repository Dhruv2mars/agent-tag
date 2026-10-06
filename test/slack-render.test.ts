import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, approvalMessage, questionMessage, type T3CoordinatorGateway } from "../src/coordinator.ts";
import {
  escapeSlackText,
  markdownToMrkdwn,
  renderCodeBlock,
  splitForSlack,
  truncateBlockText,
} from "../src/slack/render.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3ThreadSnapshot } from "../src/t3/gateway.ts";

const ZWSP = "​";

function fenceCount(text: string): number {
  return text.split("\n").filter((line) => line.trimStart().startsWith("```")).length;
}

function assertNoControlSequences(text: string): void {
  expect(text).not.toMatch(/<!(channel|here|everyone|subteam)/i);
  expect(text).not.toMatch(/<@[A-Z0-9]/i);
  expect(text).not.toMatch(/(^|[^@​\w])@(channel|here|everyone)\b/i);
}

describe("markdownToMrkdwn", () => {
  test("converts emphasis, strike, links, headings, bullets, and rules", () => {
    const rendered = markdownToMrkdwn(
      [
        "## Summary **now**",
        "This is **bold**, __also bold__, *italic*, _italic_, and ~~gone~~.",
        "See [the docs](https://example.com/a?x=1&y=2) or <https://example.com/raw>.",
        "- first",
        "* second",
        "  + nested",
        "---",
        "> quoted *text*",
      ].join("\n"),
    );
    expect(rendered.split("\n")).toEqual([
      "*Summary now*",
      "This is *bold*, *also bold*, _italic_, _italic_, and ~gone~.",
      "See <https://example.com/a?x=1&amp;y=2|the docs> or <https://example.com/raw>.",
      "• first",
      "• second",
      "  • nested",
      "──────────",
      ">quoted _text_",
    ]);
  });

  test("leaves non-emphasis asterisks and underscores alone", () => {
    expect(markdownToMrkdwn("2*3*4 and snake_case_name and a * b")).toBe("2*3*4 and snake_case_name and a * b");
  });

  test("preserves fenced code blocks and inline code without conversion", () => {
    const markdown = [
      "Before **bold**",
      "```typescript",
      "const x = **y** && a < b; // [link](https://x.y) <!channel>",
      "- not a bullet",
      "# not a heading",
      "```",
      "Inline `**raw** <@U1>` stays.",
      "~~~",
      "```nested fence line",
      "~~~",
    ].join("\n");
    const lines = markdownToMrkdwn(markdown).split("\n");
    expect(lines).toEqual([
      "Before *bold*",
      "```",
      "const x = **y** &amp;&amp; a &lt; b; // [link](https://x.y) &lt;!channel&gt;",
      "- not a bullet",
      "# not a heading",
      "```",
      "Inline `**raw** &lt;@U1&gt;` stays.",
      "```",
      `\`\`${ZWSP}\`nested fence line`,
      "```",
    ]);
  });

  test("closes an unterminated fence and renders one-line fences as inline code", () => {
    expect(markdownToMrkdwn("```js\nopen()")).toBe("```\nopen()\n```");
    expect(markdownToMrkdwn("```a **b**```")).toBe("`a **b**`");
  });

  test("wraps tables in a code block", () => {
    const rendered = markdownToMrkdwn("Results:\n| name | value |\n|---|:---:|\n| **a** | <b> |\nafter");
    expect(rendered).toBe("Results:\n```\n| name | value |\n|---|:---:|\n| **a** | &lt;b&gt; |\n```\nafter");
  });

  test("refuses unsafe link schemes and never emits a control sequence from link targets", () => {
    const rendered = markdownToMrkdwn("[click](javascript:alert(1)) [ping](!channel) [x](@U1)");
    expect(rendered).not.toContain("<javascript");
    expect(rendered).not.toContain("<!channel");
    expect(rendered).not.toContain("<@U1");
    expect(rendered).toContain("click (javascript:alert(1");
  });

  test("escapes link labels and URL delimiters", () => {
    expect(markdownToMrkdwn("[<!here> a|b](https://e.com/p?q=a|b&r=<s)")).toBe(
      `<https://e.com/p?q=a%7Cb&amp;r=%3Cs|@${ZWSP}here a|b>`,
    );
  });

  test("neutralizes mentions in prose", () => {
    const rendered = markdownToMrkdwn(
      "Hey <!channel> and <!here|here> and <!everyone> plus <!subteam^S123|@devs> and <@U123ABC|bob>, @here @channel @everyone",
    );
    assertNoControlSequences(rendered);
    expect(rendered).toBe(
      `Hey @${ZWSP}channel and @${ZWSP}here and @${ZWSP}everyone plus @${ZWSP}devs and @${ZWSP}U123ABC, @${ZWSP}here @${ZWSP}channel @${ZWSP}everyone`,
    );
  });

  test("handles unicode text and emphasis", () => {
    expect(markdownToMrkdwn("**héllo 世界 🎉** _ñ_ ~~émoji 👩‍💻~~")).toBe("*héllo 世界 🎉* _ñ_ ~émoji 👩‍💻~");
  });

  test("strips private-use sentinels so model output cannot forge placeholders", () => {
    expect(markdownToMrkdwn("a0b `c`")).toBe("a0b `c`");
  });
});

describe("escapeSlackText", () => {
  test("escapes entities and neutralizes every mention form", () => {
    const escaped = escapeSlackText("a & b < c > d <!channel> <@W1> <!subteam^S1> <#C1|general> <!date^1|x> @here");
    expect(escaped).toBe(
      `a &amp; b &lt; c &gt; d @${ZWSP}channel @${ZWSP}W1 @${ZWSP}S1 #general !date^1|x @${ZWSP}here`,
    );
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });

  test("does not touch email addresses or already-broken mentions", () => {
    expect(escapeSlackText("ops@here.com me@channel.io")).toBe("ops@here.com me@channel.io");
    expect(escapeSlackText(`@${ZWSP}here`)).toBe(`@${ZWSP}here`);
  });
});

describe("renderCodeBlock", () => {
  test("wraps verbatim text and breaks nested fences", () => {
    expect(renderCodeBlock("a <b>\n```\nc")).toBe(`\`\`\`\na &lt;b&gt;\n\`\`${ZWSP}\`\nc\n\`\`\``);
  });
});

describe("splitForSlack", () => {
  test("returns short text unchanged as a single chunk", () => {
    expect(splitForSlack("hello")).toEqual(["hello"]);
  });

  test("splits at paragraph boundaries with (i/n) markers under the limit", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}\n${"word ".repeat(100).trim()}`);
    const chunks = splitForSlack(paragraphs.join("\n\n"), 1_500);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, index) => {
      expect(chunk.length).toBeLessThanOrEqual(1_500);
      expect(chunk.endsWith(`\n(${index + 1}/${chunks.length})`)).toBe(true);
      expect(chunk.startsWith("Paragraph ")).toBe(true);
    });
    const rejoined = chunks.map((chunk) => chunk.replace(/\n\(\d+\/\d+\)$/, "")).join("\n\n");
    expect(rejoined).toBe(paragraphs.join("\n\n"));
  });

  test("closes and reopens code fences across chunks", () => {
    const code = Array.from({ length: 200 }, (_, index) => `const line${index} = ${index}; // ${"x".repeat(30)}`);
    const text = ["Intro", "```", ...code, "```", "Outro"].join("\n");
    const chunks = splitForSlack(text, 2_000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2_000);
      expect(fenceCount(chunk) % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```\n")).toBe(true);
    const codeLines = chunks
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.startsWith("const line"));
    expect(codeLines).toEqual(code);
    expect(chunks.at(-1)).toContain("Outro");
  });

  test("hard-wraps a single over-long line without splitting surrogate pairs", () => {
    const text = "🎉".repeat(5_000);
    const chunks = splitForSlack(text, 3_500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3_500);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(chunks.map((chunk) => chunk.replace(/\n\(\d+\/\d+\)$/, "")).join("")).toBe(text);
  });

  test("does not cut inside a generated link or entity", () => {
    const link = "<https://example.com/very/long/path|label>";
    const text = `${"a".repeat(1_978)}${link}${"b".repeat(100)}&amp;${"c".repeat(2_000)}`;
    const chunks = splitForSlack(text, 2_000);
    const pieces = chunks.map((chunk) => chunk.replace(/\n\(\d+\/\d+\)$/, ""));
    expect(pieces.some((piece) => piece.includes(link))).toBe(true);
    expect(pieces.some((piece) => piece.includes("&amp;"))).toBe(true);
    expect(pieces.join("")).toBe(text);
  });
});

describe("truncateBlockText", () => {
  test("leaves short text alone", () => {
    expect(truncateBlockText("short")).toBe("short");
  });

  test("truncates with an ellipsis and an omission note", () => {
    const truncated = truncateBlockText("line\n".repeat(1_000));
    expect(truncated.length).toBeLessThanOrEqual(3_000);
    expect(truncated).toMatch(/…\n_\(truncated \d+ more characters\)_$/);
  });

  test("closes an open code fence and never splits a surrogate pair", () => {
    const truncated = truncateBlockText(`header\n\`\`\`\n${"🎉".repeat(4_000)}\n\`\`\``, 3_000);
    expect(truncated.length).toBeLessThanOrEqual(3_000);
    expect(fenceCount(truncated) % 2).toBe(0);
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("coordinator cards", () => {
  test("a 10k-character diff approval card stays under Slack limits and stays inert", () => {
    const diff = Array.from({ length: 400 }, (_, index) => `+ line ${index} <!channel> **x** <@U1>`).join("\n");
    expect(diff.length).toBeGreaterThan(10_000);
    const card = approvalMessage("interaction-1", {
      requestId: "request-1",
      requestKind: "file-change",
      detail: diff,
      options: [],
    });
    const section = card.blocks?.[0];
    if (section?.type !== "section") throw new Error("approval card has no section");
    expect(section.text.text.length).toBeLessThanOrEqual(3_000);
    expect(section.text.text.startsWith("*Approval required* · file-change\n```\n")).toBe(true);
    expect(fenceCount(section.text.text) % 2).toBe(0);
    expect(section.text.text).toMatch(/_\(truncated \d+ more characters\)_$/);
    assertNoControlSequences(section.text.text);
    expect(card.text.length).toBeLessThanOrEqual(3_000);
  });

  test("question cards escape and neutralize model text", () => {
    const card = questionMessage("interaction-2", {
      requestId: "request-2",
      dismissible: false,
      questions: [
        {
          id: "q1",
          header: "Deploy <!here>?",
          question: `Ping @channel and <@U9>? ${"long ".repeat(1_000)}`,
          options: [],
          multiSelect: false,
        },
      ],
    });
    const section = card.blocks?.[0];
    if (section?.type !== "section") throw new Error("question card has no section");
    expect(section.text.text.length).toBeLessThanOrEqual(3_000);
    assertNoControlSequences(section.text.text);
    assertNoControlSequences(card.text);
    expect(card.text.length).toBeLessThanOrEqual(3_000);
  });
});

const now = "2026-09-21T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 2 },
});

function completedSnapshot(threadId: string, text: string): T3ThreadSnapshot {
  return {
    snapshotSequence: 9,
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "agent-tag/task-1",
      worktreePath: "/tmp/worktree",
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: "assistant-1",
      },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          text,
          turnId: "turn-1",
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [],
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

describe("coordinator final replies", () => {
  test("render to mrkdwn and enqueue ordered chunks with stable client message ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-render-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    let threadId = "not-dispatched";
    const reply = [
      "## Result <!channel>",
      ...Array.from({ length: 60 }, (_, index) => `Paragraph ${index} **done** ${"text ".repeat(30)}\n`),
    ].join("\n");
    const t3: T3CoordinatorGateway = {
      dispatch: async (command) => {
        if (command.type === "thread.turn.start") threadId = command.threadId;
        return { sequence: 1 };
      },
      fetchThread: async () => completedSnapshot(threadId, reply),
    };
    const coordinator = new AgentTagCoordinator({
      config,
      store,
      t3,
      workerId: "worker-a",
      now: () => new Date(now),
      sleep: async () => {},
    });
    try {
      store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "request",
        receivedAt: now,
        sourceOrderKey: "1000.000001",
      });
      const outcome = await coordinator.processNext();
      expect(outcome.kind).toBe("completed");
      const claimed = [];
      for (;;) {
        const next = store.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
        if (next === null) break;
        claimed.push(next);
        store.markOutboxDelivered({
          outboxId: next.outboxId,
          workerId: "slack-a",
          slackMessageTs: `1000.0000${10 + claimed.length}`,
          now,
        });
      }
      expect(claimed[0]?.clientMessageId.endsWith(":started")).toBe(true);
      const finals = claimed.slice(1);
      expect(finals.length).toBeGreaterThan(1);
      finals.forEach((message, index) => {
        expect(message.clientMessageId.endsWith(`:final-${index + 1}`)).toBe(true);
        expect(message.payload.text.length).toBeLessThanOrEqual(3_500);
        expect(message.payload.text.endsWith(`(${index + 1}/${finals.length})`)).toBe(true);
      });
      if (outcome.kind === "completed") expect(outcome.outboxId).toBe(finals[0]?.outboxId ?? "");
      expect(finals[0]?.payload.text.startsWith(`*Result @${ZWSP}channel*`)).toBe(true);
      expect(finals[0]?.payload.text).toContain("Paragraph 0 *done*");
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-render-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
