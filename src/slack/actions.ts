import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import type { AgentTagStore } from "../store/store.ts";

const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const actionSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: slackId }),
  user: z.object({ id: slackId }),
  channel: z.object({ id: slackId }),
  message: z.object({ ts: z.string().min(1), thread_ts: z.string().min(1).optional() }),
  actions: z
    .array(
      z.object({
        action_id: z.enum([
          "agent-tag.approval.accept",
          "agent-tag.approval.decline",
          "agent-tag.approval.cancel",
          "agent-tag.user-input.answer",
          "agent-tag.user-input.dismiss",
          "agent-tag.turn.cancel",
        ]),
        action_ts: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .length(1),
});
const answerValueSchema = z.object({
  interactionId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string(),
});

export type SlackActionResult =
  | { readonly kind: "accepted" | "duplicate"; readonly commandId: string }
  | {
      readonly kind: "ignored";
      readonly reason:
        | "invalid-action"
        | "workspace-denied"
        | "channel-denied"
        | "user-denied"
        | "interaction-denied";
    };

export class SlackActionRouter {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #now: () => string;

  constructor(input: { readonly config: AgentTagConfig; readonly store: AgentTagStore; readonly now?: () => string }) {
    this.#config = input.config;
    this.#store = input.store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  ingest(input: unknown): SlackActionResult {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) return { kind: "ignored", reason: "invalid-action" };
    const body = parsed.data;
    const action = body.actions[0];
    if (action === undefined) return { kind: "ignored", reason: "invalid-action" };
    if (body.team.id !== this.#config.slack.workspaceId) {
      return { kind: "ignored", reason: "workspace-denied" };
    }
    if (!this.#config.access.allowedChannelIds.includes(body.channel.id)) {
      return { kind: "ignored", reason: "channel-denied" };
    }
    if (!this.#config.access.allowedUserIds.includes(body.user.id)) {
      return { kind: "ignored", reason: "user-denied" };
    }
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

    let interactionId = action.value;
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
      case "agent-tag.user-input.answer": {
        let decoded: unknown;
        try {
          decoded = JSON.parse(action.value);
        } catch {
          return { kind: "ignored", reason: "invalid-action" };
        }
        const answer = answerValueSchema.safeParse(decoded);
        if (!answer.success) return { kind: "ignored", reason: "invalid-action" };
        interactionId = answer.data.interactionId;
        response = { kind: "answer", answers: { [answer.data.questionId]: answer.data.answer } };
        break;
      }
    }
    const result = this.#store.submitInteractionResponse({
      interactionId,
      workspaceId: body.team.id,
      conversationId: body.channel.id,
      threadTs,
      actorUserId: body.user.id,
      sourceActionId,
      response,
      now: this.#now(),
    });
    if (result.kind === "denied") return { kind: "ignored", reason: "interaction-denied" };
    return { kind: result.kind, commandId: result.commandId };
  }
}
