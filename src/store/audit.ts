// Append-only audit log: the single writer used by every module, and paged export.
import type { Database } from "bun:sqlite";

import { redactAuditMetadata } from "../security/redact.ts";
import { requiredId, parseStoredJson } from "./context.ts";
import {
  type AuditAction,
  auditActionSchema,
  auditMetadataSchema,
  auditRowSchema,
  auditWriteSchema,
  isoDateTime,
} from "./schema.ts";
import type { AuditCursor, AuditRecord } from "./types.ts";

export function writeAudit(
  database: Database,
  input: {
    readonly actorType: string;
    readonly actorId: string;
    readonly authority: string;
    readonly source: string;
    readonly target: string;
    readonly action: AuditAction;
    readonly result: string;
    readonly correlationId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
    readonly createdAt: string;
  },
): void {
  const record = auditWriteSchema.parse({ ...input, metadata: redactAuditMetadata(input.metadata) });
  database
    .query(
      `INSERT INTO audit_log (
        audit_id, actor_type, actor_id, authority, source, target, action, result,
        correlation_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      record.actorType,
      record.actorId,
      record.authority,
      record.source,
      record.target,
      record.action,
      record.result,
      record.correlationId,
      JSON.stringify(record.metadata),
      record.createdAt,
    );
}

export interface ListAuditRecordsInput {
  readonly after?: AuditCursor;
  readonly limit?: number;
}

export function listAuditRecords(
  database: Database,
  input: ListAuditRecordsInput = {},
): ReadonlyArray<AuditRecord> {
  const limit = input.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("audit export limit must be between 1 and 10000");
  }
  const afterCreatedAt = input.after === undefined
    ? "0000-01-01T00:00:00.000Z"
    : isoDateTime.parse(input.after.createdAt);
  const afterAuditId = input.after === undefined ? "" : requiredId(input.after.auditId, "auditId");
  return database
    .query(
      `SELECT audit_id, actor_type, actor_id, authority, source, target, action, result,
              correlation_id, metadata_json, created_at
       FROM audit_log
       WHERE created_at > ? OR (created_at = ? AND audit_id > ?)
       ORDER BY created_at, audit_id LIMIT ?`,
    )
    .all(afterCreatedAt, afterCreatedAt, afterAuditId, limit)
    .map((raw) => {
      const row = auditRowSchema.parse(raw);
      return {
        auditId: row.audit_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        authority: row.authority,
        source: row.source,
        target: row.target,
        action: auditActionSchema.parse(row.action),
        result: row.result,
        correlationId: row.correlation_id,
        metadata: auditMetadataSchema.parse(parseStoredJson(row.metadata_json)),
        createdAt: row.created_at,
      };
    });
}
