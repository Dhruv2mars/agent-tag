// Live status message (PR-F3): pure renderer for the one message per turn that says what the agent
// is doing. The first post and every later edit (refresh rows rendered at delivery time) come from
// this function, so they cannot diverge. Only a running turn has the Stop button; every other state
// renders without an actions block, so no live button outlives its turn.
import type { SlackOutboxPayload, StatusMessageView } from "../store/store.ts";
import { escapeSlackText, truncateBlockText } from "./render.ts";

type SlackBlock = NonNullable<SlackOutboxPayload["blocks"]>[number];

export const STOP_ACTION_ID = "agent-tag.turn.stop";

const PLAN_ICONS = {
  completed: ":white_check_mark:",
  inProgress: ":arrow_right:",
  pending: ":white_circle:",
} as const;

export interface StatusRenderOptions {
  /** `slack.ui.statusProgress`: false shows only the headline (no plan, tool lines or count). */
  readonly showProgress: boolean;
}

/** The Stop button's value: the task to cancel and the turn it belongs to (stale buttons are denied). */
export function stopActionValue(view: Pick<StatusMessageView, "taskId" | "operationId">): string {
  return JSON.stringify({ taskId: view.taskId, operationId: view.operationId });
}

/** Elapsed wall time for a headline, e.g. 192_000 -> "3m 12s". */
export function describeElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function headline(view: StatusMessageView): string {
  const by = view.actorUserId === null ? "" : ` by <@${view.actorUserId}>`;
  switch (view.state) {
    case "running":
      return "Working on it…";
    case "waiting":
      return "Waiting for your answer above";
    case "stopping":
      return `Stopping…${by === "" ? "" : ` (requested${by})`}`;
    case "done":
      return view.settledAt === null
        ? "Done"
        : `Done in ${describeElapsed(Date.parse(view.settledAt) - Date.parse(view.startedAt))}`;
    case "stopped":
      return `Stopped${by}`;
    case "failed":
      return "Failed: see the message below";
    case "expired":
      return "Expired waiting for an answer";
  }
}

/** A provider-written line (tool title, shell command, path) as an inert code span. */
function codeSpan(text: string): string {
  return `\`${escapeSlackText(text).replaceAll("`", "'")}\``;
}

export function renderStatusMessage(view: StatusMessageView, options: StatusRenderOptions): SlackOutboxPayload {
  const title = headline(view);
  const lines = [`*${title}*`];
  const { plan, recent, toolCount } = view.progress;
  if (options.showProgress) {
    for (const step of plan) lines.push(`${PLAN_ICONS[step.status]} ${escapeSlackText(step.step)}`);
    // Tool lines are a live trace; once the turn has settled only the plan stays as a record.
    if (view.state === "running" || view.state === "stopping") {
      for (const line of recent) lines.push(codeSpan(line));
    }
  }
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: truncateBlockText(lines.join("\n")) } },
  ];
  if (options.showProgress && toolCount > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${toolCount} tool call${toolCount === 1 ? "" : "s"}` }],
    });
  }
  if (view.state === "running") {
    blocks.push({
      type: "actions",
      block_id: `agent-tag:status:${view.operationId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          style: "danger",
          action_id: STOP_ACTION_ID,
          value: stopActionValue(view),
        },
      ],
    });
  }
  return { text: title, blocks };
}
