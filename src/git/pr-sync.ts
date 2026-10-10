// The coordinator side of the draft PR workflow (PR-M §3.7): after a completed turn, snapshot the task
// worktree into the Agent Tag mirror and turn the result into the `prSync` the completion transaction
// records next to the reply. Mode "off" (or an unmapped root) returns before any git process starts.
import { join } from "node:path";

import { type AgentTagConfig, type AgentTagProfile, pullRequestRepositoryFor } from "../config.ts";
import { secretBlockedNotice, sizeBlockedNotice, snapshotFailedNotice } from "../slack/pr-card.ts";
import type { AgentTagStore, PrSyncInput } from "../store/store.ts";
import type { GitRunner } from "./runner.ts";
import { prSnapshot, type PrSnapshotResult } from "./snapshot.ts";

export interface PullRequestSyncOptions {
  readonly runner: GitRunner;
  /** `<dataDir>/git` by default. */
  readonly gitRoot?: string;
}

/** Turn-text line for profiles with mode "auto" on a mapped root; null otherwise. */
export function pullRequestTurnNote(profile: AgentTagProfile, repositoryRoot: string, taskId: string): string | null {
  if (profile.pullRequests.mode !== "auto" || pullRequestRepositoryFor(profile, repositoryRoot) === undefined) return null;
  return (
    `When you finish, Agent Tag commits anything left on branch \`agent-tag/${taskId}\` and pushes it to a draft PR. ` +
    "Do not run `git push` or `gh pr create`; you have no GitHub write credentials."
  );
}

/** The user's request as plain text for commit messages and PR titles: mentions dropped, whitespace collapsed. */
export function pullRequestRequestText(text: string): string {
  return text.replace(/<[@#!][^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function prSyncFromSnapshot(
  result: PrSnapshotResult,
  target: { readonly repo: string; readonly baseBranch: string },
  input: { readonly requestText: string; readonly summaryText: string },
): PrSyncInput | undefined {
  switch (result.kind) {
    case "no-worktree":
    case "empty":
    case "unchanged":
      return undefined;
    case "failed":
      return { kind: "failed", code: result.code, notice: snapshotFailedNotice(result.code) };
    case "blocked":
      return {
        kind: "blocked",
        repo: target.repo,
        baseBranch: target.baseBranch,
        branch: null,
        sha: result.sha,
        reason: result.detail.reason,
        notice: result.detail.reason === "secret" ? secretBlockedNotice(result.detail.paths) : sizeBlockedNotice(result.detail),
      };
    case "ready":
      return {
        kind: "ready",
        repo: target.repo,
        baseBranch: target.baseBranch,
        branch: result.branch,
        sha: result.sha,
        mirrorRef: result.mirrorRef,
        aheadCount: result.aheadCount,
        requestText: input.requestText,
        summaryText: input.summaryText,
        ...(result.warning === "head-moved" ? { headMoved: true } : {}),
      };
  }
}

/**
 * Snapshots the task worktree when the profile has mode "auto" for the task's root. Never throws for
 * git problems (`prSnapshot` reports them as "failed"); only an aborted `signal` ends it early.
 */
export async function preparePullRequestSync(input: {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly options: PullRequestSyncOptions | undefined;
  readonly profile: AgentTagProfile;
  readonly taskId: string;
  readonly repositoryRoot: string;
  readonly t3Thread: { readonly branch?: string | null; readonly worktreePath?: string | null };
  readonly requestText: string;
  readonly summaryText: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly signal?: AbortSignal;
}): Promise<PrSyncInput | undefined> {
  const settings = input.profile.pullRequests;
  if (settings.mode !== "auto" || input.config.github === undefined || input.options === undefined) return undefined;
  const target = pullRequestRepositoryFor(input.profile, input.repositoryRoot);
  if (target === undefined) return undefined;
  const requestText = pullRequestRequestText(input.requestText);
  const result = await prSnapshot({
    taskId: input.taskId,
    repositoryRoot: input.repositoryRoot,
    repo: target.repo,
    baseBranch: target.baseBranch,
    t3Thread: input.t3Thread,
    request: requestText,
    conversationId: input.conversationId,
    threadTs: input.threadTs,
    actorUserId: input.actorUserId,
    commitAuthor: settings.commitAuthor,
    lastPushedSha: input.store.getTaskPullRequest(input.taskId)?.lastPushedSha ?? null,
    gitRoot: input.options.gitRoot ?? join(input.config.dataDir, "git"),
    limits: { maxChangedFiles: settings.maxChangedFiles, maxDiffBytes: settings.maxDiffBytes, secretScan: settings.secretScan },
    runner: input.options.runner,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return prSyncFromSnapshot(result, target, { requestText, summaryText: input.summaryText });
}
