// Slack files out (PR-L2): one slack_file_uploads row per upload directive of a completed turn. Rows are
// inserted in the completion transaction, after the reply's outbox rows, and the upload worker
// (src/slack/uploads.ts) claims one at a time once the reply it follows has settled. Metadata only:
// file bytes are read from the thread's worktree at delivery time and never touch SQLite.
import type { Database } from "bun:sqlite";
import { extname } from "node:path";
import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { type StoreContext, requiredId } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { contextNotice, enqueueOnce } from "./pull-requests.ts";
import { isoDateTime, nonEmpty } from "./schema.ts";

/** A validated workspace-relative path and optional title from an upload directive. */
export interface FileUploadRequest {
  readonly path: string;
  readonly title: string | null;
}

/** The upload side of a completed turn, recorded by completeOperationWithOutbox. */
export interface FileUploadsInput {
  /** The T3 thread that wrote the files (diagnostics). */
  readonly t3ThreadId: string;
  /** The thread's worktree (absolute); every path is relative to it. */
  readonly workspaceRoot: string;
  readonly requests: readonly FileUploadRequest[];
  /** One thread notice for directives that were not queued (bad path, over the limit); null when none. */
  readonly rejectedNotice: string | null;
}

export interface ClaimedFileUpload {
  readonly uploadId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly t3ThreadId: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly title: string | null;
  /** Set once Slack handed out an upload URL: the file may already be shared (see uploads.ts). */
  readonly slackFileId: string | null;
  /** Claims so far, including this one. */
  readonly attempts: number;
}

const claimedRowSchema = z.object({
  upload_id: nonEmpty,
  task_id: nonEmpty,
  operation_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  t3_thread_id: nonEmpty,
  workspace_root: nonEmpty,
  workspace_path: nonEmpty,
  title: z.string().nullable(),
  slack_file_id: z.string().nullable(),
  attempts: z.number().int().positive(),
});

/** Lowercase extension for audit rows: names are agent-chosen and may be sensitive, so only this is kept. */
function auditExtension(path: string): string | null {
  const extension = extname(path).slice(1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : null;
}

/**
 * Records the uploads of a completed turn. Runs inside completeOperationWithOutbox's transaction:
 * `afterOutboxId` is the reply's last chunk, so no file is shared before the text it belongs to, and
 * `noticeAt` orders the rejected-directive notice after it. Idempotent per operation and path.
 */
export function recordFileUploads(
  database: Database,
  input: {
    readonly operationId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly uploads: FileUploadsInput;
    readonly afterOutboxId: string;
    readonly now: string;
    readonly noticeAt: string;
  },
): void {
  const t3ThreadId = requiredId(input.uploads.t3ThreadId, "t3ThreadId");
  const workspaceRoot = requiredId(input.uploads.workspaceRoot, "workspaceRoot");
  for (const [ordinal, request] of input.uploads.requests.entries()) {
    const uploadId = crypto.randomUUID();
    const inserted = database
      .query(
        `INSERT INTO slack_file_uploads (
          upload_id, task_id, operation_id, ordinal, conversation_id, thread_ts, t3_thread_id,
          workspace_root, workspace_path, title, after_outbox_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT DO NOTHING`,
      )
      .run(
        uploadId,
        input.taskId,
        input.operationId,
        ordinal,
        requiredId(input.conversationId, "conversationId"),
        requiredId(input.threadTs, "threadTs"),
        t3ThreadId,
        workspaceRoot,
        requiredId(request.path, "path"),
        request.title,
        input.afterOutboxId,
        input.now,
        input.now,
      );
    if (inserted.changes === 0) continue;
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "slack-write",
      source: input.operationId,
      target: uploadId,
      action: "slack.file.upload-queued",
      result: "pending",
      correlationId: input.operationId,
      metadata: { ordinal, extension: auditExtension(request.path) },
      createdAt: input.now,
    });
  }
  if (input.uploads.rejectedNotice !== null) {
    enqueueOnce(database, {
      taskId: input.taskId,
      correlationId: input.operationId,
      conversationId: input.conversationId,
      threadTs: input.threadTs,
      clientMessageId: `${input.operationId}:uploads-rejected`,
      payload: contextNotice(input.uploads.rejectedNotice),
      createdAt: input.noticeAt,
    });
  }
}

/**
 * Claims the oldest runnable upload: pending and past its backoff, or in flight with an expired lease.
 * A row waits while the reply it follows (`after_outbox_id`) is still pending or in flight, so files
 * land under the text; a reply that failed does not hold its files back.
 */
export function claimNextFileUpload(
  context: StoreContext,
  input: { readonly workerId: string; readonly now: string; readonly leaseMs: number },
): ClaimedFileUpload | null {
  const { database } = context;
  const workerId = requiredId(input.workerId, "workerId");
  const now = isoDateTime.parse(input.now);
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedFileUpload | null => {
    const candidate = z.object({ upload_id: nonEmpty }).nullable().parse(
      database
        .query(
          `SELECT upload.upload_id FROM slack_file_uploads AS upload
           WHERE (
               (upload.state = 'pending' AND (upload.blocked_until IS NULL OR julianday(upload.blocked_until) <= julianday(?)))
               OR (upload.state = 'inflight' AND julianday(upload.lease_expires_at) <= julianday(?))
             )
             AND NOT EXISTS (
               SELECT 1 FROM slack_outbox AS reply
               WHERE reply.outbox_id = upload.after_outbox_id AND reply.status IN ('pending', 'inflight')
             )
           ORDER BY upload.created_at, upload.operation_id, upload.ordinal
           LIMIT 1`,
        )
        .get(now, now) ?? null,
    );
    if (candidate === null) return null;
    database
      .query(
        `UPDATE slack_file_uploads SET state = 'inflight', attempts = attempts + 1, blocked_until = NULL,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE upload_id = ?`,
      )
      .run(workerId, expiresAt, now, candidate.upload_id);
    const row = claimedRowSchema.parse(
      database
        .query(
          `SELECT upload_id, task_id, operation_id, conversation_id, thread_ts, t3_thread_id, workspace_root,
                  workspace_path, title, slack_file_id, attempts
           FROM slack_file_uploads WHERE upload_id = ?`,
        )
        .get(candidate.upload_id),
    );
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "slack-write",
      source: row.upload_id,
      target: row.conversation_id,
      action: "slack.file.upload-claimed",
      result: "inflight",
      correlationId: row.operation_id,
      metadata: { attempt: row.attempts, resumed: row.slack_file_id !== null },
      createdAt: now,
    });
    return {
      uploadId: row.upload_id,
      taskId: row.task_id,
      operationId: row.operation_id,
      conversationId: row.conversation_id,
      threadTs: row.thread_ts,
      t3ThreadId: row.t3_thread_id,
      workspaceRoot: row.workspace_root,
      path: row.workspace_path,
      title: row.title,
      slackFileId: row.slack_file_id,
      attempts: row.attempts,
    };
  });
  return claim.immediate();
}

interface LeaseInput {
  readonly uploadId: string;
  readonly workerId: string;
  readonly now: string;
}

function updateLeased(database: Database, input: LeaseInput, set: string, values: readonly (string | null)[]): void {
  const now = isoDateTime.parse(input.now);
  const result = database
    .query(
      `UPDATE slack_file_uploads SET ${set}, updated_at = ?
       WHERE upload_id = ? AND state = 'inflight' AND lease_owner = ? AND julianday(lease_expires_at) > julianday(?)`,
    )
    .run(...values, now, requiredId(input.uploadId, "uploadId"), requiredId(input.workerId, "workerId"), now);
  requireLeaseHeld(result, "fileUpload");
}

/** Persists the Slack file id before any byte is sent: the anchor a retry checks for a finished share. */
export function markFileUploadStarted(database: Database, input: LeaseInput & { readonly slackFileId: string }): void {
  updateLeased(database, input, "slack_file_id = ?", [requiredId(input.slackFileId, "slackFileId")]);
}

/** Forgets a Slack file id whose upload never completed, so the next attempt starts a fresh one. */
export function clearFileUploadStart(database: Database, input: LeaseInput): void {
  updateLeased(database, input, "slack_file_id = NULL", []);
}

export function markFileUploadDelivered(database: Database, input: LeaseInput & { readonly slackFileId: string }): void {
  const deliver = database.transaction(() => {
    updateLeased(
      database,
      input,
      "state = 'delivered', slack_file_id = ?, error_code = NULL, lease_owner = NULL, lease_expires_at = NULL",
      [requiredId(input.slackFileId, "slackFileId")],
    );
    audit(database, input, "slack.file.upload-delivered", "delivered", {});
  });
  deliver.immediate();
}

/** Back to pending until `blockedUntil`; the error code is kept for diagnostics. */
export function retryFileUpload(
  database: Database,
  input: LeaseInput & { readonly errorCode: string; readonly blockedUntil: string },
): void {
  const retry = database.transaction(() => {
    updateLeased(
      database,
      input,
      "state = 'pending', blocked_until = ?, error_code = ?, lease_owner = NULL, lease_expires_at = NULL",
      [isoDateTime.parse(input.blockedUntil), requiredId(input.errorCode, "errorCode")],
    );
    audit(database, input, "slack.file.upload-retry-scheduled", input.errorCode, { blockedUntil: input.blockedUntil });
  });
  retry.immediate();
}

/** The service is stopping: hand the row back without counting the attempt. */
export function releaseFileUpload(database: Database, input: LeaseInput): void {
  updateLeased(database, input, "state = 'pending', attempts = MAX(attempts - 1, 0), lease_owner = NULL, lease_expires_at = NULL", []);
}

/**
 * Fails the upload for good. `notice` (already escaped mrkdwn) goes to the thread once; `blocked`
 * records a secret-gate refusal, with the credential classes found but never the content.
 */
export function failFileUpload(
  database: Database,
  input: LeaseInput & {
    readonly errorCode: string;
    readonly notice: string | null;
    readonly secretClasses?: readonly string[];
  },
): void {
  const now = isoDateTime.parse(input.now);
  const fail = database.transaction(() => {
    updateLeased(
      database,
      input,
      "state = 'failed', error_code = ?, lease_owner = NULL, lease_expires_at = NULL",
      [requiredId(input.errorCode, "errorCode")],
    );
    const row = z
      .object({ task_id: nonEmpty, operation_id: nonEmpty, conversation_id: nonEmpty, thread_ts: nonEmpty })
      .parse(
        database
          .query("SELECT task_id, operation_id, conversation_id, thread_ts FROM slack_file_uploads WHERE upload_id = ?")
          .get(input.uploadId),
      );
    const outboxId = input.notice === null
      ? null
      : enqueueOnce(database, {
        taskId: row.task_id,
        correlationId: row.operation_id,
        conversationId: row.conversation_id,
        threadTs: row.thread_ts,
        clientMessageId: `${input.uploadId}:failed`,
        payload: contextNotice(input.notice),
        createdAt: now,
      });
    if (input.secretClasses !== undefined) {
      audit(database, input, "slack.file.upload-blocked", input.errorCode, { classes: input.secretClasses.join(",") });
    }
    audit(database, input, "slack.file.upload-failed", input.errorCode, { noticeOutboxId: outboxId });
  });
  fail.immediate();
}

function audit(
  database: Database,
  input: LeaseInput,
  action: "slack.file.upload-blocked" | "slack.file.upload-delivered" | "slack.file.upload-failed" | "slack.file.upload-retry-scheduled",
  result: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): void {
  const row = z
    .object({ operation_id: nonEmpty, conversation_id: nonEmpty, workspace_path: nonEmpty, attempts: z.number().int() })
    .parse(
      database
        .query("SELECT operation_id, conversation_id, workspace_path, attempts FROM slack_file_uploads WHERE upload_id = ?")
        .get(input.uploadId),
    );
  writeAudit(database, {
    actorType: "worker",
    actorId: input.workerId,
    authority: "slack-write",
    source: input.uploadId,
    target: row.conversation_id,
    action,
    result,
    correlationId: row.operation_id,
    metadata: { ...metadata, attempt: row.attempts, extension: auditExtension(row.workspace_path) },
    createdAt: isoDateTime.parse(input.now),
  });
}
