// Slack output of the draft PR workflow (PR-M §3.7): the PR card, the follow-up "pushed" line and the
// notices. PR titles and branch names can come from the model, so every value is escaped (B11 parity).
import type { SlackOutboxPayload } from "../store/store.ts";
import { escapeSlackText, truncateBlockText } from "./render.ts";

export const PR_VIEW_ACTION_ID = "agent-tag.pr.view";

export interface PullRequestCardInput {
  readonly jobId: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  /** The repository refused a draft, so the PR was opened as a normal PR with a `[WIP]` title. */
  readonly draftUnavailable: boolean;
  readonly commits?: number;
  readonly changedFiles?: number;
  readonly additions?: number;
  readonly deletions?: number;
  /** The agent switched the worktree off the task branch; the PR has the task branch only. */
  readonly headMoved?: boolean;
}

/** Only plain https URLs that cannot break out of a Slack `<url|label>` link. */
export function safeLinkUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const href = parsed.href;
  return /[\s<>|]/.test(href) ? undefined : href;
}

function link(url: string, label: string): string {
  const href = safeLinkUrl(url);
  // Inside mrkdwn, `&` in the href must be an entity like every other `&` (render.ts escapeUrl parity).
  return href === undefined ? escapeSlackText(label) : `<${href.replaceAll("&", "&amp;")}|${escapeSlackText(label)}>`;
}

function code(text: string): string {
  // Backticks would end the inline code span; branch names never legitimately contain one.
  return `\`${escapeSlackText(text.replaceAll("`", "'"))}\``;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function churn(additions: number | undefined, deletions: number | undefined): string | undefined {
  return additions === undefined || deletions === undefined ? undefined : `+${additions} −${deletions}`;
}

export function pullRequestCard(input: PullRequestCardInput): SlackOutboxPayload {
  const label = `${input.repo}#${input.number} ${input.title}`;
  const opened = input.draft ? "Draft PR opened" : "PR opened";
  const headline = `:git-pull-request: ${opened}: ${link(input.url, label)}`;
  const stats = [
    `${code(input.headBranch)} → ${code(input.baseBranch)}`,
    input.commits === undefined ? undefined : plural(input.commits, "commit"),
    input.changedFiles === undefined ? undefined : plural(input.changedFiles, "file"),
    churn(input.additions, input.deletions),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const notes = [
    input.draft
      ? "Draft · pushed by Agent Tag with its own credential · review before merging"
      : input.draftUnavailable
        ? "Opened as a normal PR (drafts unavailable on this repo) · pushed by Agent Tag with its own credential · review before merging"
        : "Pushed by Agent Tag with its own credential · review before merging",
    ...(input.headMoved === true
      ? [`The agent switched branches in its worktree; this PR has ${code(input.headBranch)} only.`]
      : []),
  ];
  const href = safeLinkUrl(input.url);
  return {
    text: `${opened}: ${escapeSlackText(label)}${href === undefined ? "" : ` ${href}`}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: truncateBlockText(headline) } },
      { type: "section", text: { type: "mrkdwn", text: truncateBlockText(stats) } },
      ...(href === undefined
        ? []
        : [
            {
              type: "actions" as const,
              elements: [
                {
                  type: "button" as const,
                  text: { type: "plain_text" as const, text: "View PR" },
                  action_id: PR_VIEW_ACTION_ID,
                  value: input.jobId,
                  url: href,
                },
              ],
            },
          ]),
      { type: "context", elements: notes.map((text) => ({ type: "mrkdwn" as const, text })) },
    ],
  };
}

/** Follow-up: "Pushed 2 commits to <url|owner/repo#12> (+14 −3)". */
export function pullRequestPushedLine(input: {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly pushedCommits: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly headBranch?: string;
  readonly headMoved?: boolean;
}): SlackOutboxPayload {
  const stats = churn(input.additions, input.deletions);
  const moved =
    input.headMoved === true && input.headBranch !== undefined
      ? `. The agent switched branches in its worktree; only ${code(input.headBranch)} was pushed.`
      : "";
  const text = `Pushed ${plural(input.pushedCommits, "commit")} to ${link(input.url, `${input.repo}#${input.number}`)}${stats === undefined ? "" : ` (${stats} total)`}${moved}`;
  return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] };
}

function notice(text: string): SlackOutboxPayload {
  return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] };
}

export function pullRequestClosedNotice(input: {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly state: "closed" | "merged";
}): SlackOutboxPayload {
  return notice(
    `${link(input.url, `${input.repo}#${input.number}`)} is ${input.state}, so I didn't push. Start a new thread for new work.`,
  );
}

export function pushRejectedNotice(headBranch: string): SlackOutboxPayload {
  return notice(
    `Someone else pushed to ${code(headBranch)}; I didn't overwrite it. Pull their changes into this thread's branch, or start a new thread.`,
  );
}

export function pullRequestFailedNotice(reason: string): SlackOutboxPayload {
  return notice(`I couldn't update the pull request: ${escapeSlackText(reason)}`);
}

export function secretBlockedNotice(paths: readonly string[]): string {
  const where = paths.length === 0 ? "the changes" : paths.slice(0, 5).map(code).join(", ");
  return `I didn't push: the diff contains something that looks like a credential in ${where} (line hidden). Remove it and ask again.`;
}

export function sizeBlockedNotice(input: {
  readonly changedFiles: number;
  readonly diffBytes: number;
  readonly maxChangedFiles: number;
  readonly maxDiffBytes: number;
}): string {
  const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `I didn't push: the changes exceed the configured limit (${input.changedFiles} of ${input.maxChangedFiles} files, ${megabytes(input.diffBytes)} of ${megabytes(input.maxDiffBytes)}).`;
}

export function snapshotFailedNotice(code: string): string {
  return `Couldn't prepare a PR: ${escapeSlackText(code)}`;
}
