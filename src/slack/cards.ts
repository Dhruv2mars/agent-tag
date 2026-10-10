// Interaction cards: pure renderers for approval and question messages. The first post and every
// later edit (refresh rows rendered at delivery time) come from the same functions, so they cannot
// diverge. Once a request is no longer pending its card keeps the prompt as a record, drops every
// button, and ends with one status line naming who acted.
import { z } from "zod";

import type { InteractionCardView, SlackOutboxPayload } from "../store/store.ts";
import type { T3PendingApproval, T3PendingUserInput } from "../t3/gateway.ts";
import { escapeSlackText, renderCodeBlock, truncateBlockText } from "./render.ts";

type SlackBlock = NonNullable<SlackOutboxPayload["blocks"]>[number];
type SlackActionsBlock = Extract<SlackBlock, { readonly type: "actions" }>;

export interface CardRenderContext {
  /** `limits.interactionExpirySeconds`, for the "Expired after …" line. */
  readonly expirySeconds: number;
}

/** Renders a configured duration for Slack, e.g. 86400 -> "24 hours". */
export function describeDuration(seconds: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The parts of a T3PendingApproval a card shows. */
interface ApprovalPrompt {
  readonly requestKind: string;
  readonly detail?: string | undefined;
}

function approvalSection(approval: ApprovalPrompt): SlackBlock {
  const detail = approval.detail === undefined
    ? "The agent requested permission."
    : approval.detail.includes("\n")
    ? renderCodeBlock(approval.detail)
    : escapeSlackText(approval.detail);
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateBlockText(`*Approval required* · ${escapeSlackText(approval.requestKind)}\n${detail}`),
    },
  };
}

function approvalText(approval: ApprovalPrompt): string {
  return truncateBlockText(`Approval required: ${escapeSlackText(approval.requestKind)}`);
}

export function approvalMessage(interactionId: string, approval: T3PendingApproval | ApprovalPrompt): SlackOutboxPayload {
  return {
    text: approvalText(approval),
    blocks: [
      approvalSection(approval),
      {
        type: "actions",
        block_id: `agent-tag:${interactionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "agent-tag.approval.accept",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: "agent-tag.approval.decline",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel request" },
            action_id: "agent-tag.approval.cancel",
            value: interactionId,
          },
        ],
      },
    ],
  };
}

/** Per-question answers already recorded, keyed by question id (from `partial_response_json`). */
export type AnsweredQuestions = Readonly<Record<string, { readonly answer: string | readonly string[]; readonly actorUserId: string }>>;

/**
 * Renders every question of a T3 user-input request. Single-select options are buttons; multi-select
 * and free-text answers open a modal. Answers are collected per question and sent to T3 once complete;
 * an answered question shows its answer in place of its buttons.
 */
export function questionMessage(
  interactionId: string,
  request: T3PendingUserInput,
  answered: AnsweredQuestions = {},
): SlackOutboxPayload {
  if (request.questions.length === 0) throw new Error("T3 user-input request has no questions");
  const total = request.questions.length;
  const blocks: SlackBlock[] = [];
  if (total > 1) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*The agent has ${total} questions.* Answer each one; the replies are sent together once all are answered.`,
      },
    });
  }
  request.questions.forEach((question, index) => {
    const customAllowed = question.options.length === 0 || question.allowCustomAnswer !== false;
    const optionLines =
      question.multiSelect || question.options.some((option) => option.description !== undefined)
        ? question.options.map((option) =>
            `• ${escapeSlackText(option.label)}${option.description === undefined ? "" : ` — ${escapeSlackText(option.description)}`}`,
          )
        : [];
    const prefix = total > 1 ? `${index + 1}/${total} · ` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateBlockText(
          [`*${prefix}${escapeSlackText(question.header)}*`, escapeSlackText(question.question), ...optionLines].join("\n"),
        ),
      },
    });
    const answer = Object.hasOwn(answered, question.id) ? answered[question.id] : undefined;
    if (answer !== undefined) {
      const text = typeof answer.answer === "string" ? answer.answer : answer.answer.join(", ");
      blocks.push({
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: truncateBlockText(`:white_check_mark: Answered by ${mention(answer.actorUserId)}: ${escapeSlackText(truncateText(text, 200))}`),
        }],
      });
      return;
    }
    const elements: SlackActionsBlock["elements"] = question.multiSelect
      ? []
      : question.options.slice(0, 24).map((option, optionIndex) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: truncateText(option.label, 75) },
          action_id: "agent-tag.user-input.answer",
          value: JSON.stringify({ interactionId, questionId: question.id, optionIndex }),
        }));
    const needsModal = (question.multiSelect && question.options.length > 0) || customAllowed;
    if (needsModal) {
      elements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: question.multiSelect && question.options.length > 0
            ? "Choose options"
            : question.options.length > 0 ? "Other answer" : "Type answer",
        },
        action_id: "agent-tag.user-input.open",
        value: JSON.stringify({ interactionId, questionId: question.id }),
      });
    }
    if (elements.length > 0) {
      blocks.push({ type: "actions", block_id: `agent-tag:${interactionId}:q${index}`, elements });
    }
  });
  if (request.dismissible) {
    blocks.push({
      type: "actions",
      block_id: `agent-tag:${interactionId}:dismiss`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss" },
          action_id: "agent-tag.user-input.dismiss",
          value: interactionId,
        },
      ],
    });
  }
  const first = request.questions[0];
  return {
    text: total === 1 && first !== undefined
      ? truncateBlockText(`Question from the agent: ${escapeSlackText(first.question)}`)
      : truncateBlockText(`The agent has ${total} questions: ${request.questions.map((question) => escapeSlackText(question.question)).join(" / ")}`),
    blocks,
  };
}

// Stored prompts are re-validated at render time; one that no longer parses renders a generic card.
const storedApprovalSchema = z.object({
  requestKind: z.string(),
  detail: z.string().optional(),
});
const storedUserInputSchema = z.object({
  requestId: z.string().default(""),
  questions: z.array(z.object({
    id: z.string().min(1),
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    multiSelect: z.boolean(),
    allowCustomAnswer: z.boolean().optional(),
  })).min(1),
  dismissible: z.boolean().default(false),
});
const decisionResponseSchema = z.object({
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
});
const answerResponseSchema = z.object({ kind: z.literal("answer"), contributors: z.array(z.string()).optional() });
const dismissResponseSchema = z.object({ kind: z.literal("dismiss") });

type Decision = z.infer<typeof decisionResponseSchema>["decision"];

/** What the clicker chose (in-flight wording) and what happened (resolved wording), per decision. */
const DECISION_TEXT: Readonly<Record<Decision, { readonly chosen: string; readonly resolved: string }>> = {
  accept: { chosen: "Allow once", resolved: "Allowed once" },
  acceptForSession: { chosen: "Allow for this thread", resolved: "Allowed for this thread" },
  acceptAlways: { chosen: "Always allow", resolved: "Always allowed" },
  decline: { chosen: "Deny", resolved: "Denied" },
  cancel: { chosen: "Deny and stop", resolved: "Denied and stopped" },
};

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

/** A user mention for ids from the store; anything else renders inert. */
function mention(userId: string | null): string {
  if (userId === null) return "someone";
  return SLACK_USER_ID.test(userId) ? `<@${userId}>` : escapeSlackText(userId);
}

function slackTime(iso: string): string {
  const date = new Date(iso);
  const fallback = `${date.toISOString().slice(11, 16)} UTC`;
  return `<!date^${Math.floor(date.getTime() / 1_000)}^{time}|${fallback}>`;
}

/** The outcome as one sentence without decoration, e.g. "Allowed once by <@U1>". */
function responseText(view: InteractionCardView, tense: "chosen" | "resolved"): string {
  const actor = mention(view.responseActorId);
  const decision = decisionResponseSchema.safeParse(view.response);
  if (decision.success) {
    const text = DECISION_TEXT[decision.data.decision];
    return tense === "chosen" ? `${text.chosen}, chosen by ${actor}` : `${text.resolved} by ${actor}`;
  }
  if (dismissResponseSchema.safeParse(view.response).success) return `Dismissed by ${actor}`;
  const answer = answerResponseSchema.safeParse(view.response);
  const contributors = answer.success && answer.data.contributors !== undefined && answer.data.contributors.length > 0
    ? answer.data.contributors.map(mention).join(", ")
    : actor;
  return `Answered by ${contributors}`;
}

/**
 * The card's status line for a non-pending interaction, also used for "Already handled" feedback.
 * Error codes are Agent Tag's own; provider text never reaches the card.
 */
export function interactionStatusLine(view: InteractionCardView, ctx: CardRenderContext): string | null {
  switch (view.state) {
    case "pending":
      return null;
    case "response-pending":
    case "inflight":
      return `:hourglass_flowing_sand: ${responseText(view, "chosen")}. Sending to the agent…`;
    case "resolved":
      if (view.lastErrorCode === "resolved-elsewhere") return ":information_source: Resolved outside Slack.";
      return `:white_check_mark: ${responseText(view, "resolved")} · ${slackTime(view.updatedAt)}`;
    case "failed":
      if (view.lastErrorCode === "expired") {
        return `:hourglass: Expired after ${describeDuration(ctx.expirySeconds)} with no answer. The request was cancelled.`;
      }
      if (view.retriesExhausted) {
        return ":warning: Not applied: Agent Tag could not reach the agent. Ask the operator to check service diagnostics.";
      }
      if (view.responseActorId === null) {
        return ":information_source: Closed: the agent's turn ended before anyone answered.";
      }
      return ":warning: Not applied: this request is no longer pending.";
  }
}

/** The whole card for the interaction's current state. */
export function renderInteractionCard(view: InteractionCardView, ctx: CardRenderContext): SlackOutboxPayload {
  const status = interactionStatusLine(view, ctx);
  let card: SlackOutboxPayload;
  if (view.kind === "approval") {
    const approval = storedApprovalSchema.safeParse(view.prompt);
    const prompt = approval.success ? approval.data : { requestKind: "request" };
    card = status === null
      ? approvalMessage(view.interactionId, prompt)
      : { text: approvalText(prompt), blocks: [approvalSection(prompt)] };
  } else {
    const request = storedUserInputSchema.safeParse(view.prompt);
    const answered: Record<string, { answer: string | readonly string[]; actorUserId: string }> = {};
    for (const [questionId, entry] of Object.entries(view.partial?.answers ?? {})) {
      answered[questionId] = { answer: entry.answer, actorUserId: entry.actorUserId };
    }
    card = request.success
      ? questionMessage(view.interactionId, request.data, answered)
      : { text: "Question from the agent", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Question from the agent*" } }] };
  }
  if (status === null) return card;
  return {
    text: truncateBlockText(status),
    blocks: [
      ...(card.blocks ?? []).filter((block) => block.type !== "actions"),
      { type: "context", elements: [{ type: "mrkdwn", text: truncateBlockText(status) }] },
    ],
  };
}

/** The ephemeral reply to a click on a card that is no longer pending; null when there is nothing to say. */
export function alreadyHandledText(view: InteractionCardView | null, ctx: CardRenderContext): string | null {
  if (view === null) return null;
  const status = interactionStatusLine(view, ctx);
  return status === null ? null : `Already handled. ${status}`;
}
