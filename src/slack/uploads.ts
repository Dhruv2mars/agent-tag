// Slack files out (PR-L2): the agent shares a file it wrote by ending its reply with a line
// `[[agent-tag:upload <relative/path> ["title"]]]`. The coordinator strips those lines and queues one
// slack_file_uploads row per file with the reply (store/file-uploads.ts); FileUploadWorker reads each
// file from the thread's worktree, refuses known credential shapes, and shares it in the task's thread
// with Slack's external upload flow (getUploadURLExternal, POST bytes, completeUploadExternal).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { ExecutionAuthorityDenied, requireTaskAuthority } from "../policy/execution.ts";
import { scanTextForSecrets } from "../security/secret-scan.ts";
import type { AgentTagStore, ClaimedFileUpload, FileUploadRequest } from "../store/store.ts";
import {
  classifySlackDeliveryError,
  DEFAULT_OUTBOX_RETRY_POLICY,
  outboxRetryDelayMs,
  slackPlatformErrorName,
  type OutboxRetryPolicy,
} from "./outbox-policy.ts";
import { escapeSlackText } from "./render.ts";

export type OutboundFileLimits = AgentTagConfig["files"]["outbound"];

const DIRECTIVE = /^\s*\[\[agent-tag:upload\s+(\S{1,1024}?)(?:\s+"([^"\n]{1,200})")?\]\]\s*$/;
const FENCE = /^\s*(```|~~~)/;
const MAX_REJECTED_LISTED = 10;

export type RejectedUploadReason = "invalid-path" | "hidden-path" | "over-limit" | "duplicate";

export interface ParsedUploads {
  /** The reply without directive lines. Never empty when directives were found. */
  readonly text: string;
  readonly requests: readonly FileUploadRequest[];
  readonly rejected: readonly { readonly path: string; readonly reason: RejectedUploadReason }[];
}

/**
 * A workspace-relative path in canonical form, or why it is refused: absolute, home-relative, `..`,
 * backslash, NUL or control characters are invalid; any segment starting with "." (`.env`, `.ssh/`,
 * `.git/`) is hidden. `./` segments and repeated slashes are dropped so one file has one form.
 */
export function normalizeUploadPath(path: string): { readonly path: string } | { readonly reason: "invalid-path" | "hidden-path" } {
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\") || /\p{Cc}/u.test(path)) {
    return { reason: "invalid-path" };
  }
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return { reason: "invalid-path" };
  if (segments.some((segment) => segment.startsWith("."))) return { reason: "hidden-path" };
  return { path: segments.join("/") };
}

/**
 * Finds upload directive lines (a whole line each, outside code fences) and strips them from the
 * reply. Up to `maxFiles` distinct valid paths become requests; the rest are reported as rejected.
 */
export function parseUploadDirectives(text: string, maxFiles: number): ParsedUploads {
  const kept: string[] = [];
  const requests: FileUploadRequest[] = [];
  const rejected: { path: string; reason: RejectedUploadReason }[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      fence = fence === null ? marker : fence === marker ? null : fence;
      kept.push(line);
      continue;
    }
    const match = fence === null ? DIRECTIVE.exec(line) : null;
    if (match === null) {
      kept.push(line);
      continue;
    }
    const raw = match[1] ?? "";
    const normalized = normalizeUploadPath(raw);
    if ("reason" in normalized) {
      rejected.push({ path: raw, reason: normalized.reason });
    } else if (requests.some((request) => request.path === normalized.path)) {
      rejected.push({ path: raw, reason: "duplicate" });
    } else if (requests.length >= maxFiles) {
      rejected.push({ path: raw, reason: "over-limit" });
    } else {
      requests.push({ path: normalized.path, title: match[2]?.trim() || null });
    }
  }
  const found = requests.length + rejected.length;
  if (found === 0) return { text, requests, rejected };
  const stripped = kept.join("\n").trim();
  const count = requests.length;
  const fallback = count === 0 ? "I couldn't share the files I meant to." : `Sharing ${count} file${count === 1 ? "" : "s"}.`;
  return { text: stripped === "" ? fallback : stripped, requests, rejected };
}

const REJECTED_REASON_TEXT: Readonly<Record<RejectedUploadReason, (limits: OutboundFileLimits) => string>> = {
  "invalid-path": () => "not a path inside the workspace",
  "hidden-path": () => "hidden files are never shared",
  "over-limit": (limits) => `only ${limits.maxFilesPerTurn} files per reply`,
  duplicate: () => "listed twice",
};

/** One context line for directives that were not queued, or null when every directive was. */
export function rejectedUploadsNotice(rejected: ParsedUploads["rejected"], limits: OutboundFileLimits): string | null {
  if (rejected.length === 0) return null;
  const listed = rejected
    .slice(0, MAX_REJECTED_LISTED)
    .map((entry) => `\`${escapeSlackText(entry.path.slice(0, 120)).replaceAll("`", "'")}\` (${REJECTED_REASON_TEXT[entry.reason](limits)})`);
  const more = rejected.length > MAX_REJECTED_LISTED ? `, and ${rejected.length - MAX_REJECTED_LISTED} more` : "";
  return `:warning: Didn't share ${listed.join(", ")}${more}.`;
}

/** The turn-text line that tells the agent how to share files (turn-text.ts). */
export function uploadInstruction(limits: OutboundFileLimits): string {
  return [
    "[Agent Tag: to share a file you wrote in this workspace with the Slack thread, end your reply with one line per file:",
    "[[agent-tag:upload relative/path/to/file]] or [[agent-tag:upload relative/path \"Title\"]].",
    `Up to ${limits.maxFilesPerTurn} files, ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MiB each; hidden files and paths outside the workspace are refused.]`,
  ].join(" ");
}

/** Why a file could not be read or shared. Codes are stable; they appear in audit rows and notices. */
export class ArtifactError extends Error {
  constructor(readonly code: "not-found" | "outside-workspace" | "hidden-path" | "not-a-file" | "too-large" | "unreadable" | "empty") {
    super(`workspace file ${code}`);
    this.name = "ArtifactError";
  }
}

/**
 * Reads `path` from the thread worktree `root`. The canonical file must sit inside the canonical root
 * (a symlink may not leave it or point at a hidden file), be a regular file, and fit `maxBytes`; the
 * final component is opened without following symlinks.
 */
export async function readWorkspaceArtifact(input: {
  readonly root: string;
  readonly path: string;
  readonly maxBytes: number;
}): Promise<Uint8Array<ArrayBuffer>> {
  const normalized = normalizeUploadPath(input.path);
  if ("reason" in normalized) throw new ArtifactError(normalized.reason === "hidden-path" ? "hidden-path" : "outside-workspace");
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(input.root);
    canonicalFile = await realpath(resolve(canonicalRoot, normalized.path));
  } catch (error) {
    throw new ArtifactError(errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR" ? "not-found" : "unreadable");
  }
  const inside = relative(canonicalRoot, canonicalFile);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ArtifactError("outside-workspace");
  }
  if (inside.split(sep).some((segment) => segment.startsWith("."))) throw new ArtifactError("hidden-path");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new ArtifactError(errnoCode(error) === "ENOENT" ? "not-found" : "unreadable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ArtifactError("not-a-file");
    if (stat.size > input.maxBytes) throw new ArtifactError("too-large");
    if (stat.size === 0) throw new ArtifactError("empty");
    // One byte past the declared size: a file still growing past the cap is refused, not cut.
    const buffer = new Uint8Array(new ArrayBuffer(Math.min(stat.size + 1, input.maxBytes + 1)));
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > input.maxBytes) throw new ArtifactError("too-large");
    if (length === 0) throw new ArtifactError("empty");
    return buffer.slice(0, length);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("unreadable");
  } finally {
    await handle.close();
  }
}

function errnoCode(error: unknown): string | undefined {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/**
 * Credential classes found in the bytes (KNOWN_CREDENTIAL_PATTERNS), never the values. Every file is
 * scanned, text or not: a latin1 view keeps ASCII runs intact, so a token inside a PDF or an
 * uncompressed archive still matches. Compressed content (zip, xlsx, png data) is not inspected.
 */
export function secretClassesIn(bytes: Uint8Array): readonly string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  return [...new Set(scanTextForSecrets(text).map((finding) => finding.kind === "known-token-pattern" ? finding.patternName : finding.canaryName))];
}

/** Slack's external upload flow and the share check, over the bot token (bridge.ts). */
export interface SlackUploadClient {
  /** `files.getUploadURLExternal`. */
  getUploadUrl(input: { readonly filename: string; readonly length: number }): Promise<{ readonly uploadUrl: string; readonly fileId: string }>;
  /** POSTs the bytes to the upload URL (no Authorization header; the URL carries the authority). */
  postBytes(uploadUrl: string, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void>;
  /** `files.completeUploadExternal` sharing the file into the thread. */
  complete(input: { readonly fileId: string; readonly title: string; readonly channelId: string; readonly threadTs: string }): Promise<void>;
  /** Channel ids the file is shared to (`files.info`); rejects with Slack's `file_not_found` when it never completed. */
  sharedIn(fileId: string): Promise<readonly string[]>;
}

/** The slice of the Bolt Web API client the upload flow uses. */
export interface SlackFilesApi {
  readonly files: {
    getUploadURLExternal(args: { filename: string; length: number }): Promise<unknown>;
    completeUploadExternal(args: { files: [{ id: string; title?: string }]; channel_id: string; thread_ts: string }): Promise<unknown>;
    info(args: { file: string }): Promise<unknown>;
  };
}

const uploadUrlSchema = z.object({ upload_url: z.url(), file_id: z.string().regex(/^F[A-Z0-9]+$/) });
const sharesSchema = z.object({
  file: z.object({
    channels: z.array(z.string()).optional(),
    groups: z.array(z.string()).optional(),
    ims: z.array(z.string()).optional(),
    shares: z
      .object({
        public: z.record(z.string(), z.unknown()).optional(),
        private: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  }),
});

/** Thrown for an upload URL Slack answered with something other than 2xx. */
export class SlackUploadPostError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "Slack upload POST failed" : `Slack upload POST returned HTTP ${status}`);
    this.name = "SlackUploadPostError";
  }
}

export function slackUploadClient(
  api: SlackFilesApi,
  fetchImpl: (url: URL, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): SlackUploadClient {
  return {
    getUploadUrl: async ({ filename, length }) => {
      const parsed = uploadUrlSchema.parse(await api.files.getUploadURLExternal({ filename, length }));
      return { uploadUrl: parsed.upload_url, fileId: parsed.file_id };
    },
    postBytes: async (uploadUrl, bytes, signal) => {
      const url = new URL(uploadUrl);
      if (url.protocol !== "https:") throw new SlackUploadPostError(null);
      const timeout = AbortSignal.timeout(60_000);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          body: new Blob([bytes]),
          redirect: "error",
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
      } catch {
        // The upload URL carries bearer authority: never let it reach an error message.
        throw new SlackUploadPostError(null);
      }
      await response.body?.cancel();
      if (!response.ok) throw new SlackUploadPostError(response.status);
    },
    complete: async ({ fileId, title, channelId, threadTs }) => {
      await api.files.completeUploadExternal({ files: [{ id: fileId, title }], channel_id: channelId, thread_ts: threadTs });
    },
    sharedIn: async (fileId) => {
      const { file } = sharesSchema.parse(await api.files.info({ file: fileId }));
      return [
        ...(file.channels ?? []),
        ...(file.groups ?? []),
        ...(file.ims ?? []),
        ...Object.keys(file.shares?.public ?? {}),
        ...Object.keys(file.shares?.private ?? {}),
      ];
    },
  };
}

export type FileUploadOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "delivered"; readonly uploadId: string }
  | { readonly kind: "retry-scheduled"; readonly uploadId: string; readonly errorCode: string }
  | { readonly kind: "failed"; readonly uploadId: string; readonly errorCode: string }
  | { readonly kind: "released"; readonly uploadId: string };

const ARTIFACT_NOTICE: Readonly<Record<ArtifactError["code"], string>> = {
  "not-found": "the file doesn't exist in the workspace",
  "outside-workspace": "the path leaves the workspace",
  "hidden-path": "hidden files are never shared",
  "not-a-file": "it isn't a regular file",
  "too-large": "it's over the size limit",
  unreadable: "Agent Tag couldn't read it",
  empty: "the file is empty",
};

const SLACK_NOTICE: Readonly<Record<string, string>> = {
  missing_scope: "the Slack app needs the files:write scope; ask the operator to reinstall it",
  not_in_channel: "the Slack app isn't in this channel",
  channel_not_found: "Slack couldn't find this channel",
  invalid_auth: "the Slack token was refused",
  file_uploads_disabled: "file uploads are disabled in this workspace",
};

const UPLOAD_LEASE_MS = 120_000;

/**
 * Shares queued agent files one at a time. Each claimed row ends delivered, failed (with one thread
 * notice, except when the task lost its authority), back to pending behind a backoff, or released on
 * shutdown. A crash after Slack handed out a file id is recovered by asking Slack whether that file
 * already reached the thread, so a completed share is never posted twice.
 */
export class FileUploadWorker {
  readonly requiresT3 = false;
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #slack: SlackUploadClient;
  readonly #workerId: string;
  readonly #retry: OutboxRetryPolicy;
  readonly #random: () => number;
  readonly #now: () => Date;

  constructor(options: {
    readonly config: AgentTagConfig;
    readonly store: AgentTagStore;
    readonly slack: SlackUploadClient;
    readonly workerId?: string;
    readonly retry?: OutboxRetryPolicy;
    readonly random?: () => number;
    readonly now?: () => Date;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#slack = options.slack;
    this.#workerId = options.workerId ?? `file-upload-${crypto.randomUUID()}`;
    this.#retry = options.retry ?? DEFAULT_OUTBOX_RETRY_POLICY;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
  }

  async processNext(signal?: AbortSignal): Promise<FileUploadOutcome> {
    const upload = this.#store.claimNextFileUpload({
      workerId: this.#workerId,
      now: this.#iso(),
      leaseMs: UPLOAD_LEASE_MS,
    });
    if (upload === null) return { kind: "idle" };
    const lease = { uploadId: upload.uploadId, workerId: this.#workerId };
    try {
      await this.#deliver(upload, signal);
      return { kind: "delivered", uploadId: upload.uploadId };
    } catch (error) {
      if (signal?.aborted === true) {
        this.#store.releaseFileUpload({ ...lease, now: this.#iso() });
        return { kind: "released", uploadId: upload.uploadId };
      }
      return this.#settleFailure(upload, error);
    }
  }

  async #deliver(upload: ClaimedFileUpload, signal: AbortSignal | undefined): Promise<void> {
    const lease = { uploadId: upload.uploadId, workerId: this.#workerId };
    const task = this.#store.getTaskExecution(upload.taskId);
    requireTaskAuthority({ config: this.#config, task });
    if (upload.conversationId !== task.conversationId) throw new ExecutionAuthorityDenied();

    if (upload.slackFileId !== null) {
      // A previous attempt got this far: if Slack already shared the file, only the mark is missing.
      let shared: readonly string[] | null;
      try {
        shared = await this.#slack.sharedIn(upload.slackFileId);
      } catch (error) {
        if (slackPlatformErrorName(error) !== "file_not_found") throw error;
        shared = null;
      }
      if (shared?.includes(upload.conversationId) === true) {
        this.#store.markFileUploadDelivered({ ...lease, slackFileId: upload.slackFileId, now: this.#iso() });
        return;
      }
      this.#store.clearFileUploadStart({ ...lease, now: this.#iso() });
    }

    const limits = this.#config.files.outbound;
    const bytes = await readWorkspaceArtifact({ root: upload.workspaceRoot, path: upload.path, maxBytes: limits.maxFileBytes });
    if (limits.scanForSecrets) {
      const classes = secretClassesIn(bytes);
      if (classes.length > 0) throw new SecretBlocked(classes);
    }
    if (signal?.aborted === true) throw new Error("aborted");
    const filename = basename(upload.path);
    const target = await this.#slack.getUploadUrl({ filename, length: bytes.byteLength });
    this.#store.markFileUploadStarted({ ...lease, slackFileId: target.fileId, now: this.#iso() });
    await this.#slack.postBytes(target.uploadUrl, bytes, signal);
    await this.#slack.complete({
      fileId: target.fileId,
      title: upload.title ?? filename,
      channelId: upload.conversationId,
      threadTs: upload.threadTs,
    });
    this.#store.markFileUploadDelivered({ ...lease, slackFileId: target.fileId, now: this.#iso() });
  }

  #settleFailure(upload: ClaimedFileUpload, error: unknown): FileUploadOutcome {
    const lease = { uploadId: upload.uploadId, workerId: this.#workerId };
    const name = `\`${escapeSlackText(basename(upload.path)).replaceAll("`", "'")}\``;
    const fail = (errorCode: string, reason: string | null, secretClasses?: readonly string[]): FileUploadOutcome => {
      this.#store.failFileUpload({
        ...lease,
        errorCode,
        notice: reason === null ? null : `:warning: Couldn't share ${name}: ${reason}.`,
        ...(secretClasses === undefined ? {} : { secretClasses }),
        now: this.#iso(),
      });
      return { kind: "failed", uploadId: upload.uploadId, errorCode };
    };
    if (error instanceof ExecutionAuthorityDenied) return fail(error.name, null);
    if (error instanceof ArtifactError) return fail(error.code, ARTIFACT_NOTICE[error.code]);
    if (error instanceof SecretBlocked) {
      return fail("secret-blocked", "it looks like it contains a credential, so Agent Tag held it back", error.classes);
    }
    const failure = error instanceof SlackUploadPostError
      ? { kind: "retryable" as const, errorCode: error.status === null ? "upload_post_failed" : `upload_http_${error.status}` }
      : classifySlackDeliveryError(error);
    if (failure.kind === "terminal") {
      return fail(failure.errorCode, SLACK_NOTICE[failure.errorCode] ?? `Slack refused it (${failure.errorCode})`);
    }
    // Retryable and ambiguous alike: a retry first asks Slack whether the share already happened.
    if (upload.attempts >= this.#retry.maxAttempts) {
      return fail(failure.errorCode, `Slack kept failing (${failure.errorCode})`);
    }
    const delay = outboxRetryDelayMs({
      attempt: upload.attempts,
      ...(failure.kind === "retryable" && failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      policy: this.#retry,
      random: this.#random,
    });
    this.#store.retryFileUpload({
      ...lease,
      errorCode: failure.errorCode,
      blockedUntil: new Date(this.#now().getTime() + delay).toISOString(),
      now: this.#iso(),
    });
    return { kind: "retry-scheduled", uploadId: upload.uploadId, errorCode: failure.errorCode };
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

class SecretBlocked extends Error {
  constructor(readonly classes: readonly string[]) {
    super("workspace file contains a known credential shape");
    this.name = "SecretBlocked";
  }
}
