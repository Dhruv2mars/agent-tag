import { describe, expect, test } from "bun:test";

import { outboxPayloadSchema } from "../src/store/schema.ts";
import {
  PR_VIEW_ACTION_ID,
  pullRequestCard,
  type PullRequestCardInput,
  pullRequestClosedNotice,
  pullRequestFailedNotice,
  pullRequestPushedLine,
  pushRejectedNotice,
  safeLinkUrl,
  secretBlockedNotice,
  sizeBlockedNotice,
  snapshotFailedNotice,
} from "../src/slack/pr-card.ts";

const ZWSP = "​";
const url = "https://github.com/o/r/pull/7";

function card(overrides: Partial<PullRequestCardInput> = {}) {
  return pullRequestCard({
    jobId: "job-1",
    repo: "o/r",
    number: 7,
    url,
    title: "Fix the thing",
    headBranch: "feat/fix",
    baseBranch: "main",
    draft: false,
    draftUnavailable: false,
    ...overrides,
  });
}

type Block = NonNullable<ReturnType<typeof card>["blocks"]>[number];

function sectionText(block: Block | undefined): string {
  if (block === undefined || block.type !== "section") throw new Error("expected a section block");
  return block.text.text;
}

function contextTexts(block: Block | undefined): string[] {
  if (block === undefined || block.type !== "context") throw new Error("expected a context block");
  return block.elements.map((element) => element.text);
}

function expectValidPayload(payload: unknown): void {
  expect(outboxPayloadSchema.safeParse(payload).success).toBe(true);
}

describe("safeLinkUrl", () => {
  test("accepts https and http URLs and returns the normalized href", () => {
    expect(safeLinkUrl("https://github.com/o/r/pull/7")).toBe("https://github.com/o/r/pull/7");
    expect(safeLinkUrl("http://example.com/path")).toBe("http://example.com/path");
    expect(safeLinkUrl("HTTPS://Example.com")).toBe("https://example.com/");
  });

  test("rejects non-web schemes and garbage", () => {
    expect(safeLinkUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeLinkUrl("ftp://example.com/file")).toBeUndefined();
    expect(safeLinkUrl("mailto:someone@example.com")).toBeUndefined();
    expect(safeLinkUrl("not a url")).toBeUndefined();
    expect(safeLinkUrl("")).toBeUndefined();
    expect(safeLinkUrl("https://")).toBeUndefined();
  });

  test("rejects a pipe, which survives URL normalization", () => {
    // `|` is not percent-encoded by the WHATWG parser in a path or query, so it reaches the href.
    expect(safeLinkUrl("https://example.com/a|b")).toBeUndefined();
    expect(safeLinkUrl("https://example.com/?q=a|b")).toBeUndefined();
  });

  test("rejects a host that would carry `<`, `>`, `|` or whitespace", () => {
    expect(safeLinkUrl("https://a<b.example.com/")).toBeUndefined();
    expect(safeLinkUrl("https://a>b.example.com/")).toBeUndefined();
    expect(safeLinkUrl("https://a|b.example.com/")).toBeUndefined();
    expect(safeLinkUrl("https://a b.example.com/")).toBeUndefined();
  });

  test("percent-encodes whitespace, `<` and `>` in the path instead of rejecting them", () => {
    // The URL parser encodes these, so the normalized href no longer contains them and it is safe to use.
    expect(safeLinkUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(safeLinkUrl("https://example.com/a<b>")).toBe("https://example.com/a%3Cb%3E");
    expect(safeLinkUrl("https://example.com/?q=<x>")).toBe("https://example.com/?q=%3Cx%3E");
  });

  // Suspected gap: pr-card.ts link() puts the href into `<url|label>` without entity-escaping `&`
  // (render.ts escapeUrl does). Low severity: the URL is GitHub's html_url, so it rarely has a query string.
  test("entity-escapes `&` in the href inside a Slack `<url|label>` link", () => {
    const payload = card({ url: "https://github.com/o/r/pull/7?a=1&b=2" });
    expect(sectionText(payload.blocks?.[0])).toContain("<https://github.com/o/r/pull/7?a=1&amp;b=2|");
    expect(JSON.stringify(payload.blocks)).toContain('"url":"https://github.com/o/r/pull/7?a=1&b=2"');
  });
});

describe("pullRequestCard", () => {
  test("headline links the PR with a label of repo, number and title", () => {
    const payload = card();
    expect(sectionText(payload.blocks?.[0])).toBe(
      ":git-pull-request: PR opened: <https://github.com/o/r/pull/7|o/r#7 Fix the thing>",
    );
    expect(payload.text).toBe("PR opened: o/r#7 Fix the thing https://github.com/o/r/pull/7");
    expectValidPayload(payload);
  });

  test("says Draft PR opened for a draft", () => {
    const payload = card({ draft: true });
    expect(sectionText(payload.blocks?.[0])).toContain("Draft PR opened: <https://github.com/o/r/pull/7|");
    expect(payload.text.startsWith("Draft PR opened: ")).toBe(true);
  });

  test("escapes a malicious title so it cannot mention anyone or break the link", () => {
    const payload = card({ title: "x> <!channel> & <@U1>" });
    const headline = sectionText(payload.blocks?.[0]);
    expect(headline).toBe(
      `:git-pull-request: PR opened: <https://github.com/o/r/pull/7|o/r#7 x&gt; @${ZWSP}channel &amp; @${ZWSP}U1>`,
    );
    expect(headline).not.toContain("<!channel>");
    expect(headline).not.toContain("<@U1>");
    expect(payload.text).not.toContain("<!channel>");
    expect(payload.text).not.toContain("<@U1>");
    expectValidPayload(payload);
  });

  test("neutralizes backticks in branch names so the stats code spans stay closed", () => {
    const payload = card({ headBranch: "feat/`evil`", baseBranch: "main" });
    const stats = sectionText(payload.blocks?.[1]);
    expect(stats).toBe("`feat/'evil'` → `main`");
    expect(stats.match(/`/g)?.length).toBe(4);
    expectValidPayload(payload);
  });

  test("escapes mention control sequences in branch names", () => {
    const payload = card({ headBranch: "feat/<!here>" });
    const stats = sectionText(payload.blocks?.[1]);
    expect(stats).toContain(`feat/@${ZWSP}here`);
    expect(stats).not.toContain("<!here>");
  });

  test("renders an actions block with the View PR button, job id value and the href", () => {
    const payload = card({ jobId: "job-42" });
    const actions = payload.blocks?.[2];
    expect(actions).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR" },
          action_id: PR_VIEW_ACTION_ID,
          value: "job-42",
          url: "https://github.com/o/r/pull/7",
        },
      ],
    });
    expect(PR_VIEW_ACTION_ID).toBe("agent-tag.pr.view");
    expectValidPayload(payload);
  });

  test("drops the actions block and plain-labels the PR for an unsafe URL", () => {
    const payload = card({ url: "javascript:alert(1)", title: "a<b" });
    expect(payload.blocks?.map((block) => block.type)).toEqual(["section", "section", "context"]);
    expect(sectionText(payload.blocks?.[0])).toBe(":git-pull-request: PR opened: o/r#7 a&lt;b");
    expect(payload.text).toBe("PR opened: o/r#7 a&lt;b");
    expect(JSON.stringify(payload)).not.toContain("javascript:");
    expectValidPayload(payload);
  });

  test("notes that drafts are unavailable when the repository refused a draft", () => {
    const payload = card({ draft: false, draftUnavailable: true });
    expect(sectionText(payload.blocks?.[0])).toContain(":git-pull-request: PR opened:");
    expect(contextTexts(payload.blocks?.[3])).toEqual([
      "Opened as a normal PR (drafts unavailable on this repo) · pushed by Agent Tag with its own credential · review before merging",
    ]);
  });

  test("uses the draft note for a draft and the plain note otherwise", () => {
    expect(contextTexts(card({ draft: true }).blocks?.[3])).toEqual([
      "Draft · pushed by Agent Tag with its own credential · review before merging",
    ]);
    expect(contextTexts(card().blocks?.[3])).toEqual([
      "Pushed by Agent Tag with its own credential · review before merging",
    ]);
  });

  test("adds a note when the agent switched the worktree off the task branch", () => {
    const payload = card({ headMoved: true, headBranch: "feat/fix" });
    const notes = contextTexts(payload.blocks?.[3]);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBe("The agent switched branches in its worktree; this PR has `feat/fix` only.");
  });

  test("omits the head-moved note when the flag is absent or false", () => {
    expect(contextTexts(card({ headMoved: false }).blocks?.[3])).toHaveLength(1);
    expect(contextTexts(card().blocks?.[3])).toHaveLength(1);
  });

  test("stats line lists commits, files and churn when given", () => {
    const payload = card({ commits: 3, changedFiles: 1, additions: 10, deletions: 2 });
    expect(sectionText(payload.blocks?.[1])).toBe("`feat/fix` → `main` · 3 commits · 1 file · +10 −2");
  });

  test("stats line keeps only the branch arrow when no counts are given", () => {
    expect(sectionText(card().blocks?.[1])).toBe("`feat/fix` → `main`");
  });

  test("stats line omits churn unless both additions and deletions are given", () => {
    expect(sectionText(card({ commits: 1, additions: 5 }).blocks?.[1])).toBe("`feat/fix` → `main` · 1 commit");
    expect(sectionText(card({ commits: 1, changedFiles: 2 }).blocks?.[1])).toBe(
      "`feat/fix` → `main` · 1 commit · 2 files",
    );
  });

  test("truncates a huge title so the headline stays within the Slack section limit", () => {
    const payload = card({ title: "x".repeat(5_000) });
    const headline = sectionText(payload.blocks?.[0]);
    expect(headline.length).toBeLessThanOrEqual(3_000);
    expect(headline).toContain("truncated");
    expectValidPayload(payload);
  });
});

describe("PR card payload schema", () => {
  test("rejects a link button whose url is javascript:", () => {
    const payload = {
      text: "x",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View PR" },
              action_id: PR_VIEW_ACTION_ID,
              value: "job-1",
              url: "javascript:alert(1)",
            },
          ],
        },
      ],
    };
    expect(outboxPayloadSchema.safeParse(payload).success).toBe(false);
  });

  test("accepts the https link button the card produces", () => {
    const payload = card();
    expect(outboxPayloadSchema.safeParse(payload).success).toBe(true);
    expect(outboxPayloadSchema.parse(payload).blocks?.[2]).toMatchObject({ type: "actions" });
  });
});

describe("PR follow-up notices", () => {
  test("pushed line links the PR, counts commits and adds churn", () => {
    const payload = pullRequestPushedLine({
      repo: "o/r",
      number: 12,
      url: "https://github.com/o/r/pull/12",
      pushedCommits: 2,
      additions: 14,
      deletions: 3,
    });
    expect(payload.text).toBe("Pushed 2 commits to <https://github.com/o/r/pull/12|o/r#12> (+14 −3 total)");
    expect(payload.blocks).toEqual([{ type: "context", elements: [{ type: "mrkdwn", text: payload.text }] }]);
    expectValidPayload(payload);
  });

  test("pushed line uses the singular and omits churn when absent", () => {
    const payload = pullRequestPushedLine({
      repo: "o/r",
      number: 12,
      url: "https://github.com/o/r/pull/12",
      pushedCommits: 1,
    });
    expect(payload.text).toBe("Pushed 1 commit to <https://github.com/o/r/pull/12|o/r#12>");
  });

  test("pushed line escapes the repository label", () => {
    const payload = pullRequestPushedLine({
      repo: "o/<@U1>",
      number: 12,
      url: "https://github.com/o/r/pull/12",
      pushedCommits: 1,
    });
    expect(payload.text).not.toContain("<@U1>");
    expect(payload.text).toContain(`o/@${ZWSP}U1#12`);
  });

  test("pushed line falls back to plain text for an unsafe URL", () => {
    const payload = pullRequestPushedLine({
      repo: "o/r",
      number: 12,
      url: "javascript:alert(1)",
      pushedCommits: 1,
    });
    expect(payload.text).toBe("Pushed 1 commit to o/r#12");
  });

  test("closed notice says merged or closed and links the PR", () => {
    const merged = pullRequestClosedNotice({ repo: "o/r", number: 7, url, state: "merged" });
    expect(merged.text).toBe(
      "<https://github.com/o/r/pull/7|o/r#7> is merged, so I didn't push. Start a new thread for new work.",
    );
    const closed = pullRequestClosedNotice({ repo: "o/r", number: 7, url, state: "closed" });
    expect(closed.text).toBe(
      "<https://github.com/o/r/pull/7|o/r#7> is closed, so I didn't push. Start a new thread for new work.",
    );
    expectValidPayload(merged);
    expectValidPayload(closed);
  });

  test("push rejected notice escapes and code-spans the branch", () => {
    const payload = pushRejectedNotice("feat/`x`<!channel>");
    expect(payload.text).toContain("Someone else pushed to `feat/'x'@" + ZWSP + "channel`;");
    expect(payload.text).not.toContain("<!channel>");
    expectValidPayload(payload);
  });

  test("failed notice escapes the reason", () => {
    const payload = pullRequestFailedNotice("<!channel> boom & more");
    expect(payload.text).toBe(`I couldn't update the pull request: @${ZWSP}channel boom &amp; more`);
    expectValidPayload(payload);
  });

  test("snapshot failed notice escapes the code", () => {
    expect(snapshotFailedNotice("x<y")).toBe("Couldn't prepare a PR: x&lt;y");
  });
});

describe("PR blocked notices", () => {
  test("secret notice lists at most five paths", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const text = secretBlockedNotice(paths);
    expect(text).toContain("`a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts`");
    expect(text).not.toContain("f.ts");
    expect(text).not.toContain("g.ts");
    expect(text).toContain("(line hidden)");
  });

  test("secret notice falls back to 'the changes' when no path is known", () => {
    expect(secretBlockedNotice([])).toContain("credential in the changes (line hidden)");
  });

  test("secret notice escapes path names", () => {
    expect(secretBlockedNotice(["<!here>.env"])).toContain(`\`@${ZWSP}here.env\``);
  });

  test("size notice formats megabytes with one decimal place", () => {
    expect(
      sizeBlockedNotice({ changedFiles: 120, diffBytes: 2_500_000, maxChangedFiles: 100, maxDiffBytes: 1_000_000 }),
    ).toBe(
      "I didn't push: the changes exceed the configured limit (120 of 100 files, 2.5 MB of 1.0 MB).",
    );
  });
});
