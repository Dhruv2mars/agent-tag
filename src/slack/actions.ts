import type { types as SlackTypes } from "@slack/bolt";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import type { AgentTagStore, UserInputQuestionPrompt, UserInputSelection } from "../store/store.ts";

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const slackActionIdSchema = z.enum([
  "agent-tag.approval.accept",
  "agent-tag.approval.decline",
  "agent-tag.approval.cancel",
  "agent-tag.user-input.answer",
  "agent-tag.user-input.open",
  "agent-tag.user-input.dismiss",
  "agent-tag.turn.cancel",
  // Link button on the draft PR card: Slack opens the URL and still sends block_actions, which is acked only.
  "agent-tag.pr.view",
]);
export const SLACK_ACTION_IDS = slackActionIdSchema.options;
/** Callback id of the modal that collects a free-text or multi-select answer to one question. */
export const USER_INPUT_MODAL_CALLBACK_ID = "agent-tag.user-input.submit";
export const USER_INPUT_OPTIONS_BLOCK_ID = "agent-tag.user-input.options";
export const USER_INPUT_TEXT_BLOCK_ID = "agent-tag.user-input.text";
const USER_INPUT_ELEMENT_ACTION_ID = "value";

const actionSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: slackId }),
  user: z.object({ id: slackId }),
  channel: z.object({ id: slackId }),
  trigger_id: z.string().min(1).optional(),
  message: z.object({ ts: z.string().min(1), thread_ts: z.string().min(1).optional() }),
  actions: z
    .array(
      z.object({
        action_id: slackActionIdSchema,
        action_ts: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .length(1),
});
// Option buttons carry the option index; `answer` (the option label) is accepted from older prompts.
const answerValueSchema = z
  .object({
    interactionId: z.string().min(1),
    questionId: z.string().min(1),
    optionIndex: z.number().int().nonnegative().optional(),
    answer: z.string().optional(),
  })
  .refine((value) => value.optionIndex !== undefined || value.answer !== undefined);
const openValueSchema = z.object({ interactionId: z.string().min(1), questionId: z.string().min(1) });
const modalMetadataSchema = z.object({
  interactionId: z.string().min(1),
  questionId: z.string().min(1),
  conversationId: slackId,
  threadTs: z.string().min(1),
});
const selectedOptionsSchema = z.object({
  selected_options: z.array(z.object({ value: z.string() })).nullish(),
});
const textInputSchema = z.object({ value: z.string().nullish() });
const viewSubmissionSchema = z.object({
  type: z.literal("view_submission"),
  team: z.object({ id: slackId }),
  user: z.object({ id: slackId }),
  view: z.object({
    id: z.string().min(1),
    callback_id: z.literal(USER_INPUT_MODAL_CALLBACK_ID),
    private_metadata: z.string(),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.unknown())) }),
  }),
});

type IgnoredReason =
  | "invalid-action"
  | "workspace-denied"
  | "channel-denied"
  | "user-denied"
  | "interaction-denied"
  | "interaction-expired"
  | "link-button";

export type SlackActionResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | { readonly kind: "partial"; readonly commandId: string; readonly answered: number; readonly total: number }
  | { readonly kind: "open-modal"; readonly triggerId: string; readonly view: SlackTypes.ModalView }
  | { readonly kind: "ignored"; readonly reason: IgnoredReason };

export type SlackViewSubmissionResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | { readonly kind: "partial"; readonly commandId: string; readonly answered: number; readonly total: number }
  | { readonly kind: "invalid-input"; readonly errors: Readonly<Record<string, string>> }
  | { readonly kind: "ignored"; readonly reason: IgnoredReason };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function customAnswerAllowed(question: UserInputQuestionPrompt): boolean {
  return question.options.length === 0 || question.allowCustomAnswer !== false;
}

/** Builds the modal for one question: checkboxes for multi-select, a text input when custom answers are allowed. */
export function userInputModal(input: {
  readonly interactionId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly question: UserInputQuestionPrompt;
}): SlackTypes.ModalView {
  const { question } = input;
  const withChoices = question.multiSelect && question.options.length > 0;
  const allowText = customAnswerAllowed(question);
  const blocks: SlackTypes.ModalView["blocks"][number][] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(`*${escapeSlackText(question.header)}*\n${escapeSlackText(question.question)}`, 3_000),
      },
    },
  ];
  if (withChoices) {
    const options = question.options.slice(0, 100).map((option, index) => ({
      text: { type: "plain_text" as const, text: truncate(option.label, 75) },
      value: String(index),
      ...(option.description === undefined || question.options.length > 10
        ? {}
        : { description: { type: "plain_text" as const, text: truncate(option.description, 75) } }),
    }));
    blocks.push({
      type: "input",
      block_id: USER_INPUT_OPTIONS_BLOCK_ID,
      optional: allowText,
      label: { type: "plain_text", text: "Choose one or more" },
      element:
        options.length <= 10
          ? { type: "checkboxes", action_id: USER_INPUT_ELEMENT_ACTION_ID, options }
          : {
              type: "multi_static_select",
              action_id: USER_INPUT_ELEMENT_ACTION_ID,
              placeholder: { type: "plain_text", text: "Choose options" },
              options,
            },
    });
  }
  if (allowText) {
    blocks.push({
      type: "input",
      block_id: USER_INPUT_TEXT_BLOCK_ID,
      optional: withChoices,
      label: { type: "plain_text", text: withChoices ? "Or type your own answer" : "Your answer" },
      element: {
        type: "plain_text_input",
        action_id: USER_INPUT_ELEMENT_ACTION_ID,
        multiline: true,
        max_length: 3_000,
      },
    });
  }
  return {
    type: "modal",
    callback_id: USER_INPUT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({
      interactionId: input.interactionId,
      questionId: question.id,
      conversationId: input.conversationId,
      threadTs: input.threadTs,
    }),
    title: { type: "plain_text", text: "Answer the agent" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

export class SlackActionRouter {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #now: () => string;

  constructor(input: { readonly config: AgentTagConfig; readonly store: AgentTagStore; readonly now?: () => string }) {
    this.#config = input.config;
    this.#store = input.store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  #accessDenied(workspaceId: string, channelId: string, userId: string): IgnoredReason | null {
    if (workspaceId !== this.#config.slack.workspaceId) return "workspace-denied";
    if (!this.#config.access.allowedChannelIds.includes(channelId)) return "channel-denied";
    if (!this.#config.access.allowedUserIds.includes(userId)) return "user-denied";
    return null;
  }

  ingest(input: unknown): SlackActionResult {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) return { kind: "ignored", reason: "invalid-action" };
    const body = parsed.data;
    const action = body.actions[0];
    if (action === undefined) return { kind: "ignored", reason: "invalid-action" };
    if (action.action_id === "agent-tag.pr.view") return { kind: "ignored", reason: "link-button" };
    const denied = this.#accessDenied(body.team.id, body.channel.id, body.user.id);
    if (denied !== null) return { kind: "ignored", reason: denied };
    const threadTs = body.message.thread_ts ?? body.message.ts;
    const sourceActionId = `${body.team.id}:${body.user.id}:${action.action_ts}:${action.action_id}`;
    if (action.action_id === "agent-tag.turn.cancel") {
      const result = this.#store.requestTaskCancellation({
        taskId: action.value,
        workspaceId: body.team.id,
        conversationId: body.channel.id,
        threadTs,
        actorUserId: body.user.id,
        sourceActionId,
        now: this.#now(),
      });
      if (result.kind === "denied") return { kind: "ignored", reason: "interaction-denied" };
      return { kind: result.kind, commandId: result.commandId };
    }

    if (action.action_id === "agent-tag.user-input.open") {
      const value = decodeJson(action.value, openValueSchema);
      if (value === null || body.trigger_id === undefined) return { kind: "ignored", reason: "invalid-action" };
      const question = this.#store.getPendingUserInputQuestion({
        interactionId: value.interactionId,
        questionId: value.questionId,
        workspaceId: body.team.id,
        conversationId: body.channel.id,
        threadTs,
        actorUserId: body.user.id,
      });
      if (question === null) return { kind: "ignored", reason: "interaction-denied" };
      return {
        kind: "open-modal",
        triggerId: body.trigger_id,
        view: userInputModal({
          interactionId: value.interactionId,
          conversationId: body.channel.id,
          threadTs,
          question,
        }),
      };
    }

    if (action.action_id === "agent-tag.user-input.answer") {
      const value = decodeJson(action.value, answerValueSchema);
      if (value === null) return { kind: "ignored", reason: "invalid-action" };
      const selection: UserInputSelection =
        value.optionIndex !== undefined
          ? { optionIndexes: [value.optionIndex] }
          : { optionLabels: value.answer === undefined ? [] : [value.answer] };
      const result = this.#store.submitUserInputAnswer({
        interactionId: value.interactionId,
        questionId: value.questionId,
        selection,
        workspaceId: body.team.id,
        conversationId: body.channel.id,
        threadTs,
        actorUserId: body.user.id,
        sourceActionId,
        expirySeconds: this.#config.limits.interactionExpirySeconds,
        now: this.#now(),
      });
      if (result.kind === "denied") return { kind: "ignored", reason: "interaction-denied" };
      if (result.kind === "expired") return { kind: "ignored", reason: "interaction-expired" };
      if (result.kind === "invalid") return { kind: "ignored", reason: "invalid-action" };
      return result;
    }

    let response: unknown;
    switch (action.action_id) {
      case "agent-tag.approval.accept":
        response = { decision: "accept" };
        break;
      case "agent-tag.approval.decline":
        response = { decision: "decline" };
        break;
      case "agent-tag.approval.cancel":
        response = { decision: "cancel" };
        break;
      case "agent-tag.user-input.dismiss":
        response = { kind: "dismiss" };
        break;
    }
    const result = this.#store.submitInteractionResponse({
      interactionId: action.value,
      workspaceId: body.team.id,
      conversationId: body.channel.id,
      threadTs,
      actorUserId: body.user.id,
      sourceActionId,
      response,
      expirySeconds: this.#config.limits.interactionExpirySeconds,
      now: this.#now(),
    });
    if (result.kind === "denied") return { kind: "ignored", reason: "interaction-denied" };
    if (result.kind === "expired") return { kind: "ignored", reason: "interaction-expired" };
    return { kind: result.kind, commandId: result.commandId };
  }

  /** Handles a submitted answer modal. `invalid-input` results should be acked with `response_action: "errors"`. */
  ingestViewSubmission(input: unknown): SlackViewSubmissionResult {
    const parsed = viewSubmissionSchema.safeParse(input);
    if (!parsed.success) return { kind: "ignored", reason: "invalid-action" };
    const body = parsed.data;
    const metadata = decodeJson(body.view.private_metadata, modalMetadataSchema);
    if (metadata === null) return { kind: "ignored", reason: "invalid-action" };
    const denied = this.#accessDenied(body.team.id, metadata.conversationId, body.user.id);
    if (denied !== null) return { kind: "ignored", reason: denied };

    const values = body.view.state.values;
    const choices = selectedOptionsSchema.safeParse(
      values[USER_INPUT_OPTIONS_BLOCK_ID]?.[USER_INPUT_ELEMENT_ACTION_ID] ?? {},
    );
    const text = textInputSchema.safeParse(values[USER_INPUT_TEXT_BLOCK_ID]?.[USER_INPUT_ELEMENT_ACTION_ID] ?? {});
    if (!choices.success || !text.success) return { kind: "ignored", reason: "invalid-action" };
    const optionIndexes = (choices.data.selected_options ?? []).map((option) => Number(option.value));
    const answerText = text.data.value?.trim() ?? "";
    const errorBlock =
      USER_INPUT_TEXT_BLOCK_ID in values ? USER_INPUT_TEXT_BLOCK_ID : USER_INPUT_OPTIONS_BLOCK_ID;
    if (optionIndexes.length === 0 && answerText.length === 0) {
      return { kind: "invalid-input", errors: { [errorBlock]: "Choose an option or type an answer." } };
    }
    const result = this.#store.submitUserInputAnswer({
      interactionId: metadata.interactionId,
      questionId: metadata.questionId,
      selection: { optionIndexes, text: answerText },
      workspaceId: body.team.id,
      conversationId: metadata.conversationId,
      threadTs: metadata.threadTs,
      actorUserId: body.user.id,
      sourceActionId: `${body.team.id}:${body.user.id}:${body.view.id}:view_submission`,
      expirySeconds: this.#config.limits.interactionExpirySeconds,
      now: this.#now(),
    });
    if (result.kind === "denied") return { kind: "ignored", reason: "interaction-denied" };
    if (result.kind === "expired") {
      return { kind: "invalid-input", errors: { [errorBlock]: "This question has expired and can no longer be answered." } };
    }
    if (result.kind === "invalid") {
      return { kind: "invalid-input", errors: { [errorBlock]: "That answer is not allowed for this question." } };
    }
    return result;
  }
}

function decodeJson<T>(text: string, schema: z.ZodType<T>): T | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const result = schema.safeParse(decoded);
  return result.success ? result.data : null;
}
