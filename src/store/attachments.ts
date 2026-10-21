// Slack files in (PR-L1): what happened to each file ref of an operation's payload. Rows are written
// one per file, under the operation lease, as the coordinator attaches or skips it; a replay reads
// them back instead of downloading or uploading again. Metadata only, never file bytes.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { type T3Attachment, t3AttachmentSchema } from "../t3/gateway.ts";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId } from "./context.ts";
import { requireLeaseHeld } from "./lease.ts";
import { isoDateTime } from "./schema.ts";

/** Why a shared file was not attached. Stored as text, so later lanes may append reasons. */
export const INBOUND_SKIP_REASONS = [
  "disabled",
  "limit-count",
  "too-large",
  "external",
  "unavailable",
  "type-denied",
  "type-mismatch",
  "missing-scope",
  "download-failed",
] as const;
export type InboundSkipReason = (typeof INBOUND_SKIP_REASONS)[number];
const skipReasonSchema = z.enum(INBOUND_SKIP_REASONS);

export type OperationAttachment =
  | { readonly ordinal: number; readonly slackFileId: string; readonly state: "attached"; readonly attachment: T3Attachment }
  | { readonly ordinal: number; readonly slackFileId: string; readonly state: "skipped"; readonly reason: InboundSkipReason };

const rowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  slack_file_id: z.string().min(1),
  state: z.enum(["attached", "skipped"]),
  t3_attachment_json: z.string().nullable(),
  skip_reason: z.string().nullable(),
});

function toAttachment(raw: unknown): OperationAttachment {
  const row = rowSchema.parse(raw);
  if (row.state === "attached") {
    return {
      ordinal: row.ordinal,
      slackFileId: row.slack_file_id,
      state: "attached",
      attachment: t3AttachmentSchema.parse(JSON.parse(row.t3_attachment_json ?? "null")),
    };
  }
  return { ordinal: row.ordinal, slackFileId: row.slack_file_id, state: "skipped", reason: skipReasonSchema.parse(row.skip_reason) };
}

/** Recorded outcomes for an operation's files, by ordinal (position in `payload.files`). */
export function listOperationAttachments(database: Database, operationId: string): OperationAttachment[] {
  return database
    .query(
      `SELECT ordinal, slack_file_id, state, t3_attachment_json, skip_reason
       FROM operation_attachments WHERE operation_id = ? ORDER BY ordinal`,
    )
    .all(requiredId(operationId, "operationId"))
    .map(toAttachment);
}

export interface RecordOperationAttachmentInput {
  readonly operationId: string;
  readonly workerId: string;
  readonly ordinal: number;
  readonly slackFileId: string;
  readonly outcome: { readonly attachment: T3Attachment } | { readonly skipReason: InboundSkipReason };
  /** Lowercase extension of the file name, for the audit row (names are never audited). */
  readonly extension: string | null;
  /** Declared or downloaded size, for the audit row. */
  readonly sizeBytes: number | null;
  readonly now: string;
}

/**
 * Records one file's outcome. Requires the caller to hold the operation lease; a row already recorded
 * for the ordinal wins and is returned unchanged, so a racing replay cannot change an attached id.
 */
export function recordOperationAttachment(context: StoreContext, input: RecordOperationAttachmentInput): OperationAttachment {
  const { database, faultInjector } = context;
  const now = isoDateTime.parse(input.now);
  const operationId = requiredId(input.operationId, "operationId");
  const workerId = requiredId(input.workerId, "workerId");
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error("ordinal must be a non-negative integer");
  const attachment = "attachment" in input.outcome ? t3AttachmentSchema.parse(input.outcome.attachment) : null;
  const skipReason = "skipReason" in input.outcome ? skipReasonSchema.parse(input.outcome.skipReason) : null;
  const record = database.transaction(() => {
    const held = database
      .query(
        `SELECT 1 FROM operations
         WHERE operation_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .get(operationId, workerId, now);
    requireLeaseHeld({ changes: held === null ? 0 : 1 }, "operation");
    const inserted = database
      .query(
        `INSERT INTO operation_attachments (
          operation_id, ordinal, slack_file_id, state, t3_attachment_json, skip_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (operation_id, ordinal) DO NOTHING`,
      )
      .run(
        operationId,
        input.ordinal,
        requiredId(input.slackFileId, "slackFileId"),
        attachment === null ? "skipped" : "attached",
        attachment === null ? null : JSON.stringify(attachment),
        skipReason,
        now,
      );
    if (inserted.changes === 1) {
      writeAudit(database, {
        actorType: "worker",
        actorId: workerId,
        authority: "operation-dispatch",
        source: operationId,
        target: input.slackFileId,
        action: attachment === null ? "slack.file.skipped" : "slack.file.attached",
        result: attachment === null ? (skipReason ?? "skipped") : attachment.type,
        correlationId: operationId,
        metadata: {
          ordinal: input.ordinal,
          extension: input.extension,
          sizeBytes: input.sizeBytes,
          ...(attachment === null ? {} : { t3AttachmentId: attachment.id, mimeType: attachment.mimeType }),
        },
        createdAt: now,
      });
    }
    return toAttachment(
      database
        .query(
          `SELECT ordinal, slack_file_id, state, t3_attachment_json, skip_reason
           FROM operation_attachments WHERE operation_id = ? AND ordinal = ?`,
        )
        .get(operationId, input.ordinal),
    );
  });
  const recorded = record.immediate();
  // After the commit: a crash here leaves the row durable but the turn not yet started.
  faultInjector("attachment.after-record");
  return recorded;
}
