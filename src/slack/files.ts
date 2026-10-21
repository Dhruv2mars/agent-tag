// Slack files in (PR-L1): turns the file refs of an operation's payload into T3 attachments. Each
// file is looked up with `files.info`, downloaded with the bot token under a byte cap, classified
// (images by magic bytes), uploaded to T3 and recorded; a file that cannot be read is skipped with a
// reason and never fails the turn. Recorded outcomes are reused on replay, so nothing is uploaded twice.
import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import type { InboundSkipReason, OperationAttachment } from "../store/attachments.ts";
import type { InboundFileRef } from "../store/schema.ts";
import { type T3Attachment, type T3ConnectionConfig, uploadT3Attachment } from "../t3/gateway.ts";
import type { TurnFile } from "../turn-text.ts";
import { escapeSlackText } from "./render.ts";
import { sniffImageMime } from "./sniff.ts";

export type InboundFileLimits = AgentTagConfig["files"]["inbound"];

/** `files.info` as the materializer needs it. */
export interface SlackFileInfo {
  readonly id: string;
  readonly name?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly size?: number;
  readonly mode?: string;
  readonly isExternal: boolean;
  readonly urlPrivateDownload?: string;
}

export interface SlackDownload {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string | null;
}

/** Slack reads for shared files: implemented over the bot token in bridge.ts, faked in tests. */
export interface SlackFileClient {
  /** Rejects with a SlackFileError (or a Web API error carrying `data.error`). */
  info(fileId: string, signal?: AbortSignal): Promise<SlackFileInfo>;
  /** Rejects with a SlackFileError when the body would exceed `maxBytes` or the download fails. */
  download(url: string, maxBytes: number, signal?: AbortSignal): Promise<SlackDownload>;
}

export type T3AttachmentUploader = (input: {
  readonly type: T3Attachment["type"];
  readonly name: string;
  readonly mimeType: string;
  readonly data: Blob;
  readonly signal?: AbortSignal;
}) => Promise<T3Attachment>;

/** How the coordinator reads shared files. Absent `slack`: every file is skipped as unavailable. */
export interface InboundFileTransport {
  readonly slack?: SlackFileClient;
  /** Defaults to uploading to the configured T3 server. */
  readonly upload?: T3AttachmentUploader;
}

export function t3AttachmentUploader(config: T3ConnectionConfig): T3AttachmentUploader {
  return (input) => uploadT3Attachment({ config, ...input });
}

/** A per-file failure with the skip reason it maps to. Never carries a URL or token. */
export class SlackFileError extends Error {
  readonly reason: InboundSkipReason;

  constructor(reason: InboundSkipReason) {
    super(`Slack file ${reason}`);
    this.name = "SlackFileError";
    this.reason = reason;
  }
}

const fileInfoSchema = z.object({
  file: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      mimetype: z.string().optional(),
      filetype: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
      mode: z.string().optional(),
      is_external: z.boolean().optional(),
      url_private_download: z.string().optional(),
    })
    .passthrough(),
});

/** Parses a `files.info` response body. */
export function parseSlackFileInfo(raw: unknown): SlackFileInfo {
  const { file } = fileInfoSchema.parse(raw);
  return {
    id: file.id,
    isExternal: file.is_external === true,
    ...(file.name === undefined ? {} : { name: file.name }),
    ...(file.mimetype === undefined ? {} : { mimetype: file.mimetype }),
    ...(file.filetype === undefined ? {} : { filetype: file.filetype }),
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.mode === undefined ? {} : { mode: file.mode }),
    ...(file.url_private_download === undefined ? {} : { urlPrivateDownload: file.url_private_download }),
  };
}

/** Maps a `files.info` failure code to a skip reason. */
export function fileInfoSkipReason(code: string): InboundSkipReason {
  if (code === "missing_scope" || code === "not_allowed_token_type" || code === "no_permission") return "missing-scope";
  return "unavailable";
}

/** The only host the bot token is sent to. */
const TOKEN_HOST = "files.slack.com";
const MAX_REDIRECTS = 3;
export const SLACK_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

function allowedDownloadHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === TOKEN_HOST || url.hostname.endsWith(".slack-edge.com"));
}

/**
 * Downloads a `url_private_download` with the bot token. Redirects are followed by hand (at most 3),
 * only to `files.slack.com` or `*.slack-edge.com` over https, and the token goes only to
 * `files.slack.com`. The body is read with a hard cap. An HTML page where the file is not HTML is
 * Slack's login page, which is what a token without `files:read` gets.
 */
export async function downloadSlackFile(input: {
  readonly url: string;
  readonly token: { exposeToBoundary(): string };
  readonly maxBytes: number;
  /** The file's declared mimetype, to tell a login page from a real HTML file. */
  readonly declaredMimeType?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Tests route the Slack hosts to a local fake. */
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): Promise<SlackDownload> {
  const send = input.fetch ?? ((url: URL, init: RequestInit) => fetch(url, init));
  const timeout = AbortSignal.timeout(input.timeoutMs ?? SLACK_FILE_DOWNLOAD_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SlackFileError("unavailable");
  }
  if (url.protocol !== "https:" || url.hostname !== TOKEN_HOST) throw new SlackFileError("unavailable");
  let response: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const current: Response = await send(url, {
        redirect: "manual",
        signal,
        headers: url.hostname === TOKEN_HOST ? { authorization: `Bearer ${input.token.exposeToBoundary()}` } : {},
      });
      if (current.status < 300 || current.status >= 400) {
        response = current;
        break;
      }
      await current.body?.cancel();
      const location = current.headers.get("location");
      if (location === null) throw new SlackFileError("download-failed");
      const next = new URL(location, url);
      if (!allowedDownloadHost(next)) throw new SlackFileError("download-failed");
      url = next;
    }
  } catch (error) {
    if (input.signal?.aborted === true) throw input.signal.reason;
    if (error instanceof SlackFileError) throw error;
    throw new SlackFileError("download-failed");
  }
  if (response === null) throw new SlackFileError("download-failed");
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new SlackFileError(response.status === 401 || response.status === 403 ? "missing-scope" : "download-failed");
  }
  const contentType = response.headers.get("content-type");
  if (contentType?.toLowerCase().startsWith("text/html") === true && input.declaredMimeType !== "text/html") {
    await response.body.cancel();
    throw new SlackFileError("missing-scope");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > input.maxBytes) throw new SlackFileError("too-large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (input.signal?.aborted === true) throw input.signal.reason;
    if (error instanceof SlackFileError) throw error;
    throw new SlackFileError("download-failed");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}

/** Modes Slack uses for files whose bytes Agent Tag cannot or should not read. */
const EXTERNAL_MODES = new Set(["external"]);
const UNAVAILABLE_MODES = new Set(["tombstone", "hidden_by_limit"]);
/** Canvases have no downloadable body (UNCONFIRMED filetype values; both are seen in the wild). */
const CANVAS_FILETYPES = new Set(["quip", "canvas"]);
const T3_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

/** A single-line display name of at most 255 characters (T3's attachment name cap). */
export function inboundFileName(ref: InboundFileRef, info?: SlackFileInfo): string {
  const raw = info?.name ?? ref.name ?? "";
  const name = raw.replace(/\p{C}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 255).trim();
  return name === "" ? ref.id : name;
}

/** Lowercase extension of a file name, or null. */
export function fileExtension(name: string): string | null {
  return /\.([a-z0-9]{1,16})$/i.exec(name)?.[1]?.toLowerCase() ?? null;
}

function normalizedMime(mime: string | undefined): string | null {
  if (mime === undefined) return null;
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "image/jpg") return "image/jpeg";
  return MIME_TYPE.test(base) ? base : null;
}

/** The skip reason decidable from metadata alone (before any download), or null to download. */
export function precheckInboundFile(
  ordinal: number,
  ref: InboundFileRef,
  info: SlackFileInfo,
  limits: InboundFileLimits,
): InboundSkipReason | null {
  if (ordinal >= limits.maxFilesPerMessage) return "limit-count";
  const mode = info.mode ?? ref.mode;
  if (info.isExternal || (mode !== undefined && EXTERNAL_MODES.has(mode))) return "external";
  if (mode !== undefined && UNAVAILABLE_MODES.has(mode)) return "unavailable";
  const filetype = (info.filetype ?? ref.filetype)?.toLowerCase();
  if (filetype !== undefined && CANVAS_FILETYPES.has(filetype)) return "type-denied";
  const extension = fileExtension(inboundFileName(ref, info));
  if (extension !== null && limits.deniedExtensions.includes(extension)) return "type-denied";
  const size = info.size ?? ref.size;
  if (size !== undefined && size > Math.max(limits.maxImageBytes, limits.maxFileBytes)) return "too-large";
  if (size === 0) return "unavailable";
  if (info.urlPrivateDownload === undefined) return "unavailable";
  return null;
}

export type InboundDecision =
  | { readonly kind: "attach"; readonly type: T3Attachment["type"]; readonly mimeType: string; readonly name: string }
  | { readonly kind: "skip"; readonly reason: InboundSkipReason };

/**
 * Classifies downloaded bytes. `image` only when the magic bytes are PNG, JPEG, GIF or WebP, with the
 * sniffed type; a file declared as one of those types whose bytes are not that type is skipped. An
 * image over `maxImageBytes` that fits `maxFileBytes` is sent as a generic file.
 */
export function classifyInboundFile(
  ref: InboundFileRef,
  info: SlackFileInfo,
  bytes: Uint8Array,
  limits: InboundFileLimits,
): InboundDecision {
  const name = inboundFileName(ref, info);
  if (bytes.byteLength === 0) return { kind: "skip", reason: "unavailable" };
  const declared = normalizedMime(info.mimetype ?? ref.mimetype);
  const sniffed = sniffImageMime(bytes);
  if (declared !== null && T3_IMAGE_MIMES.has(declared) && sniffed !== declared) {
    return { kind: "skip", reason: "type-mismatch" };
  }
  if (sniffed !== null && bytes.byteLength <= limits.maxImageBytes) {
    return { kind: "attach", type: "image", mimeType: sniffed, name };
  }
  if (bytes.byteLength > limits.maxFileBytes) return { kind: "skip", reason: "too-large" };
  const mode = info.mode ?? ref.mode;
  const mimeType = sniffed ?? (mode === "snippet" ? "text/plain" : declared ?? "application/octet-stream");
  return { kind: "attach", type: "file", mimeType, name };
}

export interface MaterializeInboundFilesInput {
  readonly refs: readonly InboundFileRef[];
  /** Outcomes recorded by an earlier attempt; their ordinals are not processed again. */
  readonly recorded: readonly OperationAttachment[];
  readonly limits: InboundFileLimits;
  /** Absent: Slack file reads are not available, so every file is skipped as unavailable. */
  readonly slack?: SlackFileClient;
  readonly upload: T3AttachmentUploader;
  /** Persists one outcome (under the operation lease) and returns the stored row. */
  readonly record: (input: {
    readonly ordinal: number;
    readonly ref: InboundFileRef;
    readonly outcome: { readonly attachment: T3Attachment } | { readonly skipReason: InboundSkipReason };
    readonly sizeBytes: number | null;
  }) => OperationAttachment;
  readonly signal?: AbortSignal;
}

function slackCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { error?: unknown } }).data;
    if (typeof data?.error === "string") return data.error;
  }
  return "unknown_error";
}

/**
 * Attaches or skips every ref, in payload order, and returns all outcomes by ordinal. Per-file Slack
 * failures become skips. A T3 upload failure or an abort propagates, leaving that ordinal unrecorded
 * so the operation's retry tries it again.
 */
export async function materializeInboundFiles(input: MaterializeInboundFilesInput): Promise<OperationAttachment[]> {
  const outcomes = new Map(input.recorded.map((row) => [row.ordinal, row]));
  for (const [ordinal, ref] of input.refs.entries()) {
    if (outcomes.has(ordinal)) continue;
    input.signal?.throwIfAborted();
    const skip = (reason: InboundSkipReason, sizeBytes: number | null = ref.size ?? null) =>
      input.record({ ordinal, ref, outcome: { skipReason: reason }, sizeBytes });
    if (!input.limits.enabled) {
      outcomes.set(ordinal, skip("disabled"));
      continue;
    }
    if (ordinal >= input.limits.maxFilesPerMessage) {
      outcomes.set(ordinal, skip("limit-count"));
      continue;
    }
    if (input.slack === undefined) {
      outcomes.set(ordinal, skip("unavailable"));
      continue;
    }
    let info: SlackFileInfo;
    try {
      info = await input.slack.info(ref.id, input.signal);
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      outcomes.set(ordinal, skip(error instanceof SlackFileError ? error.reason : fileInfoSkipReason(slackCode(error))));
      continue;
    }
    const precheck = precheckInboundFile(ordinal, ref, info, input.limits);
    if (precheck !== null) {
      outcomes.set(ordinal, skip(precheck, info.size ?? ref.size ?? null));
      continue;
    }
    let download: SlackDownload;
    try {
      download = await input.slack.download(
        info.urlPrivateDownload ?? "",
        Math.max(input.limits.maxImageBytes, input.limits.maxFileBytes),
        input.signal,
      );
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      outcomes.set(ordinal, skip(error instanceof SlackFileError ? error.reason : "download-failed", info.size ?? null));
      continue;
    }
    const decision = classifyInboundFile(ref, info, download.bytes, input.limits);
    if (decision.kind === "skip") {
      outcomes.set(ordinal, skip(decision.reason, download.bytes.byteLength));
      continue;
    }
    const attachment = await input.upload({
      type: decision.type,
      name: decision.name,
      mimeType: decision.mimeType,
      data: new Blob([download.bytes], { type: decision.mimeType }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    outcomes.set(ordinal, input.record({ ordinal, ref, outcome: { attachment }, sizeBytes: download.bytes.byteLength }));
  }
  return [...outcomes.values()].sort((left, right) => left.ordinal - right.ordinal);
}

/** The attachments for `thread.turn.start`, in payload order. */
export function attachedT3Attachments(rows: readonly OperationAttachment[]): T3Attachment[] {
  return rows.flatMap((row) => (row.state === "attached" ? [row.attachment] : []));
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
}

/** Plain-language reason a file was skipped; shared by the turn text and the Slack notice. */
export function describeSkipReason(reason: InboundSkipReason, limits: InboundFileLimits): string {
  switch (reason) {
    case "disabled":
      return "file attachments are turned off";
    case "limit-count":
      return `only the first ${limits.maxFilesPerMessage} files of a message are read`;
    case "too-large":
      return `larger than the ${formatMiB(Math.max(limits.maxImageBytes, limits.maxFileBytes))} limit`;
    case "external":
      return "it is stored outside Slack";
    case "unavailable":
      return "Slack did not make it available";
    case "type-denied":
      return "this file type is not accepted";
    case "type-mismatch":
      return "its contents do not match its file type";
    case "missing-scope":
      return "Agent Tag lacks the Slack permission to read files (the operator must reinstall the app)";
    case "download-failed":
      return "the download from Slack failed";
  }
}

/** The thread notice for skipped files, or null when every file was attached. */
export function skippedFilesNotice(
  refs: readonly InboundFileRef[],
  outcomes: readonly OperationAttachment[],
  limits: InboundFileLimits,
): string | null {
  const skipped = outcomes.flatMap((row) => {
    const ref = refs[row.ordinal];
    return row.state === "skipped" && ref !== undefined ? [{ name: inboundFileName(ref), reason: row.reason }] : [];
  });
  if (skipped.length === 0) return null;
  const lines = skipped.map((file) => `• ${escapeSlackText(file.name)}: ${describeSkipReason(file.reason, limits)}`);
  const count = skipped.length === 1 ? "1 file" : `${skipped.length} files`;
  return [`I couldn't read ${count} you shared, so I'm working without ${skipped.length === 1 ? "it" : "them"}:`, ...lines].join("\n");
}

/** The turn text's view of every shared file, in payload order. */
export function turnFiles(
  refs: readonly InboundFileRef[],
  outcomes: readonly OperationAttachment[],
  limits: InboundFileLimits,
): TurnFile[] {
  return outcomes.flatMap((row): TurnFile[] => {
    if (row.state === "attached") {
      const { attachment } = row;
      return [{ name: attachment.name, attached: attachment.type, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }];
    }
    const ref = refs[row.ordinal];
    return [{ name: ref === undefined ? row.slackFileId : inboundFileName(ref), skipped: describeSkipReason(row.reason, limits) }];
  });
}
