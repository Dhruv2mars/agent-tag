// PR worker of the draft PR workflow (PR-M §3.7). Claims one job per task at a time and, working only on
// the Agent Tag-owned mirror (never the task worktree), pushes the recorded SHA with Agent Tag's own
// credential, finds or creates the task's single draft PR, and queues the card or a "pushed" line.
// Exactly once: jobs are keyed by operation, Slack ids are stable, the push is idempotent for one SHA,
// and PR creation is find-by-head first (plus GitHub's 422 "already exists" path in the client).
import { join } from "node:path";

import {
  type AgentTagConfig,
  type EnabledPullRequestsConfig,
  pullRequestRepositoryFor,
} from "../config.ts";
import { GitHubCredentialError, githubCredentialsFromConfig, type GitHubCredentials } from "../github/auth.ts";
import {
  createGitHubClient,
  GitHubApiError,
  type GitHubClient,
  type GitHubPull,
  pullRequestBody,
  pullRequestTitle,
} from "../github/client.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "../policy/execution.ts";
import {
  pullRequestCard,
  pullRequestClosedNotice,
  pullRequestFailedNotice,
  pullRequestPushedLine,
  pushRejectedNotice,
} from "../slack/pr-card.ts";
import type { AgentTagStore, ClaimedPrSyncJob, TaskPullRequest } from "../store/store.ts";
import { ensureAskpassScript, githubRemoteUrl, PushError, pushToRemote } from "./push.ts";
import { createGitRunner, GitError, type GitRunner } from "./runner.ts";
import { mirrorPathFor } from "./snapshot.ts";

export type PrWorkerOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "created"; readonly jobId: string; readonly number: number }
  | { readonly kind: "pushed"; readonly jobId: string; readonly number: number }
  | { readonly kind: "skipped"; readonly jobId: string; readonly code: string }
  | { readonly kind: "retry-scheduled"; readonly jobId: string; readonly code: string; readonly blockedUntil: string }
  | { readonly kind: "failed"; readonly jobId: string; readonly code: string }
  | { readonly kind: "released"; readonly jobId: string };

export interface PrRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Claims (including the first) before the job fails with a notice. */
  readonly maxAttempts: number;
}

/** 30s × 2^n, six attempts (PR-M §3.4). */
export const DEFAULT_PR_RETRY_POLICY: PrRetryPolicy = { baseDelayMs: 30_000, maxDelayMs: 30 * 60_000, maxAttempts: 6 };

export interface PrWorkerOptions {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly github?: GitHubClient;
  readonly credentials?: GitHubCredentials;
  readonly runner?: GitRunner;
  /** `<dataDir>/git` by default: mirrors and the askpass script. */
  readonly gitRoot?: string;
  /** Tests only: push to a local bare repo instead of `{webBaseUrl}/{repo}.git`. */
  readonly testRemoteUrlFor?: (repo: string) => string;
  /** Slack permalink of the thread for the PR body; the fallback is `conversationId/threadTs`. */
  readonly threadLink?: (conversationId: string, threadTs: string) => Promise<string | undefined>;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly retry?: PrRetryPolicy;
  readonly now?: () => Date;
}

/** Whether any profile has the draft PR workflow on (the service registers the worker only then). */
export function pullRequestsEnabled(config: AgentTagConfig): boolean {
  return config.github !== undefined && config.profiles.some((profile) => profile.pullRequests.mode !== "off");
}

/** A decided end for the job, with or without Slack output. */
class JobSettled extends Error {
  constructor(
    readonly code: string,
    readonly terminal: "skipped" | "failed",
    readonly notice: string | undefined,
  ) {
    super(code);
  }
}

function failureNotice(error: unknown): { readonly code: string; readonly retryable: boolean; readonly retryAfterMs?: number; readonly notice: string } {
  if (error instanceof GitHubApiError) {
    const notice =
      error.kind === "auth"
        ? "GitHub credential rejected; the operator must fix `github.auth`."
        : error.kind === "not-found"
          ? "the repository was not found or is not granted to the credential."
          : `GitHub returned an error (${error.code}).`;
    return {
      code: error.code,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      notice,
    };
  }
  if (error instanceof PushError) {
    const notice =
      error.code === "push.auth"
        ? "GitHub credential rejected for git push; the operator must fix `github.auth`."
        : error.code === "push.not-found"
          ? "the repository was not found or is not granted to the credential."
          : `git push failed (${error.code}).`;
    return { code: error.code, retryable: error.retryable, notice };
  }
  if (error instanceof GitHubCredentialError) {
    return { code: error.code, retryable: false, notice: "the GitHub credential file is unusable; the operator must fix `github.auth`." };
  }
  if (error instanceof GitError) {
    return { code: error.code, retryable: error.code === "git.timeout", notice: `git failed (${error.code}).` };
  }
  return { code: error instanceof Error && error.name ? error.name : "PrWorkerError", retryable: true, notice: "an unexpected error occurred." };
}

export class PrWorker {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #github: GitHubClient | undefined;
  readonly #credentials: GitHubCredentials | undefined;
  readonly #runner: GitRunner;
  readonly #gitRoot: string;
  readonly #testRemoteUrlFor: ((repo: string) => string) | undefined;
  readonly #threadLink: PrWorkerOptions["threadLink"];
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #retry: PrRetryPolicy;
  readonly #now: () => Date;

  constructor(options: PrWorkerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    const github = options.config.github;
    this.#credentials = options.credentials ?? (github === undefined ? undefined : githubCredentialsFromConfig(github));
    this.#github =
      options.github ??
      (github === undefined || this.#credentials === undefined
        ? undefined
        : createGitHubClient({ apiBaseUrl: github.apiBaseUrl, credentials: this.#credentials }));
    this.#runner = options.runner ?? createGitRunner();
    this.#gitRoot = options.gitRoot ?? join(options.config.dataDir, "git");
    this.#testRemoteUrlFor = options.testRemoteUrlFor;
    this.#threadLink = options.threadLink;
    this.#workerId = options.workerId ?? `pr-${crypto.randomUUID()}`;
    this.#leaseMs = options.leaseMs ?? 180_000;
    this.#retry = options.retry ?? DEFAULT_PR_RETRY_POLICY;
    this.#now = options.now ?? (() => new Date());
  }

  async processNext(signal?: AbortSignal): Promise<PrWorkerOutcome> {
    const job = this.#store.claimNextPrSyncJob({
      workerId: this.#workerId,
      leaseMs: this.#leaseMs,
      now: this.#now().toISOString(),
    });
    if (job === null) return { kind: "idle" };
    try {
      return await this.#process(job, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        this.#store.releasePrSyncJob({ jobId: job.jobId, workerId: this.#workerId, now: this.#now().toISOString() });
        return { kind: "released", jobId: job.jobId };
      }
      if (error instanceof JobSettled) {
        this.#settleWithNotice(job, error.terminal, error.code, error.notice);
        return error.terminal === "skipped"
          ? { kind: "skipped", jobId: job.jobId, code: error.code }
          : { kind: "failed", jobId: job.jobId, code: error.code };
      }
      const failure = failureNotice(error);
      if (failure.retryable && job.attempts < this.#retry.maxAttempts) {
        const backoff = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** Math.max(0, job.attempts - 1));
        const blockedUntil = new Date(this.#now().getTime() + Math.max(backoff, failure.retryAfterMs ?? 0)).toISOString();
        this.#store.retryPrSyncJob({
          jobId: job.jobId,
          workerId: this.#workerId,
          errorCode: failure.code,
          blockedUntil,
          now: this.#now().toISOString(),
        });
        return { kind: "retry-scheduled", jobId: job.jobId, code: failure.code, blockedUntil };
      }
      const notice = failure.retryable ? `${failure.notice} Gave up after ${job.attempts} attempts.` : failure.notice;
      this.#settleWithNotice(job, "failed", failure.code, notice);
      return { kind: "failed", jobId: job.jobId, code: failure.code };
    }
  }

  #settleWithNotice(job: ClaimedPrSyncJob, status: "skipped" | "failed", code: string, notice: string | undefined): void {
    this.#store.settlePrSyncJob({
      jobId: job.jobId,
      workerId: this.#workerId,
      status,
      resultCode: code,
      ...(notice === undefined
        ? {}
        : { message: { suffix: status === "failed" ? "pr-failed" : "pr-skipped", payload: pullRequestFailedNotice(notice) } }),
      audit: {
        action: code === "pr.authority" || code === "pr.disabled" ? "pr.skipped.authority" : "pr.failed",
        result: status === "skipped" ? "skipped" : "failed",
      },
      now: this.#now().toISOString(),
    });
  }

  #renew(job: ClaimedPrSyncJob): void {
    this.#store.renewPrSyncJobLease({
      jobId: job.jobId,
      workerId: this.#workerId,
      leaseMs: this.#leaseMs,
      now: this.#now().toISOString(),
    });
  }

  /** Current config still authorizes the request and still maps the task's root to the job's repo. */
  #authorize(job: ClaimedPrSyncJob): EnabledPullRequestsConfig {
    let profile: AgentTagConfig["profiles"][number];
    try {
      profile = requireExecutionAuthority({
        config: this.#config,
        task: this.#store.getTaskExecution(job.taskId),
        actorUserId: job.actorUserId,
      });
    } catch (error) {
      if (error instanceof ExecutionAuthorityDenied) throw new JobSettled("pr.authority", "skipped", undefined);
      throw error;
    }
    const pullRequests = profile.pullRequests;
    const repository = pullRequestRepositoryFor(profile, this.#store.getTaskExecution(job.taskId).repositoryRoot);
    if (
      pullRequests.mode !== "auto" ||
      this.#config.github === undefined ||
      repository?.repo !== job.githubRepo
    ) {
      throw new JobSettled("pr.disabled", "skipped", undefined);
    }
    return pullRequests;
  }

  async #process(job: ClaimedPrSyncJob, signal: AbortSignal | undefined): Promise<PrWorkerOutcome> {
    const settings = this.#authorize(job);
    const github = this.#github;
    const credentials = this.#credentials;
    const webBaseUrl = this.#config.github?.webBaseUrl;
    if (github === undefined || credentials === undefined || webBaseUrl === undefined) {
      throw new JobSettled("pr.disabled", "skipped", undefined);
    }
    const existing = this.#store.getTaskPullRequest(job.taskId);
    if (existing !== null && existing.githubRepo !== job.githubRepo) {
      throw new JobSettled("pr.repo-changed", "skipped", "this thread's PR is on a different repository than the current config.");
    }
    // A closed or merged PR was announced when it was found so; later jobs stop quietly.
    if (existing?.state === "closed" || existing?.state === "merged") throw new JobSettled(`pr.${existing.state}`, "skipped", undefined);
    if (existing?.number != null) {
      const pull = await github.getPull(job.githubRepo, existing.number, signal);
      if (pull.merged || pull.state === "closed") return this.#closed(job, existing.headBranch, pull);
    }
    const headBranch = existing?.headBranch ?? job.branch;
    // A recorded push without a PR number means an earlier attempt may have created the PR and lost the
    // response. Look it up before pushing so a PR merged or closed since then is not re-pushed.
    const replayed = existing !== null && existing.number === null
      ? await github.findPullByHead(job.githubRepo, headBranch, signal)
      : undefined;
    if (replayed !== undefined && (replayed.merged || replayed.state === "closed")) return this.#closed(job, headBranch, replayed);
    const mirrorPath = mirrorPathFor(this.#gitRoot, job.githubRepo);
    const pushedCommits = await this.#countNewCommits(mirrorPath, existing?.lastPushedSha ?? null, job, signal);

    this.#renew(job);
    const token = await credentials.token(job.githubRepo);
    const askpassPath = await ensureAskpassScript(this.#gitRoot);
    const remoteUrl = this.#testRemoteUrlFor?.(job.githubRepo) ?? githubRemoteUrl(webBaseUrl, job.githubRepo);
    const push = await pushToRemote({
      runner: this.#runner,
      mirrorPath,
      remoteUrl,
      sha: job.sha,
      headBranch,
      token,
      askpassPath,
      ...(this.#testRemoteUrlFor === undefined ? {} : { allowTestRemote: true }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (push.kind === "rejected") {
      this.#store.settlePrSyncJob({
        jobId: job.jobId,
        workerId: this.#workerId,
        status: "skipped",
        resultCode: push.code,
        message: { suffix: "pr-rejected", payload: pushRejectedNotice(headBranch) },
        audit: { action: "pr.push.rejected", result: "denied", metadata: { headBranch, reason: push.reason } },
        now: this.#now().toISOString(),
      });
      return { kind: "skipped", jobId: job.jobId, code: push.code };
    }
    this.#store.recordPrSyncPushed({
      jobId: job.jobId,
      workerId: this.#workerId,
      taskId: job.taskId,
      operationId: job.operationId,
      repo: job.githubRepo,
      headBranch,
      baseBranch: existing?.baseBranch ?? job.baseBranch,
      sha: job.sha,
      pushStatus: push.status,
      now: this.#now().toISOString(),
    });

    this.#renew(job);
    if (existing?.number != null && existing.url !== null) {
      const pull = await github.getPull(job.githubRepo, existing.number, signal);
      this.#store.settlePrSyncJob({
        jobId: job.jobId,
        workerId: this.#workerId,
        status: "succeeded",
        resultCode: null,
        message: {
          suffix: "pr-push",
          payload: pullRequestPushedLine({
            repo: job.githubRepo,
            number: pull.number,
            url: pull.htmlUrl,
            pushedCommits,
            headBranch,
            headMoved: job.headMoved,
            ...(pull.additions === undefined ? {} : { additions: pull.additions }),
            ...(pull.deletions === undefined ? {} : { deletions: pull.deletions }),
          }),
        },
        audit: { action: "pr.pushed", result: "succeeded", metadata: { number: pull.number, commits: pushedCommits } },
        now: this.#now().toISOString(),
      });
      return { kind: "pushed", jobId: job.jobId, number: pull.number };
    }

    // No PR recorded yet: a crash after the push (or after GitHub created the PR) replays into this lookup.
    const found = replayed ?? await github.findPullByHead(job.githubRepo, headBranch, signal);
    if (found !== undefined && (found.merged || found.state === "closed")) return this.#closed(job, headBranch, found);
    let pull: GitHubPull;
    let created = false;
    let draftUnavailable = false;
    if (found !== undefined) {
      pull = found;
    } else {
      const subject = job.aheadCount === 1 ? await this.#commitSubject(mirrorPath, job.sha, signal) : undefined;
      const title = pullRequestTitle({
        aheadCount: job.aheadCount,
        ...(subject === undefined || subject === "" ? {} : { firstCommitSubject: subject }),
        request: job.requestText,
      });
      const threadLink = (await this.#threadLink?.(job.conversationId, job.threadTs).catch(() => undefined))
        ?? `${job.conversationId}/${job.threadTs}`;
      const result = await github.createDraftPull(
        job.githubRepo,
        {
          title,
          head: headBranch,
          base: job.baseBranch,
          body: pullRequestBody({ summaryText: job.summaryText, requestedBy: job.actorUserId, threadLink }),
          draft: settings.draft,
        },
        signal,
      );
      pull = result.pull;
      created = result.created;
      draftUnavailable = result.draftUnavailable;
    }
    if (pull.additions === undefined || pull.commits === undefined) pull = await github.getPull(job.githubRepo, pull.number, signal);
    this.#store.settlePrSyncJob({
      jobId: job.jobId,
      workerId: this.#workerId,
      status: "succeeded",
      resultCode: null,
      pullRequest: {
        repo: job.githubRepo,
        headBranch,
        baseBranch: job.baseBranch,
        number: pull.number,
        url: pull.htmlUrl,
        state: "open",
        draft: pull.draft,
      },
      message: {
        suffix: "pr",
        payload: pullRequestCard({
          jobId: job.jobId,
          repo: job.githubRepo,
          number: pull.number,
          url: pull.htmlUrl,
          title: pull.title,
          headBranch,
          baseBranch: pull.baseRef,
          draft: pull.draft,
          draftUnavailable,
          headMoved: job.headMoved,
          ...(pull.commits === undefined ? {} : { commits: pull.commits }),
          ...(pull.changedFiles === undefined ? {} : { changedFiles: pull.changedFiles }),
          ...(pull.additions === undefined ? {} : { additions: pull.additions }),
          ...(pull.deletions === undefined ? {} : { deletions: pull.deletions }),
        }),
      },
      audit: { action: "pr.created", result: "succeeded", metadata: { number: pull.number, created, draft: pull.draft } },
      now: this.#now().toISOString(),
    });
    return { kind: "created", jobId: job.jobId, number: pull.number };
  }

  #closed(job: ClaimedPrSyncJob, headBranch: string, pull: GitHubPull): PrWorkerOutcome {
    const state = pull.merged ? "merged" : "closed";
    this.#store.settlePrSyncJob({
      jobId: job.jobId,
      workerId: this.#workerId,
      status: "skipped",
      resultCode: `pr.${state}`,
      pullRequest: {
        repo: job.githubRepo,
        headBranch,
        baseBranch: pull.baseRef,
        number: pull.number,
        url: pull.htmlUrl,
        state,
        draft: pull.draft,
      },
      message: {
        suffix: "pr-closed",
        payload: pullRequestClosedNotice({ repo: job.githubRepo, number: pull.number, url: pull.htmlUrl, state }),
      },
      audit: { action: "pr.closed", result: "skipped", metadata: { number: pull.number, state } },
      now: this.#now().toISOString(),
    });
    return { kind: "skipped", jobId: job.jobId, code: `pr.${state}` };
  }

  /** Commits this push adds over the last pushed SHA; the snapshot's ahead count when nothing was pushed. */
  async #countNewCommits(
    mirrorPath: string,
    lastPushedSha: string | null,
    job: ClaimedPrSyncJob,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    if (lastPushedSha === null) return job.aheadCount;
    const result = await this.#runner.run({
      cwd: mirrorPath,
      args: ["rev-list", "--count", `${lastPushedSha}..${job.sha}`, "--"],
      ...(signal === undefined ? {} : { signal }),
    });
    const count = Number(result.stdout.trim());
    return result.exitCode === 0 && Number.isSafeInteger(count) ? count : job.aheadCount;
  }

  async #commitSubject(mirrorPath: string, sha: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const result = await this.#runner.run({
      cwd: mirrorPath,
      args: ["log", "-1", "--no-show-signature", "--encoding=UTF-8", "--format=%s", sha, "--"],
      ...(signal === undefined ? {} : { signal }),
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }
}

export type { TaskPullRequest };
