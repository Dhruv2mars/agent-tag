import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { ambientDecisionSchema, isoDateTime, nonEmpty } from "./schema.ts";
import type { AmbientDecision } from "./types.ts";

export interface EvaluateAmbientInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly eventKey: string;
  readonly actorUserId: string;
  readonly text: string;
  readonly cooldownSeconds: number;
  readonly maxTurnsPerHour: number;
  readonly now: string;
}

export function evaluateAmbient(database: Database, input: EvaluateAmbientInput): AmbientDecision {
  const now = isoDateTime.parse(input.now);
  if (!Number.isSafeInteger(input.cooldownSeconds) || input.cooldownSeconds < 60) {
    throw new Error("ambient cooldown must be at least 60 seconds");
  }
  if (!Number.isSafeInteger(input.maxTurnsPerHour) || input.maxTurnsPerHour <= 0) {
    throw new Error("ambient hourly limit must be positive");
  }
  const workspaceId = requiredId(input.workspaceId, "workspaceId");
  const conversationId = requiredId(input.conversationId, "conversationId");
  const eventKey = requiredId(input.eventKey, "eventKey");
  const normalized = input.text.trim().replaceAll(/\s+/g, " ").toLowerCase();
  const fingerprint = createHash("sha256").update(normalized).digest("hex");
  const evaluate = database.transaction((): AmbientDecision => {
    const prior = ambientDecisionSchema.nullable().parse(
      database
        .query(
          "SELECT disposition, reason FROM ambient_decisions WHERE workspace_id = ? AND event_key = ?",
        )
        .get(workspaceId, eventKey),
    );
    if (prior !== null) {
      return prior.disposition === "triggered"
        ? { kind: "triggered" }
        : {
            kind: "quiet",
            reason: z.enum(["unchanged", "cooldown", "hourly-limit"]).parse(prior.reason),
          };
    }

    const last = z
      .object({ content_fingerprint: nonEmpty, created_at: isoDateTime })
      .nullable()
      .parse(
        database
          .query(
            `SELECT content_fingerprint, created_at FROM ambient_decisions
             WHERE workspace_id = ? AND conversation_id = ? AND disposition = 'triggered'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(workspaceId, conversationId),
      );
    const cutoff = new Date(new Date(now).getTime() - 3_600_000).toISOString();
    const count = database
      .query<{ count: number }, [string, string, string]>(
        `SELECT COUNT(*) AS count FROM ambient_decisions
         WHERE workspace_id = ? AND conversation_id = ? AND disposition = 'triggered' AND created_at > ?`,
      )
      .get(workspaceId, conversationId, cutoff)?.count;
    if (count === undefined) throw new Error("failed to count ambient turns");

    let decision: AmbientDecision = { kind: "triggered" };
    if (last?.content_fingerprint === fingerprint) {
      decision = { kind: "quiet", reason: "unchanged" };
    } else if (
      last !== null &&
      new Date(now).getTime() < new Date(last.created_at).getTime() + input.cooldownSeconds * 1_000
    ) {
      decision = { kind: "quiet", reason: "cooldown" };
    } else if (count >= input.maxTurnsPerHour) {
      decision = { kind: "quiet", reason: "hourly-limit" };
    }
    const disposition = decision.kind === "triggered" ? "triggered" : "quiet";
    const reason = decision.kind === "triggered" ? "relevant" : decision.reason;
    database
      .query(
        `INSERT INTO ambient_decisions (
          workspace_id, conversation_id, event_key, actor_user_id, content_fingerprint,
          disposition, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        conversationId,
        eventKey,
        requiredId(input.actorUserId, "actorUserId"),
        fingerprint,
        disposition,
        reason,
        now,
      );
    writeAudit(database, {
      actorType: "slack-user",
      actorId: input.actorUserId,
      authority: "ambient-policy",
      source: eventKey,
      target: conversationId,
      action: "ambient.decided",
      result: disposition,
      correlationId: eventKey,
      metadata: { reason },
      createdAt: now,
    });
    return decision;
  });
  return evaluate.immediate();
}
