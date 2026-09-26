import { createReadStream } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { SecretString } from "./secret-file.ts";

const SCAN_CHUNK_BYTES = 64 * 1_024;
const PATTERN_OVERLAP_BYTES = 256;
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

const knownCredentialPatterns = [
  { name: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "slack-app-token", expression: /\bxapp-[A-Za-z0-9-]{20,}\b/ },
  { name: "github-token", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "anthropic-api-key", expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-api-key", expression: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
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

export interface SecretScanResult {
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly symlinksSkipped: number;
  readonly findings: readonly SecretFinding[];
}

interface PreparedCanary {
  readonly name: string;
  readonly bytes: Buffer;
}

async function listFiles(input: {
  readonly roots: readonly string[];
  readonly excludedPaths: ReadonlySet<string>;
}): Promise<{ readonly files: readonly string[]; readonly symlinksSkipped: number }> {
  const roots = [...new Set(input.roots.map((root) => resolve(root)))];
  const pending = [...roots];
  const files = new Set<string>();
  let symlinksSkipped = 0;

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || input.excludedPaths.has(path)) continue;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      symlinksSkipped += 1;
      continue;
    }
    if (metadata.isFile()) {
      files.add(path);
      continue;
    }
    if (!metadata.isDirectory()) continue;

    const directory = await opendir(path);
    for await (const entry of directory) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      pending.push(join(path, entry.name));
    }
  }

  return { files: [...files].sort(), symlinksSkipped };
}

async function scanFile(input: {
  readonly path: string;
  readonly canaries: readonly PreparedCanary[];
  readonly overlapBytes: number;
}): Promise<{ readonly bytesScanned: number; readonly findings: readonly SecretFinding[] }> {
  const findings: SecretFinding[] = [];
  const foundCanaries = new Set<string>();
  const foundPatterns = new Set<string>();
  let tail = Buffer.alloc(0);
  let bytesScanned = 0;

  for await (const chunk of createReadStream(input.path, { highWaterMark: SCAN_CHUNK_BYTES })) {
    if (!Buffer.isBuffer(chunk)) throw new Error("secret scanner received a non-buffer chunk");
    bytesScanned += chunk.length;
    const window = Buffer.concat([tail, chunk]);
    for (const canary of input.canaries) {
      if (!foundCanaries.has(canary.name) && window.includes(canary.bytes)) {
        foundCanaries.add(canary.name);
        findings.push({ kind: "exact-secret", path: input.path, canaryName: canary.name });
      }
    }
    const text = window.toString("utf8");
    for (const pattern of knownCredentialPatterns) {
      if (!foundPatterns.has(pattern.name) && pattern.expression.test(text)) {
        foundPatterns.add(pattern.name);
        findings.push({ kind: "known-token-pattern", path: input.path, patternName: pattern.name });
      }
    }
    tail = window.subarray(Math.max(0, window.length - input.overlapBytes));
  }

  return { bytesScanned, findings };
}

export async function scanForSecrets(input: {
  readonly roots: readonly string[];
  readonly canaries?: readonly SecretCanary[];
  readonly excludedPaths?: readonly string[];
}): Promise<SecretScanResult> {
  if (input.roots.length === 0) throw new Error("secret scan requires at least one root");
  const roots = await Promise.all(
    input.roots.map(async (root) => {
      if (!isAbsolute(root)) throw new Error(`secret scan root must be absolute: ${root}`);
      return realpath(root);
    }),
  );
  const excludedPaths = new Set(
    await Promise.all((input.excludedPaths ?? []).map((path) => realpath(path))),
  );
  const canaries = (input.canaries ?? []).map((canary) => ({
    name: canary.name,
    bytes: Buffer.from(canary.secret.exposeToBoundary(), "utf8"),
  }));
  const overlapBytes = Math.max(
    PATTERN_OVERLAP_BYTES,
    ...canaries.map((canary) => Math.max(0, canary.bytes.length - 1)),
  );
  const listed = await listFiles({ roots, excludedPaths });
  let bytesScanned = 0;
  const findings: SecretFinding[] = [];
  for (const path of listed.files) {
    const result = await scanFile({ path, canaries, overlapBytes });
    bytesScanned += result.bytesScanned;
    findings.push(...result.findings);
  }
  return {
    filesScanned: listed.files.length,
    bytesScanned,
    symlinksSkipped: listed.symlinksSkipped,
    findings,
  };
}
