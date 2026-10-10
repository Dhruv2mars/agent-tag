// Interaction cards: the approval/question message in Slack, re-rendered from current state on every
// state change. Each transition enqueues one refresh of the card's prompt post (`${id}:prompt`) in the
// same transaction; the refresh renders at delivery time (see message-edits.ts), so a card never
// shows an older state than the store.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { parseStoredJson, requiredId } from "./context.ts";
import { enqueueMessageRefresh } from "./message-edits.ts";
import { isoDateTime, nonEmpty, partialUserInputSchema } from "./schema.ts";

export type InteractionCardState = "pending" | "response-pending" | "inflight" | "resolved" | "failed";

export interface InteractionCardView {
  readonly interactionId: string;
  readonly kind: "approval" | "user-input";
  /** As stored: a T3PendingApproval or T3PendingUserInput. */
  readonly prompt: unknown;
  readonly state: InteractionCardState;
  /** `expired`, `resolved-elsewhere`, `operation-settled`, or a worker failure code. */
  readonly lastErrorCode: string | null;
  readonly retriesExhausted: boolean;
  /** `{decision}`, `{kind:"answer", answers, contributors}` or `{kind:"dismiss"}`. */
  readonly response: unknown | null;
  readonly responseActorId: string | null;
  readonly partial: z.infer<typeof partialUserInputSchema> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Recorded when T3 stopped reporting a request nobody answered in Slack (answered in the T3 UI). */
export const RESOLVED_ELSEWHERE = "resolved-elsewhere";

const cardRowSchema = z.object({
  interaction_id: nonEmpty,
  kind: z.enum(["approval", "user-input"]),
  prompt_json: nonEmpty,
  state: z.enum(["pending", "response-pending", "inflight", "resolved", "failed"]),
  last_error_code: z.string().nullable(),
  retries_exhausted: z.number().int(),
  response_json: z.string().nullable(),
  response_actor_id: z.string().nullable(),
  partial_response_json: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});

/** The card's current state; null for unknown ids and cancel interactions (they have no card). */
export function getInteractionCardView(database: Database, interactionId: string): InteractionCardView | null {
  const row = cardRowSchema.nullable().parse(
    database
      .query(
        `SELECT interaction_id, kind, prompt_json, state, last_error_code, retries_exhausted, response_json,
                response_actor_id, partial_response_json, created_at, updated_at
         FROM interactions WHERE interaction_id = ? AND kind IN ('approval', 'user-input')`,
      )
      .get(requiredId(interactionId, "interactionId")),
  );
  if (row === null) return null;
  const partial = row.partial_response_json === null
    ? null
    : partialUserInputSchema.safeParse(parseStoredJson(row.partial_response_json));
  return {
    interactionId: row.interaction_id,
    kind: row.kind,
    prompt: parseStoredJson(row.prompt_json),
    state: row.state,
    lastErrorCode: row.last_error_code,
    retriesExhausted: row.retries_exhausted === 1,
    response: row.response_json === null ? null : parseStoredJson(row.response_json),
    responseActorId: row.response_actor_id,
    partial: partial?.success === true ? partial.data : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ensures one pending re-render of the interaction's card. Runs inside the caller's transaction. A
 * no-op returning false for interactions without a card (cancel) or whose card post failed.
 */
export function enqueueInteractionCardRefresh(database: Database, interactionId: string, now: string): boolean {
  return enqueueMessageRefresh(database, {
    targetClientMessageId: `${requiredId(interactionId, "interactionId")}:prompt`,
    refreshKind: "interaction-card",
    refreshKey: interactionId,
    now,
  }) !== null;
}

export interface ReconcileThreadInteractionsInput {
  readonly threadId: string;
  /** Every approval and question T3 currently reports as pending on the thread. */
  readonly pending: ReadonlyArray<{ readonly requestId: string; readonly kind: "approval" | "user-input" }>;
  readonly now: string;
}

/**
 * Closes the thread's approvals and questions that still await a human in Slack (`pending`) but that
 * T3 no longer reports: they were answered or cancelled outside Slack. Each becomes `resolved` with
 * `resolved-elsewhere`, is audited, and gets a card refresh, so its buttons stop looking live. Rows
 * with a Slack response (response-pending, inflight) are untouched: T3 resolving them is the expected
 * result of our own command. Returns how many were closed.
 */
export function reconcileThreadInteractions(database: Database, input: ReconcileThreadInteractionsInput): number {
  const threadId = requiredId(input.threadId, "threadId");
  const now = isoDateTime.parse(input.now);
  const reported = new Set(input.pending.map((request) => `${request.kind}:${request.requestId}`));
  const reconcile = database.transaction((): number => {
    const open = z
      .array(z.object({ interaction_id: nonEmpty, operation_id: nonEmpty, request_id: nonEmpty, kind: z.enum(["approval", "user-input"]) }))
      .parse(
        database
          .query(
            `SELECT interaction_id, operation_id, request_id, kind FROM interactions
             WHERE thread_id = ? AND kind IN ('approval', 'user-input') AND state = 'pending'
             ORDER BY created_at, interaction_id`,
          )
          .all(threadId),
      );
    let closed = 0;
    for (const row of open) {
      if (reported.has(`${row.kind}:${row.request_id}`)) continue;
      const result = database
        .query(
          `UPDATE interactions SET state = 'resolved', last_error_code = ?, updated_at = ?
           WHERE interaction_id = ? AND state = 'pending'`,
        )
        .run(RESOLVED_ELSEWHERE, now, row.interaction_id);
      if (result.changes !== 1) continue;
      closed += 1;
      writeAudit(database, {
        actorType: "provider",
        actorId: "t3",
        authority: "interaction-request",
        source: row.request_id,
        target: row.interaction_id,
        action: "interaction.resolved-elsewhere",
        result: "resolved",
        correlationId: row.operation_id,
        metadata: { kind: row.kind },
        createdAt: now,
      });
      enqueueInteractionCardRefresh(database, row.interaction_id, now);
    }
    return closed;
  });
  return reconcile.immediate();
}
