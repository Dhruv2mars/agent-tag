// Minimal GitHub REST client for the draft PR workflow (PR-M §3.5). The token comes from
// `GitHubCredentials` per request, goes only into the Authorization header of Agent Tag's own `fetch`, and
// is scrubbed from every error. Redirects are not followed, so the header is never replayed to another host.
import { z } from "zod";

import { GIT_BRANCH_NAME_PATTERN, GITHUB_REPOSITORY_PATTERN } from "../config.ts";
import { redactSecrets } from "../security/redact.ts";
import type { SecretString } from "../security/secret-file.ts";
import type { GitHubCredentials } from "./auth.ts";

export const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_ERROR_DETAIL = 300;
const PR_TITLE_MAX = 72;
const PR_BODY_SUMMARY_MAX = 4_000;
export const DRAFT_UNAVAILABLE_TITLE_PREFIX = "[WIP] ";

export type GitHubErrorKind = "auth" | "rate-limited" | "transient" | "not-found" | "validation" | "unexpected";

export class GitHubApiError extends Error {
  readonly kind: GitHubErrorKind;
  /** `github.<kind>`, for job result codes and audit metadata. */
  readonly code: string;
  readonly status: number | undefined;
  /** Set for `rate-limited`: from `retry-after`, else `x-ratelimit-reset`, else 60s. */
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(input: { kind: GitHubErrorKind; message: string; status?: number; retryAfterMs?: number }) {
    super(input.message);
    this.name = "GitHubApiError";
    this.kind = input.kind;
    this.code = `github.${input.kind}`;
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.retryable = input.kind === "rate-limited" || input.kind === "transient";
  }
}

export interface GitHubPull {
  readonly number: number;
  readonly htmlUrl: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly title: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  /** Present on `getPull`; the list endpoint omits these. */
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly commits?: number;
}

export interface CreatePullInput {
  readonly title: string;
  /** Branch name in the same repository (no `owner:` prefix). */
  readonly head: string;
  readonly base: string;
  readonly body: string;
  /** Defaults to true. */
  readonly draft?: boolean;
}

export interface CreatePullResult {
  readonly pull: GitHubPull;
  /** False when a PR for the head already existed (the "already exists" 422 path). */
  readonly created: boolean;
  /** The repository refused drafts, so the PR was opened as a normal PR with a `[WIP] ` title. */
  readonly draftUnavailable: boolean;
}

export type PushAccess = "yes" | "no" | "unknown";

export interface GitHubClient {
  /** Newest PR (any state) whose head is `owner:headBranch`, or undefined. */
  findPullByHead(repo: string, headBranch: string, signal?: AbortSignal): Promise<GitHubPull | undefined>;
  createDraftPull(repo: string, input: CreatePullInput, signal?: AbortSignal): Promise<CreatePullResult>;
  getPull(repo: string, number: number, signal?: AbortSignal): Promise<GitHubPull>;
  /** `permissions.push` from `GET /repos/{o}/{r}`; `unknown` when the field is absent (fine-grained PATs). */
  checkPushAccess(repo: string, signal?: AbortSignal): Promise<PushAccess>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  readonly apiBaseUrl: string;
  readonly credentials: GitHubCredentials;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  title: z.string(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
  commits: z.number().int().optional(),
});

const errorBodySchema = z
  .object({
    message: z.string().optional(),
    errors: z
      .array(z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().optional() }).loose()]))
      .optional(),
  })
  .loose();

function toPull(raw: z.infer<typeof pullSchema>): GitHubPull {
  return {
    number: raw.number,
    htmlUrl: raw.html_url,
    state: raw.state,
    merged: raw.merged ?? (raw.merged_at !== null && raw.merged_at !== undefined),
    draft: raw.draft ?? false,
    title: raw.title,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    ...(raw.additions === undefined ? {} : { additions: raw.additions }),
    ...(raw.deletions === undefined ? {} : { deletions: raw.deletions }),
    ...(raw.changed_files === undefined ? {} : { changedFiles: raw.changed_files }),
    ...(raw.commits === undefined ? {} : { commits: raw.commits }),
  };
}

function splitRepo(repo: string): { readonly owner: string; readonly name: string } {
  if (!GITHUB_REPOSITORY_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new GitHubApiError({ kind: "validation", message: "repo must be owner/name" });
  }
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

function assertBranch(branch: string, label: string): void {
  if (!GIT_BRANCH_NAME_PATTERN.test(branch)) {
    throw new GitHubApiError({ kind: "validation", message: `${label} is not a valid branch name` });
  }
}

/** `@` followed by a zero-width space, so model output cannot mention GitHub users or teams. */
export function neutralizeMentions(text: string): string {
  return text.replaceAll("@", "@​");
}

/** The first commit subject when there is one commit, else the request's first line; at most 72 characters. */
export function pullRequestTitle(input: { readonly aheadCount: number; readonly firstCommitSubject?: string; readonly request: string }): string {
  const source =
    input.aheadCount === 1 && input.firstCommitSubject !== undefined && input.firstCommitSubject.trim().length > 0
      ? input.firstCommitSubject
      : input.request;
  const line =
    source
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "Agent Tag changes";
  return line.length > PR_TITLE_MAX ? `${line.slice(0, PR_TITLE_MAX - 1)}…` : line;
}

/** Summary (mentions neutralized), a link back to Slack, and the review-required footer. */
export function pullRequestBody(input: {
  readonly summaryText: string;
  readonly requestedBy: string;
  readonly threadLink: string;
}): string {
  const summary =
    input.summaryText.length > PR_BODY_SUMMARY_MAX ? `${input.summaryText.slice(0, PR_BODY_SUMMARY_MAX - 1)}…` : input.summaryText;
  return [
    neutralizeMentions(summary.trim()),
    "",
    `Requested in Slack by ${neutralizeMentions(input.requestedBy)} · ${input.threadLink}`,
    "",
    "---",
    "Opened by Agent Tag as a draft. Human review required before merge.",
  ].join("\n");
}

function retryAfterMs(response: ApiResponse, now: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) return Math.max(1_000, epochSeconds * 1_000 - now);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function scrub(text: string, token: SecretString | undefined): string {
  const value = token?.exposeToBoundary();
  const exact = value === undefined || value.length === 0 ? text : text.split(value).join("[REDACTED]");
  return redactSecrets(exact);
}

/** A response whose body was read in full inside the request's timeout. */
interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON, or undefined when the body is empty or not JSON (a payload problem, not transport). */
  readonly body: unknown;
}

interface ErrorDetail {
  readonly message: string;
  /** Lowercased message plus every `errors[].message`, for matching. */
  readonly haystack: string;
}

function errorDetail(response: ApiResponse, token: SecretString | undefined): ErrorDetail {
  const parsed = errorBodySchema.safeParse(response.body);
  if (!parsed.success) return { message: "", haystack: "" };
  const parts = [
    parsed.data.message ?? "",
    ...(parsed.data.errors ?? []).map((item) => (typeof item === "string" ? item : (item.message ?? ""))),
  ].filter((part) => part.length > 0);
  const message = scrub(parts.join("; "), token).slice(0, MAX_ERROR_DETAIL);
  return { message, haystack: message.toLowerCase() };
}

/** Maps a non-2xx response to a classified, redacted error (outbox-policy style). */
function classify(response: ApiResponse, token: SecretString | undefined, now: number, what: string): GitHubApiError {
  const status = response.status;
  const detail = errorDetail(response, token);
  const suffix = detail.message.length > 0 ? `: ${detail.message}` : "";
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after") !== null ||
        detail.haystack.includes("rate limit")));
  if (rateLimited) {
    return new GitHubApiError({
      kind: "rate-limited",
      status,
      retryAfterMs: retryAfterMs(response, now),
      message: `GitHub rate limited ${what} (HTTP ${status})${suffix}`,
    });
  }
  if (status === 401 || status === 403) {
    return new GitHubApiError({
      kind: "auth",
      status,
      message: `GitHub credential rejected for ${what} (HTTP ${status}); operator must fix github.auth${suffix}`,
    });
  }
  if (status === 404) {
    return new GitHubApiError({
      kind: "not-found",
      status,
      message: `GitHub returned 404 for ${what}: repo not found or not granted to the credential`,
    });
  }
  if (status === 422) return new GitHubApiError({ kind: "validation", status, message: `GitHub rejected ${what} (HTTP 422)${suffix}` });
  if (status >= 500) return new GitHubApiError({ kind: "transient", status, message: `GitHub server error for ${what} (HTTP ${status})` });
  return new GitHubApiError({ kind: "unexpected", status, message: `unexpected GitHub response for ${what} (HTTP ${status})${suffix}` });
}

/** Reads the whole body, rejecting as soon as `signal` aborts even if the stream itself never settles. */
async function readBodyText(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw signal.reason;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      response.body?.cancel().catch(() => undefined);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([response.text(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const base = new URL(options.apiBaseUrl);
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
    throw new Error("GitHub apiBaseUrl must be an https URL without credentials");
  }
  const apiBaseUrl = base.href.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const request = async (input: {
    readonly repo: string;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly what: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly response: ApiResponse; readonly token: SecretString }> => {
    const token = await options.credentials.token(input.repo);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]);
    const transportError = (error: unknown) => {
      const reason = timeout.aborted ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      return new GitHubApiError({ kind: "transient", message: `GitHub request for ${input.what} failed: ${scrub(reason, token)}` });
    };
    let response: Response;
    try {
      response = await doFetch(`${apiBaseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token.exposeToBoundary()}`,
          "User-Agent": "agent-tag",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw transportError(error);
    }
    // The body is part of the request: a stall or a dropped connection after the headers is a transport
    // failure (transient, retryable), and the same timeout covers it.
    let text: string;
    try {
      text = await readBodyText(response, signal);
    } catch (error) {
      throw transportError(error);
    }
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { response: { status: response.status, headers: response.headers, body }, token };
  };

  const parsePull = (response: ApiResponse, what: string): GitHubPull => {
    const parsed = pullSchema.safeParse(response.body);
    if (!parsed.success) throw new GitHubApiError({ kind: "unexpected", status: response.status, message: `unexpected GitHub payload for ${what}` });
    return toPull(parsed.data);
  };

  const findPullByHead: GitHubClient["findPullByHead"] = async (repo, headBranch, signal) => {
    const { owner, name } = splitRepo(repo);
    assertBranch(headBranch, "head branch");
    const query = new URLSearchParams({
      head: `${owner}:${headBranch}`,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: "5",
    });
    const what = `pull request lookup on ${repo}`;
    const { response, token } = await request({ repo, method: "GET", path: `/repos/${owner}/${name}/pulls?${query}`, what, signal });
    if (response.status !== 200) throw classify(response, token, now(), what);
    const parsed = z.array(pullSchema).safeParse(response.body);
    if (!parsed.success) throw new GitHubApiError({ kind: "unexpected", status: 200, message: `unexpected GitHub payload for ${what}` });
    const pulls = parsed.data.map(toPull).filter((pull) => pull.headRef === headBranch);
    pulls.sort((left, right) => right.number - left.number);
    return pulls[0];
  };

  const getPull: GitHubClient["getPull"] = async (repo, number, signal) => {
    const { owner, name } = splitRepo(repo);
    if (!Number.isSafeInteger(number) || number <= 0) throw new GitHubApiError({ kind: "validation", message: "pull number must be positive" });
    const what = `pull request ${repo}#${number}`;
    const { response, token } = await request({ repo, method: "GET", path: `/repos/${owner}/${name}/pulls/${number}`, what, signal });
    if (response.status !== 200) throw classify(response, token, now(), what);
    return parsePull(response, what);
  };

  const createDraftPull: GitHubClient["createDraftPull"] = async (repo, input, signal) => {
    const { owner, name } = splitRepo(repo);
    assertBranch(input.head, "head branch");
    assertBranch(input.base, "base branch");
    const what = `pull request creation on ${repo}`;
    const attempt = async (draft: boolean, title: string) =>
      await request({
        repo,
        method: "POST",
        path: `/repos/${owner}/${name}/pulls`,
        what,
        body: { title, head: input.head, base: input.base, body: input.body, draft, maintainer_can_modify: false },
        signal,
      });

    const wantDraft = input.draft ?? true;
    let { response, token } = await attempt(wantDraft, input.title);
    let draftUnavailable = false;
    if (response.status === 422) {
      const error = classify(response, token, now(), what);
      const text = error.message.toLowerCase();
      if (text.includes("already exists")) {
        const existing = await findPullByHead(repo, input.head, signal);
        if (existing === undefined) throw error;
        return { pull: existing, created: false, draftUnavailable: false };
      }
      if (!wantDraft || !text.includes("draft")) throw error;
      draftUnavailable = true;
      ({ response, token } = await attempt(false, `${DRAFT_UNAVAILABLE_TITLE_PREFIX}${input.title}`));
      if (response.status === 422) {
        const retryError = classify(response, token, now(), what);
        if (!retryError.message.toLowerCase().includes("already exists")) throw retryError;
        const existing = await findPullByHead(repo, input.head, signal);
        if (existing === undefined) throw retryError;
        return { pull: existing, created: false, draftUnavailable: false };
      }
    }
    if (response.status !== 201) throw classify(response, token, now(), what);
    return { pull: parsePull(response, what), created: true, draftUnavailable };
  };

  const checkPushAccess: GitHubClient["checkPushAccess"] = async (repo, signal) => {
    const { owner, name } = splitRepo(repo);
    const what = `repository ${repo}`;
    const { response, token } = await request({ repo, method: "GET", path: `/repos/${owner}/${name}`, what, signal });
    if (response.status !== 200) throw classify(response, token, now(), what);
    const parsed = z
      .object({ permissions: z.object({ push: z.boolean().optional() }).loose().optional() })
      .loose()
      .safeParse(response.body);
    const push = parsed.success ? parsed.data.permissions?.push : undefined;
    return push === undefined ? "unknown" : push ? "yes" : "no";
  };

  return { findPullByHead, createDraftPull, getPull, checkPushAccess };
}
