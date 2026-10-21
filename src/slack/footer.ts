// Final reply footer (PR-F4): the last chunk of a turn's reply ends with a context line naming the
// model that answered and how long the turn took, read from the settled T3 snapshot (not config), so
// a per-thread model switch shows up as soon as it applies. Earlier chunks stay plain text.
import type { SlackOutboxPayload } from "../store/store.ts";
import type { T3ThreadSnapshot } from "../t3/gateway.ts";
import { describeElapsed } from "./status.ts";
import { SLACK_SECTION_TEXT_LIMIT, splitForSlack } from "./render.ts";

export interface ReplyFooter {
  readonly model: string;
  readonly instanceId: string;
  /** Turn wall time; null when the start is unknown. */
  readonly elapsedMs: number | null;
}

/**
 * The footer for a completed turn: the model T3 ran it on, and the time since its status message
 * opened (so it matches the status "Done in"), falling back to T3's own turn start.
 */
export function replyFooter(snapshot: T3ThreadSnapshot, statusStartedAt: string | undefined, completedAt: Date): ReplyFooter {
  const turn = snapshot.thread.latestTurn;
  const startedAt = statusStartedAt ?? turn?.startedAt ?? turn?.requestedAt;
  const start = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  return {
    model: snapshot.thread.modelSelection.model,
    instanceId: snapshot.thread.modelSelection.instanceId,
    elapsedMs: Number.isNaN(start) ? null : Math.max(0, completedAt.getTime() - start),
  };
}

/** The latest turn's changed-file count from its T3 checkpoint, once T3 has recorded one. */
export function turnFilesChanged(snapshot: T3ThreadSnapshot): { filesChanged?: number } {
  const turnId = snapshot.thread.latestTurn?.turnId;
  const checkpoint = snapshot.thread.checkpoints?.find((candidate) => candidate.turnId === turnId);
  return checkpoint?.status === "ready" ? { filesChanged: checkpoint.files.length } : {};
}

/** "gpt-5.6-sol · codex · 3m 12s", rendered as plain text so ids like `my_model` stay literal. */
export function footerText(footer: ReplyFooter): string {
  const parts = [footer.model, footer.instanceId];
  if (footer.elapsedMs !== null) parts.push(describeElapsed(footer.elapsedMs));
  return parts.join(" · ");
}

/**
 * Splits a final reply (already mrkdwn) into Slack chunks. With a footer, chunks are cut at the
 * section-block limit so the last one fits a section, and it becomes `section + context(footer)`
 * with the same text as its notification fallback. Without one, chunks are text-only as before.
 */
export function finalReplyChunks(mrkdwn: string, footer: ReplyFooter | null): Array<string | SlackOutboxPayload> {
  if (footer === null) return splitForSlack(mrkdwn);
  const chunks: Array<string | SlackOutboxPayload> = splitForSlack(mrkdwn, SLACK_SECTION_TEXT_LIMIT);
  const last = chunks.at(-1);
  // Slack rejects an empty section; a blank reply keeps its old text-only shape.
  if (typeof last !== "string" || last.trim() === "") return chunks;
  chunks[chunks.length - 1] = {
    text: last,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: last } },
      { type: "context", elements: [{ type: "plain_text", text: footerText(footer) }] },
    ],
  };
  return chunks;
}
