// Multi-question user-input requests: per-question answers and the final combined response.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId, parseStoredJson } from "./context.ts";
import { insertOutboxMessage } from "./outbox.ts";
import {
  isoDateTime,
  nonEmpty,
  outboxPayloadSchema,
  partialUserInputSchema,
  userInputPromptSchema,
} from "./schema.ts";
import type {
  UserInputAnswerResult,
  UserInputQuestionPrompt,
  UserInputSelection,
} from "./types.ts";

/** Applies T3's answer rules: custom text wins when allowed; multi-select yields a list; otherwise one label. */
function resolveUserInputAnswer(
  question: UserInputQuestionPrompt,
  selection: UserInputSelection,
): string | string[] | null {
  const text = selection.text?.trim() ?? "";
  if (text.length > 0) {
    const customAllowed = question.options.length === 0 || question.allowCustomAnswer !== false;
    return customAllowed ? text : null;
  }
  const labels: string[] = [];
  for (const index of selection.optionIndexes ?? []) {
    const option = Number.isSafeInteger(index) ? question.options[index] : undefined;
    if (option === undefined) return null;
    labels.push(option.label);
  }
  for (const label of selection.optionLabels ?? []) {
    if (!question.options.some((option) => option.label === label)) return null;
    labels.push(label);
  }
  const unique = [...new Set(labels)];
  if (unique.length === 0) return null;
  if (question.multiSelect) return unique;
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface GetPendingUserInputQuestionInput {
  readonly interactionId: string;
  readonly questionId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
}

/** Returns one question of a still-pending user-input request when the actor may answer it. */
export function getPendingUserInputQuestion(
  database: Database,
  input: GetPendingUserInputQuestionInput,
): UserInputQuestionPrompt | null {
  const row = z.object({ prompt_json: nonEmpty }).nullable().parse(
    database
      .query(
        `SELECT i.prompt_json
         FROM interactions i JOIN tasks t ON t.task_id = i.task_id
         WHERE i.interaction_id = ? AND i.kind = 'user-input' AND i.state = 'pending'
           AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ? AND t.state = 'active'
           AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)`,
      )
      .get(
        requiredId(input.interactionId, "interactionId"),
        requiredId(input.workspaceId, "workspaceId"),
        requiredId(input.conversationId, "conversationId"),
        requiredId(input.threadTs, "threadTs"),
        requiredId(input.actorUserId, "actorUserId"),
      ),
  );
  if (row === null) return null;
  const prompt = userInputPromptSchema.safeParse(parseStoredJson(row.prompt_json));
  if (!prompt.success) return null;
  return prompt.data.questions.find((question) => question.id === input.questionId) ?? null;
}

export interface SubmitUserInputAnswerInput {
  readonly interactionId: string;
  readonly questionId: string;
  readonly selection: UserInputSelection;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly sourceActionId: string;
  readonly now: string;
}

/**
 * Durably records the answer to one question of a multi-question user-input request. The full
 * response is queued for T3 only once every question has an answer; until then each answer is kept
 * in `partial_response_json` and acknowledged in the Slack thread.
 */
export function submitUserInputAnswer(
  database: Database,
  input: SubmitUserInputAnswerInput,
): UserInputAnswerResult {
  const now = isoDateTime.parse(input.now);
  const actorUserId = requiredId(input.actorUserId, "actorUserId");
  const sourceActionId = requiredId(input.sourceActionId, "sourceActionId");
  const submit = database.transaction((): UserInputAnswerResult => {
    const row = z
      .object({
        interaction_id: nonEmpty,
        task_id: nonEmpty,
        response_command_id: nonEmpty,
        source_action_id: nonEmpty.nullable(),
        state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
        prompt_json: nonEmpty,
        partial_response_json: z.string().nullable(),
      })
      .nullable()
      .parse(
        database
          .query(
            `SELECT i.interaction_id, i.task_id, i.response_command_id, i.source_action_id, i.state,
                    i.prompt_json, i.partial_response_json
             FROM interactions i JOIN tasks t ON t.task_id = i.task_id
             WHERE i.interaction_id = ? AND i.kind = 'user-input'
               AND t.workspace_id = ? AND t.conversation_id = ? AND t.thread_ts = ? AND t.state = 'active'
               AND (t.conversation_type = 'channel' OR t.owner_user_id = ?)`,
          )
          .get(
            requiredId(input.interactionId, "interactionId"),
            requiredId(input.workspaceId, "workspaceId"),
            requiredId(input.conversationId, "conversationId"),
            requiredId(input.threadTs, "threadTs"),
            actorUserId,
          ),
      );
    if (row === null) return { kind: "denied" };
    const partial = partialUserInputSchema.parse(
      row.partial_response_json === null
        ? { answers: {}, sourceActionIds: [] }
        : parseStoredJson(row.partial_response_json),
    );
    if (
      row.state !== "pending" ||
      row.source_action_id === sourceActionId ||
      partial.sourceActionIds.includes(sourceActionId)
    ) {
      return { kind: "duplicate", commandId: row.response_command_id };
    }
    const prompt = userInputPromptSchema.parse(parseStoredJson(row.prompt_json));
    const question = prompt.questions.find((candidate) => candidate.id === input.questionId);
    if (question === undefined) return { kind: "invalid" };
    const answer = resolveUserInputAnswer(question, input.selection);
    if (answer === null) return { kind: "invalid" };

    const next = {
      answers: {
        ...partial.answers,
        [question.id]: { answer, actorUserId, sourceActionId, answeredAt: now },
      },
      sourceActionIds: [...partial.sourceActionIds, sourceActionId],
    };
    const unanswered = prompt.questions.filter((candidate) => next.answers[candidate.id] === undefined);
    const total = prompt.questions.length;
    const answered = total - unanswered.length;

    if (unanswered.length > 0) {
      database
        .query(
          `UPDATE interactions SET partial_response_json = ?, updated_at = ?
           WHERE interaction_id = ? AND state = 'pending'`,
        )
        .run(JSON.stringify(next), now, row.interaction_id);
      const remaining = unanswered.map((candidate) => candidate.header || candidate.question).join(", ");
      insertOutboxMessage(database, {
        outboxId: crypto.randomUUID(),
        taskId: row.task_id,
        correlationId: row.interaction_id,
        conversationId: input.conversationId,
        threadTs: input.threadTs,
        clientMessageId: `${row.interaction_id}:answer:${sourceActionId}`,
        payload: outboxPayloadSchema.parse({
          text: escapeSlackText(
            `Answer recorded for "${question.header || question.question}" (${answered} of ${total}). Still needed: ${remaining}.`,
          ),
        }),
        createdAt: now,
      });
      writeAudit(database, {
        actorType: "slack-user",
        actorId: actorUserId,
        authority: "interaction-response",
        source: sourceActionId,
        target: row.interaction_id,
        action: "interaction.user-input.answer-recorded",
        result: "pending",
        correlationId: row.interaction_id,
        metadata: { questionId: question.id, answered, total },
        createdAt: now,
      });
      return { kind: "partial", commandId: row.response_command_id, answered, total };
    }

    const answers = Object.fromEntries(
      prompt.questions.map((candidate) => [candidate.id, next.answers[candidate.id]?.answer]),
    );
    const contributors = [...new Set(Object.values(next.answers).map((entry) => entry.actorUserId))];
    const updated = database
      .query(
        `UPDATE interactions SET state = 'response-pending', response_json = ?, partial_response_json = ?,
           response_actor_id = ?, source_action_id = ?, updated_at = ?
         WHERE interaction_id = ? AND state = 'pending'`,
      )
      .run(
        JSON.stringify({ kind: "answer", answers, contributors }),
        JSON.stringify(next),
        actorUserId,
        sourceActionId,
        now,
        row.interaction_id,
      );
    if (updated.changes !== 1) return { kind: "duplicate", commandId: row.response_command_id };
    database
      .query("UPDATE operations SET blocked_until = NULL, updated_at = ? WHERE operation_id = (SELECT operation_id FROM interactions WHERE interaction_id = ?)")
      .run(now, row.interaction_id);
    writeAudit(database, {
      actorType: "slack-user",
      actorId: actorUserId,
      authority: "interaction-response",
      source: sourceActionId,
      target: row.interaction_id,
      action: "interaction.response.submitted",
      result: "response-pending",
      correlationId: row.interaction_id,
      metadata: { questionCount: total },
      createdAt: now,
    });
    return { kind: "accepted", commandId: row.response_command_id };
  });
  return submit.immediate();
}
