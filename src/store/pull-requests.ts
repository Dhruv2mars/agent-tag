// Draft PR workflow (PR-M): the task's pull request and the push/PR jobs recorded by completed turns.
// A job is inserted in the same transaction as the turn's final reply (see completeOperationWithOutbox);
// the PR worker claims jobs one task at a time, oldest first, and settles each with its Slack output.
import type { Database } from "bun:sqlite";

import { z } from "zod";

import { writeAudit } from "./audit.ts";
import { requiredId } from "./context.ts";
import { leaseExpiry, requireLeaseHeld } from "./lease.ts";
import { insertOutboxMessage } from "./outbox.ts";
import { type AuditAction, isoDateTime, nonEmpty, outboxIdentitySchema, outboxPayloadSchema } from "./schema.ts";
import type { SlackOutboxPayload } from "./types.ts";

/** Characters of the assistant reply kept as the PR body summary. */
export const MAX_PR_SUMMARY_CHARS = 4_000;
/** Characters of the Slack request kept for the PR title and commit subject. */
export const MAX_PR_REQUEST_CHARS = 1_000;

export type PullRequestState = "pending" | "open" | "closed" | "merged";

export interface TaskPullRequest {
  readonly taskId: string;
  readonly githubRepo: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly number: number | null;
  readonly url: string | null;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly lastPushedSha: string | null;
}

/** What a completed turn hands to the store for the PR workflow. */
export type PrSyncInput =
  | {
      readonly kind: "ready";
      readonly repo: string;
      readonly baseBranch: string;
      readonly branch: string;
      readonly sha: string;
      readonly mirrorRef: string;
      readonly aheadCount: number;
      readonly requestText: string;
      readonly summaryText: string;
    }
  | {
      /** The diff tripped a guard: no push. The notice is queued with the reply and the job is terminal. */
      readonly kind: "blocked";
      readonly repo: string;
      readonly baseBranch: string;
      readonly branch: string | null;
      readonly sha: string;
      readonly reason: "secret" | "size";
      readonly notice: string;
    }
  | {
      /** The snapshot failed. No job; the reply still posts, followed by a short context line. */
      readonly kind: "failed";
      readonly code: string;
      readonly notice: string;
    };

export interface ClaimedPrSyncJob {
  readonly jobId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly githubRepo: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly sha: string;
  readonly mirrorRef: string;
  readonly aheadCount: number;
  readonly requestText: string;
  readonly summaryText: string;
  readonly attempts: number;
}

export interface PrSyncJobRecord {
  readonly jobId: string;
  readonly operationId: string;
  readonly status: string;
  readonly resultCode: string | null;
  readonly attempts: number;
  readonly sha: string | null;
  readonly blockedUntil: string | null;
}

const taskPullRequestRowSchema = z.object({
  task_id: nonEmpty,
  github_repo: nonEmpty,
  head_branch: nonEmpty,
  base_branch: nonEmpty,
  pr_number: z.number().int().positive().nullable(),
  pr_url: z.string().nullable(),
  state: z.enum(["pending", "open", "closed", "merged"]),
  draft: z.union([z.literal(0), z.literal(1)]),
  last_pushed_sha: z.string().nullable(),
});

const claimedJobRowSchema = z.object({
  job_id: nonEmpty,
  task_id: nonEmpty,
  operation_id: nonEmpty,
  conversation_id: nonEmpty,
  thread_ts: nonEmpty,
  actor_user_id: nonEmpty,
  github_repo: nonEmpty,
  base_branch: nonEmpty,
  branch: nonEmpty,
  sha: nonEmpty,
  mirror_ref: nonEmpty,
  ahead_count: z.number().int().nonnegative(),
  request_text: z.string().nullable(),
  summary_text: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});

const jobRecordRowSchema = z.object({
  job_id: nonEmpty,
  operation_id: nonEmpty,
  status: nonEmpty,
  result_code: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  sha: z.string().nullable(),
  blocked_until: z.string().nullable(),
});

function truncate(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(0, max - 1).join("") + "…";
}

export function getTaskPullRequest(database: Database, taskId: string): TaskPullRequest | null {
  const row = taskPullRequestRowSchema.nullable().parse(
    database.query("SELECT * FROM task_pull_requests WHERE task_id = ?").get(requiredId(taskId, "taskId")),
  );
  if (row === null) return null;
  return {
    taskId: row.task_id,
    githubRepo: row.github_repo,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    number: row.pr_number,
    url: row.pr_url,
    state: row.state,
    draft: row.draft === 1,
    lastPushedSha: row.last_pushed_sha,
  };
}

export function listPrSyncJobs(database: Database, taskId: string): readonly PrSyncJobRecord[] {
  return database
    .query("SELECT * FROM pr_sync_jobs WHERE task_id = ? ORDER BY created_at, job_id")
    .all(requiredId(taskId, "taskId"))
    .map((row) => {
      const parsed = jobRecordRowSchema.parse(row);
      return {
        jobId: parsed.job_id,
        operationId: parsed.operation_id,
        status: parsed.status,
        resultCode: parsed.result_code,
        attempts: parsed.attempts,
        sha: parsed.sha,
        blockedUntil: parsed.blocked_until,
      };
    });
}

/** Queues one Slack message keyed by `clientMessageId` unless it already exists. Call inside a transaction. */
function enqueueOnce(
  database: Database,
  input: {
    readonly taskId: string;
    readonly correlationId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly clientMessageId: string;
    readonly payload: SlackOutboxPayload;
    readonly createdAt: string;
  },
): string {
  const prior = outboxIdentitySchema.nullable().parse(
    database.query("SELECT outbox_id FROM slack_outbox WHERE client_message_id = ?").get(input.clientMessageId),
  );
  if (prior !== null) return prior.outbox_id;
  const outboxId = crypto.randomUUID();
  insertOutboxMessage(database, {
    outboxId,
    taskId: input.taskId,
    correlationId: input.correlationId,
    conversationId: input.conversationId,
    threadTs: input.threadTs,
    clientMessageId: input.clientMessageId,
    payload: outboxPayloadSchema.parse(input.payload),
    createdAt: input.createdAt,
  });
  return outboxId;
}

/** A context line rendered under the reply. */
export function contextNotice(text: string): SlackOutboxPayload {
  return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] };
}

/**
 * Records the PR side of a completed turn. Runs inside completeOperationWithOutbox's transaction, after
 * the reply's outbox rows (`noticeAt` orders any notice after the last reply chunk). Idempotent per
 * operation: a replayed completion inserts no second job and no second notice.
 */
export function recordPrSync(
  database: Database,
  input: {
    readonly operationId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly conversationId: string;
    readonly threadTs: string;
    readonly actorUserId: string;
    readonly prSync: PrSyncInput;
    readonly now: string;
    readonly noticeAt: string;
  },
): void {
  const { prSync } = input;
  const base = {
    actorType: "worker",
    actorId: input.workerId,
    authority: "pull-request",
    source: input.operationId,
    correlationId: input.operationId,
    createdAt: input.now,
  } as const;
  if (prSync.kind === "failed") {
    const outboxId = enqueueOnce(database, {
      taskId: input.taskId,
      correlationId: input.operationId,
      conversationId: input.conversationId,
      threadTs: input.threadTs,
      clientMessageId: `${input.operationId}:pr-snapshot-failed`,
      payload: contextNotice(prSync.notice),
      createdAt: input.noticeAt,
    });
    writeAudit(database, {
      ...base,
      target: input.taskId,
      action: "pr.snapshot.failed",
      result: "failed",
      metadata: { code: prSync.code, outboxId },
    });
    return;
  }
  const jobId = crypto.randomUUID();
  const inserted = database
    .query(
      `INSERT INTO pr_sync_jobs (
        job_id, task_id, operation_id, conversation_id, thread_ts, actor_user_id, github_repo, base_branch,
        branch, sha, mirror_ref, ahead_count, request_text, summary_text, status, result_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING`,
    )
    .run(
      jobId,
      input.taskId,
      input.operationId,
      requiredId(input.conversationId, "conversationId"),
      requiredId(input.threadTs, "threadTs"),
      requiredId(input.actorUserId, "actorUserId"),
      requiredId(prSync.repo, "repo"),
      requiredId(prSync.baseBranch, "baseBranch"),
      prSync.branch,
      requiredId(prSync.sha, "sha"),
      prSync.kind === "ready" ? requiredId(prSync.mirrorRef, "mirrorRef") : null,
      prSync.kind === "ready" ? prSync.aheadCount : null,
      prSync.kind === "ready" ? truncate(prSync.requestText, MAX_PR_REQUEST_CHARS) : null,
      prSync.kind === "ready" ? truncate(prSync.summaryText, MAX_PR_SUMMARY_CHARS) : null,
      prSync.kind === "ready" ? "pending" : "blocked",
      prSync.kind === "ready" ? null : `blocked.${prSync.reason}`,
      input.now,
      input.now,
    );
  if (inserted.changes === 0) return;
  if (prSync.kind === "ready") {
    writeAudit(database, {
      ...base,
      target: jobId,
      action: "pr.sync.recorded",
      result: "pending",
      metadata: { sha: prSync.sha, aheadCount: prSync.aheadCount, repo: prSync.repo },
    });
    return;
  }
  const outboxId = enqueueOnce(database, {
    taskId: input.taskId,
    correlationId: input.operationId,
    conversationId: input.conversationId,
    threadTs: input.threadTs,
    clientMessageId: `${input.operationId}:pr-blocked`,
    payload: contextNotice(prSync.notice),
    createdAt: input.noticeAt,
  });
  writeAudit(database, {
    ...base,
    target: jobId,
    action: "pr.blocked",
    result: "denied",
    metadata: { reason: prSync.reason, sha: prSync.sha, outboxId },
  });
}

/**
 * Claims the oldest runnable job, one task at a time: a job waits while its task has a live in-flight job
 * or any older unfinished job (pending, awaiting approval, or in flight), mirroring the operation queue.
 * An in-flight job whose lease expired is reclaimed.
 */
export function claimNextPrSyncJob(
  database: Database,
  input: { readonly workerId: string; readonly leaseMs: number; readonly now: string },
): ClaimedPrSyncJob | null {
  const now = isoDateTime.parse(input.now);
  const workerId = requiredId(input.workerId, "workerId");
  const expiresAt = leaseExpiry(now, input.leaseMs);
  const claim = database.transaction((): ClaimedPrSyncJob | null => {
    const row = claimedJobRowSchema.nullable().parse(
      database
        .query(
          `SELECT j.job_id, j.task_id, j.operation_id, j.conversation_id, j.thread_ts, j.actor_user_id,
             j.github_repo, j.base_branch, j.branch, j.sha, j.mirror_ref, j.ahead_count, j.request_text,
             j.summary_text, j.attempts
           FROM pr_sync_jobs j
           WHERE ((j.status = 'pending' AND (j.blocked_until IS NULL OR j.blocked_until <= ?))
              OR (j.status = 'inflight' AND j.lease_expires_at <= ?))
             AND NOT EXISTS (
               SELECT 1 FROM pr_sync_jobs other
               WHERE other.task_id = j.task_id AND other.job_id <> j.job_id
                 AND ((other.status = 'inflight' AND other.lease_expires_at > ?)
                   OR (other.status IN ('pending', 'awaiting-approval', 'inflight')
                     AND (other.created_at < j.created_at
                       OR (other.created_at = j.created_at AND other.job_id < j.job_id))))
             )
           ORDER BY j.created_at, j.job_id
           LIMIT 1`,
        )
        .get(now, now, now),
    );
    if (row === null) return null;
    database
      .query(
        `UPDATE pr_sync_jobs SET status = 'inflight', lease_owner = ?, lease_expires_at = ?,
           attempts = attempts + 1, blocked_until = NULL, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(workerId, expiresAt, now, row.job_id);
    writeAudit(database, {
      actorType: "worker",
      actorId: workerId,
      authority: "pull-request",
      source: row.operation_id,
      target: row.job_id,
      action: "pr.job.claimed",
      result: "succeeded",
      correlationId: row.operation_id,
      metadata: { attempt: row.attempts + 1 },
      createdAt: now,
    });
    return {
      jobId: row.job_id,
      taskId: row.task_id,
      operationId: row.operation_id,
      conversationId: row.conversation_id,
      threadTs: row.thread_ts,
      actorUserId: row.actor_user_id,
      githubRepo: row.github_repo,
      baseBranch: row.base_branch,
      branch: row.branch,
      sha: row.sha,
      mirrorRef: row.mirror_ref,
      aheadCount: row.ahead_count,
      requestText: row.request_text ?? "",
      summaryText: row.summary_text ?? "",
      attempts: row.attempts + 1,
    };
  });
  return claim.immediate();
}

interface JobLease {
  readonly jobId: string;
  readonly workerId: string;
  readonly now: string;
}

function holdLease(database: Database, input: JobLease): void {
  const result = database
    .query(
      `UPDATE pr_sync_jobs SET updated_at = ?
       WHERE job_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
    )
    .run(input.now, requiredId(input.jobId, "jobId"), requiredId(input.workerId, "workerId"), input.now);
  requireLeaseHeld(result, "prSync");
}

/** Extends a held lease (before a slow push or API call). */
export function renewPrSyncJobLease(database: Database, input: JobLease & { readonly leaseMs: number }): void {
  const now = isoDateTime.parse(input.now);
  const result = database
    .query(
      `UPDATE pr_sync_jobs SET lease_expires_at = ?, updated_at = ?
       WHERE job_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
    )
    .run(leaseExpiry(now, input.leaseMs), now, input.jobId, input.workerId, now);
  requireLeaseHeld(result, "prSync");
}

/**
 * Records a successful push before any PR call, so the next snapshot guards only the new delta and a
 * crash between push and PR creation replays into "push is up to date, find or create the PR". The
 * remote head branch is fixed by the first push and never changes for the task.
 */
export function recordPrSyncPushed(
  database: Database,
  input: JobLease & {
    readonly taskId: string;
    readonly operationId: string;
    readonly repo: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly sha: string;
    readonly pushStatus: string;
  },
): void {
  const now = isoDateTime.parse(input.now);
  database.transaction(() => {
    holdLease(database, { ...input, now });
    database
      .query(
        `INSERT INTO task_pull_requests (
          task_id, github_repo, head_branch, base_branch, pr_number, pr_url, state, draft, last_pushed_sha,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'pending', 1, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET last_pushed_sha = excluded.last_pushed_sha, updated_at = excluded.updated_at`,
      )
      .run(input.taskId, input.repo, input.headBranch, input.baseBranch, input.sha, now, now);
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "pull-request",
      source: input.operationId,
      target: input.jobId,
      action: "pr.pushed",
      result: "succeeded",
      correlationId: input.operationId,
      metadata: { sha: input.sha, headBranch: input.headBranch, repo: input.repo, status: input.pushStatus },
      createdAt: now,
    });
  }).immediate();
}

export interface SettlePrSyncJobInput extends JobLease {
  readonly status: "succeeded" | "skipped" | "failed";
  readonly resultCode: string | null;
  /** The task's PR as now known (open after creation, or closed/merged when found so). */
  readonly pullRequest?: {
    readonly repo: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "closed" | "merged";
    readonly draft: boolean;
  };
  /** One Slack message, `${operationId}:${suffix}`, queued in the same transaction. */
  readonly message?: { readonly suffix: string; readonly payload: SlackOutboxPayload };
  readonly audit: {
    readonly action: AuditAction;
    readonly result: string;
    readonly metadata?: Record<string, string | number | boolean | null>;
  };
}

/** Ends a claimed job: job status, the task's PR row and the Slack output commit together. */
export function settlePrSyncJob(database: Database, input: SettlePrSyncJobInput): string | null {
  const now = isoDateTime.parse(input.now);
  return database.transaction((): string | null => {
    const job = z
      .object({ task_id: nonEmpty, operation_id: nonEmpty, conversation_id: nonEmpty, thread_ts: nonEmpty })
      .nullable()
      .parse(
        database
          .query("SELECT task_id, operation_id, conversation_id, thread_ts FROM pr_sync_jobs WHERE job_id = ?")
          .get(requiredId(input.jobId, "jobId")),
      );
    if (job === null) throw new Error("pull request job does not exist");
    const result = database
      .query(
        `UPDATE pr_sync_jobs SET status = ?, result_code = ?, lease_owner = NULL, lease_expires_at = NULL,
           blocked_until = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(input.status, input.resultCode, now, input.jobId, requiredId(input.workerId, "workerId"), now);
    requireLeaseHeld(result, "prSync");
    const pr = input.pullRequest;
    if (pr !== undefined) {
      database
        .query(
          `INSERT INTO task_pull_requests (
            task_id, github_repo, head_branch, base_branch, pr_number, pr_url, state, draft, last_pushed_sha,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET pr_number = excluded.pr_number, pr_url = excluded.pr_url,
            state = excluded.state, draft = excluded.draft, updated_at = excluded.updated_at`,
        )
        .run(job.task_id, pr.repo, pr.headBranch, pr.baseBranch, pr.number, pr.url, pr.state, pr.draft ? 1 : 0, now, now);
    }
    const outboxId =
      input.message === undefined
        ? null
        : enqueueOnce(database, {
            taskId: job.task_id,
            correlationId: job.operation_id,
            conversationId: job.conversation_id,
            threadTs: job.thread_ts,
            clientMessageId: `${job.operation_id}:${input.message.suffix}`,
            payload: input.message.payload,
            createdAt: now,
          });
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "pull-request",
      source: job.operation_id,
      target: input.jobId,
      action: input.audit.action,
      result: input.audit.result,
      correlationId: job.operation_id,
      metadata: { ...input.audit.metadata, resultCode: input.resultCode, outboxId },
      createdAt: now,
    });
    return outboxId;
  }).immediate();
}

/** Puts a claimed job back to pending until `blockedUntil` (retryable failure). */
export function retryPrSyncJob(
  database: Database,
  input: JobLease & { readonly errorCode: string; readonly blockedUntil: string },
): void {
  const now = isoDateTime.parse(input.now);
  const blockedUntil = isoDateTime.parse(input.blockedUntil);
  database.transaction(() => {
    const job = z.object({ operation_id: nonEmpty }).parse(
      database.query("SELECT operation_id FROM pr_sync_jobs WHERE job_id = ?").get(requiredId(input.jobId, "jobId")),
    );
    const result = database
      .query(
        `UPDATE pr_sync_jobs SET status = 'pending', result_code = ?, blocked_until = ?, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'inflight' AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(input.errorCode, blockedUntil, now, input.jobId, requiredId(input.workerId, "workerId"), now);
    requireLeaseHeld(result, "prSync");
    writeAudit(database, {
      actorType: "worker",
      actorId: input.workerId,
      authority: "pull-request",
      source: job.operation_id,
      target: input.jobId,
      action: "pr.job.retry-scheduled",
      result: "pending",
      correlationId: job.operation_id,
      metadata: { errorCode: input.errorCode, blockedUntil },
      createdAt: now,
    });
  }).immediate();
}

/** Returns a claimed job to pending without counting the attempt (shutdown). */
export function releasePrSyncJob(database: Database, input: JobLease): void {
  const now = isoDateTime.parse(input.now);
  database
    .query(
      `UPDATE pr_sync_jobs SET status = 'pending', attempts = MAX(attempts - 1, 0), lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ? AND status = 'inflight' AND lease_owner = ?`,
    )
    .run(now, requiredId(input.jobId, "jobId"), requiredId(input.workerId, "workerId"));
}
