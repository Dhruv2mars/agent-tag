import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { SecretString } from "./secret-file.ts";

const SCAN_CHUNK_BYTES = 64 * 1_024;
const PATTERN_OVERLAP_BYTES = 256;
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export const KNOWN_CREDENTIAL_PATTERNS = [
  { name: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "slack-app-token", expression: /\bxapp-[A-Za-z0-9-]{20,}\b/ },
  { name: "github-token", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github-fine-grained-token", expression: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "anthropic-api-key", expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-api-key", expression: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "private-key", expression: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
] as const;

export interface SecretCanary {
  readonly name: string;
  readonly secret: SecretString;
}

export type SecretFinding =
  | {
      readonly kind: "exact-secret";
      readonly path: string;
      readonly canaryName: string;
    }
  | {
      readonly kind: "known-token-pattern";
      readonly path: string;
      readonly patternName: string;
    };

/** A credential found in a block of text. `line` is 1-based; the matched value is never returned. */
export type TextSecretFinding =
  | { readonly kind: "exact-secret"; readonly line: number; readonly canaryName: string }
  | { readonly kind: "known-token-pattern"; readonly line: number; readonly patternName: string };

/**
 * Scans in-memory text (for example the added lines of a diff, or commit messages) line by line for the
 * canaries and the known credential shapes in `KNOWN_CREDENTIAL_PATTERNS`. Each canary or pattern is
 * reported once per line. Findings carry only the line number and the class, never the matched value.
 */
export function scanTextForSecrets(
  text: string,
  options: { readonly canaries?: readonly SecretCanary[] } = {},
): readonly TextSecretFinding[] {
  const canaries = (options.canaries ?? []).map((canary) => ({
    name: canary.name,
    value: canary.secret.exposeToBoundary(),
  }));
  const findings: TextSecretFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    for (const canary of canaries) {
      if (line.includes(canary.value)) findings.push({ kind: "exact-secret", line: index + 1, canaryName: canary.name });
    }
    for (const pattern of KNOWN_CREDENTIAL_PATTERNS) {
      if (pattern.expression.test(line)) {
        findings.push({ kind: "known-token-pattern", line: index + 1, patternName: pattern.name });
      }
    }
  }
  return findings;
}

/** A path the scan could not check. `reason` is an error code (for example `EACCES`), never file content. */
export interface SkippedScanEntry {
  readonly path: string;
  readonly reason: string;
}

export interface SecretScanResult {
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly symlinksSkipped: number;
  /** Files and directories that could not be read. Findings from every other file are still reported. */
  readonly skippedEntries: readonly SkippedScanEntry[];
  readonly findings: readonly SecretFinding[];
}

/** Reason recorded for paths that were still being renamed or replaced when the scan gave up re-checking. */
export const CHANGED_DURING_SCAN = "changed during the scan";

/**
 * Passes over the tree. The first reads every file; each later pass re-lists the tree and reads files
 * (by device and inode) not yet read, or whose size or mtime changed since they were read. Content renamed
 * by log rotation or appended to a live log mid-scan is still checked.
 */
const MAX_SCAN_PASSES = 4;

interface PreparedCanary {
  readonly name: string;
  readonly bytes: Buffer;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unexpected error";
}

/** The path no longer names what was listed: it was removed, renamed, or replaced by a symlink. */
function vanished(code: string): boolean {
  return code === "ENOENT" || code === "ELOOP";
}

/** Identifies a file across renames: device and inode. */
function fileKey(metadata: { readonly dev: number; readonly ino: number }): string {
  return `${metadata.dev}:${metadata.ino}`;
}

/** Size and mtime: a change means the file was appended to or rewritten since it was read. */
function fileVersion(metadata: { readonly size: number; readonly mtimeMs: number }): string {
  return `${metadata.size}:${metadata.mtimeMs}`;
}

/** Device and inode of each file read, mapped to the version it had when it was opened. */
type ScannedVersions = ReadonlyMap<string, string>;

function alreadyRead(scanned: ScannedVersions, file: { readonly key: string; readonly version: string }): boolean {
  return scanned.get(file.key) === file.version;
}

interface Listing {
  readonly files: ReadonlyArray<{ readonly path: string; readonly key: string; readonly version: string }>;
  readonly symlinks: readonly string[];
  readonly unreadable: readonly SkippedScanEntry[];
  readonly vanished: readonly string[];
}

async function listFiles(input: {
  readonly roots: readonly string[];
  readonly excludedPaths: ReadonlySet<string>;
}): Promise<Listing> {
  const pending = [...input.roots];
  const files = new Map<string, { readonly key: string; readonly version: string }>();
  const symlinks: string[] = [];
  const unreadable: SkippedScanEntry[] = [];
  const gone: string[] = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || input.excludedPaths.has(path)) continue;
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        symlinks.push(path);
        continue;
      }
      if (metadata.isFile()) {
        files.set(path, { key: fileKey(metadata), version: fileVersion(metadata) });
        continue;
      }
      if (!metadata.isDirectory()) continue;

      const children: string[] = [];
      for await (const entry of await opendir(path)) {
        if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
        children.push(join(path, entry.name));
      }
      pending.push(...children);
    } catch (error) {
      const code = errorCode(error);
      if (vanished(code)) gone.push(path);
      else unreadable.push({ path, reason: code });
    }
  }

  return {
    files: [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, file]) => ({ path, ...file })),
    symlinks,
    unreadable,
    vanished: gone,
  };
}

type FileScan =
  | {
      readonly status: "scanned";
      readonly key: string;
      readonly version: string;
      readonly bytesScanned: number;
      readonly findings: readonly SecretFinding[];
    }
  | { readonly status: "already-scanned" }
  | { readonly status: "vanished" }
  | { readonly status: "failed"; readonly reason: string; readonly bytesScanned: number; readonly findings: readonly SecretFinding[] };

async function scanFile(input: {
  readonly path: string;
  readonly canaries: readonly PreparedCanary[];
  readonly overlapBytes: number;
  readonly scanned: ScannedVersions;
}): Promise<FileScan> {
  let handle: FileHandle;
  try {
    // O_NOFOLLOW: a file swapped for a symlink after listing is not followed out of the scanned tree.
    // O_NONBLOCK: a file swapped for a FIFO cannot hang the scan.
    handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const reason = errorCode(error);
    return vanished(reason) ? { status: "vanished" } : { status: "failed", reason, bytesScanned: 0, findings: [] };
  }

  const findings: SecretFinding[] = [];
  let bytesScanned = 0;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { status: "vanished" };
    // The version is taken before reading, so anything appended during or after the read shows up as a change.
    const file = { key: fileKey(metadata), version: fileVersion(metadata) };
    if (alreadyRead(input.scanned, file)) return { status: "already-scanned" };

    const foundCanaries = new Set<string>();
    const foundPatterns = new Set<string>();
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
    let tail = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytesScanned += bytesRead;
      const window = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
      for (const canary of input.canaries) {
        if (!foundCanaries.has(canary.name) && window.includes(canary.bytes)) {
          foundCanaries.add(canary.name);
          findings.push({ kind: "exact-secret", path: input.path, canaryName: canary.name });
        }
      }
      const text = window.toString("utf8");
      for (const pattern of KNOWN_CREDENTIAL_PATTERNS) {
        if (!foundPatterns.has(pattern.name) && pattern.expression.test(text)) {
          foundPatterns.add(pattern.name);
          findings.push({ kind: "known-token-pattern", path: input.path, patternName: pattern.name });
        }
      }
      tail = window.subarray(Math.max(0, window.length - input.overlapBytes));
    }
    return { status: "scanned", ...file, bytesScanned, findings };
  } catch (error) {
    // Keep whatever was found before the read failed.
    return { status: "failed", reason: errorCode(error), bytesScanned, findings };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function findingKey(finding: SecretFinding): string {
  return finding.kind === "exact-secret"
    ? `${finding.path}\0exact\0${finding.canaryName}`
    : `${finding.path}\0pattern\0${finding.patternName}`;
}

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Scans every regular file under `roots` for the canaries and known credential shapes. A file or directory
 * that cannot be read is reported in `skippedEntries` and does not stop the scan.
 */
export async function scanForSecrets(input: {
  readonly roots: readonly string[];
  readonly canaries?: readonly SecretCanary[];
  readonly excludedPaths?: readonly string[];
  /** Test seam: runs after each file is read, before the next one is opened. */
  readonly afterFile?: (path: string) => void | Promise<void>;
}): Promise<SecretScanResult> {
  if (input.roots.length === 0) throw new Error("secret scan requires at least one root");
  for (const root of input.roots) {
    if (!isAbsolute(root)) throw new Error(`secret scan root must be absolute: ${root}`);
  }
  const skipped = new Map<string, string>();
  const roots: string[] = [];
  for (const root of new Set(input.roots.map((path) => resolve(path)))) {
    try {
      roots.push(await realpath(root));
    } catch (error) {
      skipped.set(root, errorCode(error));
    }
  }
  const excludedPaths = new Set(await Promise.all((input.excludedPaths ?? []).map(canonicalOrResolved)));
  const canaries = (input.canaries ?? []).map((canary) => ({
    name: canary.name,
    bytes: Buffer.from(canary.secret.exposeToBoundary(), "utf8"),
  }));
  const overlapBytes = Math.max(
    PATTERN_OVERLAP_BYTES,
    ...canaries.map((canary) => Math.max(0, canary.bytes.length - 1)),
  );

  const scanned = new Map<string, string>();
  const symlinks = new Set<string>();
  const findings = new Map<string, SecretFinding>();
  let bytesScanned = 0;
  for (let pass = 1; pass <= MAX_SCAN_PASSES && roots.length > 0; pass += 1) {
    const listing = await listFiles({ roots: [...new Set(roots)], excludedPaths });
    for (const path of listing.symlinks) symlinks.add(path);
    for (const entry of listing.unreadable) skipped.set(entry.path, entry.reason);
    const changed = [...listing.vanished];
    for (const file of listing.files) {
      if (alreadyRead(scanned, file) || skipped.has(file.path)) continue;
      const result = await scanFile({ path: file.path, canaries, overlapBytes, scanned });
      if (result.status === "scanned" || result.status === "failed") {
        bytesScanned += result.bytesScanned;
        for (const finding of result.findings) findings.set(findingKey(finding), finding);
      }
      if (result.status === "scanned") {
        scanned.set(result.key, result.version);
        changed.push(file.path);
      } else if (result.status === "vanished") {
        changed.push(file.path);
      } else if (result.status === "failed") {
        skipped.set(file.path, result.reason);
      }
      await input.afterFile?.(file.path);
    }
    // The first pass always gets a verification pass: rotation can rename a file without any read error,
    // and a live log can grow after it was read. A later pass that reads nothing new or changed and sees
    // nothing vanish means the tree held still.
    if (pass > 1 && changed.length === 0) break;
    if (pass === MAX_SCAN_PASSES) {
      for (const path of changed) if (!skipped.has(path)) skipped.set(path, CHANGED_DURING_SCAN);
    }
  }

  return {
    filesScanned: scanned.size,
    bytesScanned,
    symlinksSkipped: symlinks.size,
    skippedEntries: [...skipped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, reason]) => ({ path, reason })),
    findings: [...findings.values()],
  };
}
