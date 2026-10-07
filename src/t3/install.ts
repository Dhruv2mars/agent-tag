import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { z } from "zod";

import { type CommandRunner, runCommand as defaultRunCommand } from "../command.ts";
import { compareVersions } from "../release.ts";
import { defaultT3DownloadBaseUrl, t3ArtifactFor, t3ArtifactUrl, type T3Artifact } from "./lock.ts";
import { type T3Pin, verifyT3Binary } from "./pin.ts";

/** Real archives are 65-73 MB; the cap only bounds a hostile or broken mirror. */
export const MAX_T3_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_T3_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_T3_EXPANDED_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_DOWNLOAD_MS = 60 * 60 * 1000;
const INSTALL_RECORD = "agent-tag-install.json";

export class T3ArtifactVerificationError extends Error {
  override readonly name = "T3ArtifactVerificationError";
}
export class T3ArchiveRejectedError extends Error {
  override readonly name = "T3ArchiveRejectedError";
}
export class T3UnsupportedPlatformError extends Error {
  override readonly name = "T3UnsupportedPlatformError";
}
export class T3DowngradeError extends Error {
  override readonly name = "T3DowngradeError";
}

export type T3InstallEvent = "t3.install.downloading" | "t3.install.installed" | "t3.install.tampered" | "t3.install.pruned";
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface InstallPinnedT3Options {
  readonly pin: T3Pin;
  readonly runtimeDir: string;
  readonly downloadBaseUrl?: string;
  readonly fetch?: Fetch;
  readonly runCommand?: CommandRunner;
  readonly log?: (event: T3InstallEvent, detail: string) => void;
  readonly platform?: string;
  readonly arch?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export interface InstalledT3 {
  readonly version: string;
  readonly target: string;
  readonly root: string;
  readonly binary: string;
  readonly binarySha256: string;
  readonly archiveSha256: string;
  readonly installedAt: string;
  /** False when an already verified install was reused. */
  readonly downloaded: boolean;
}

const installRecordSchema = z.object({
  version: z.string(),
  artifact: z.string(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.iso.datetime(),
});
type InstallRecord = z.infer<typeof installRecordSchema>;

const runtimeStateSchema = z.object({ highestVersionStarted: z.string().optional() });

/** `<dataDir>/t3/runtime`, the spec default for managed T3 binaries and state. */
export function defaultT3RuntimeDir(dataDir: string): string {
  return join(dataDir, "t3", "runtime");
}

/** Mirrors must use https; plain http is accepted only on loopback (local mirrors, tests). */
export function parseT3DownloadBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid T3 download base URL: ${value}`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`T3 download base URL must use https: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

function requireArtifact(pin: T3Pin, platform: string, arch: string): T3Artifact {
  const artifact = t3ArtifactFor(pin, platform, arch);
  if (artifact === undefined) {
    throw new T3UnsupportedPlatformError(
      `managed T3 is unavailable on ${platform}-${arch}: t3.lock.json pins no artifact for it; run T3 yourself and point t3.baseUrl at it`,
    );
  }
  return artifact;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`T3 runtime path is not a directory: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`T3 runtime directory must not grant group or world access: ${path} (run chmod 700 on it)`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`T3 runtime directory must be owned by the Agent Tag user: ${path}`);
  }
}

async function readInstallRecord(root: string): Promise<InstallRecord | undefined> {
  try {
    return installRecordSchema.parse(await Bun.file(join(root, INSTALL_RECORD)).json());
  } catch {
    return undefined;
  }
}

type InstalledCheck =
  | { readonly kind: "missing" }
  | { readonly kind: "tampered"; readonly reason: string }
  | { readonly kind: "verified"; readonly record: InstallRecord };

/** Checks `versions/<v>` against its install record and the pin, re-hashing the binary. */
async function checkInstalled(root: string, pin: T3Pin, artifact: T3Artifact): Promise<InstalledCheck> {
  if (!(await exists(root))) return { kind: "missing" };
  const record = await readInstallRecord(root);
  if (record === undefined) return { kind: "tampered", reason: `missing or invalid ${INSTALL_RECORD}` };
  if (record.version !== pin.version || record.artifact !== artifact.name || record.archiveSha256 !== artifact.sha256) {
    return { kind: "tampered", reason: `${INSTALL_RECORD} does not match t3.lock.json` };
  }
  const binary = join(root, "t3");
  if (!(await exists(binary))) return { kind: "tampered", reason: "t3 binary is missing" };
  if ((await sha256File(binary)) !== record.binarySha256) {
    return { kind: "tampered", reason: "t3 binary sha256 differs from the install record" };
  }
  return { kind: "verified", record };
}

async function assertNoDowngrade(runtimeDir: string, pin: T3Pin): Promise<void> {
  const path = join(runtimeDir, "state.json");
  if (!(await exists(path))) return;
  const state = runtimeStateSchema.parse(await Bun.file(path).json());
  const highest = state.highestVersionStarted;
  if (highest !== undefined && compareVersions(highest, pin.version) > 0) {
    throw new T3DowngradeError(
      `refusing to install T3 ${pin.version}: T3 ${highest} already ran against this runtime and migrates its database forward only; keep the newer Agent Tag or reset the T3 home directory`,
    );
  }
}

async function removeStaleDownloads(downloads: string, now: Date): Promise<void> {
  for (const name of await readdir(downloads).catch(() => [])) {
    const path = join(downloads, name);
    const metadata = await stat(path).catch(() => undefined);
    if (metadata !== undefined && now.getTime() - metadata.mtimeMs > STALE_DOWNLOAD_MS) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

async function download(input: {
  readonly url: string;
  readonly destination: string;
  readonly fetch: Fetch;
  readonly timeoutMs: number;
}): Promise<string> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: { "user-agent": "agent-tag-t3-install" },
    });
  } catch (error) {
    throw new Error(`downloading ${input.url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`downloading ${input.url} failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_T3_ARCHIVE_BYTES) {
    await response.body.cancel();
    throw new T3ArtifactVerificationError(`${input.url} is ${declared} bytes, over the ${MAX_T3_ARCHIVE_BYTES}-byte limit`);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const file = await open(input.destination, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_T3_ARCHIVE_BYTES) {
        throw new T3ArtifactVerificationError(`${input.url} exceeded the ${MAX_T3_ARCHIVE_BYTES}-byte limit`);
      }
      hasher.update(chunk);
      await file.write(chunk);
    }
    await file.sync();
  } catch (error) {
    if (error instanceof T3ArtifactVerificationError) throw error;
    throw new Error(`downloading ${input.url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await file.close();
  }
  return hasher.digest("hex");
}

export interface T3ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
}

function cString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function octal(block: Buffer, offset: number, length: number, what: string): number {
  if ((block[offset]! & 0x80) !== 0) throw new T3ArchiveRejectedError(`archive uses an unsupported base-256 ${what}`);
  const text = cString(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new T3ArchiveRejectedError(`archive has a malformed ${what}`);
  return Number.parseInt(text, 8);
}

function parsePax(content: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number(content.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0 || offset + length > content.length) {
      throw new T3ArchiveRejectedError("archive has a malformed pax header");
    }
    const record = content.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals === -1) throw new T3ArchiveRejectedError("archive has a malformed pax header");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

const REJECTED_TYPES: Readonly<Record<string, string>> = {
  "1": "hard link",
  "2": "symbolic link",
  "3": "character device",
  "4": "block device",
  "6": "FIFO",
  K: "long link name",
};

/**
 * Lists a .tar.gz in-process (no system tar), rejecting anything but regular files and
 * directories under exactly `<topDir>/`, `..` segments, absolute paths, and oversized entries.
 * Runs before extraction so a hostile archive never touches the filesystem.
 */
export async function inspectT3Archive(path: string, topDir: string): Promise<T3ArchiveEntry[]> {
  const entries: T3ArchiveEntry[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let skip = 0;
  let capture: { readonly type: string; readonly size: number; readonly padded: number } | undefined;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let expanded = 0;
  let ended = false;

  const accept = (header: Buffer): void => {
    const type = String.fromCharCode(header[156]!);
    const rawName = header.subarray(257, 262).toString("latin1") === "ustar"
      ? [cString(header, 345, 155), cString(header, 0, 100)].filter((part) => part !== "").join("/")
      : cString(header, 0, 100);
    const name = pax.get("path") ?? longName ?? rawName;
    const size = pax.has("size") ? Number(pax.get("size")) : octal(header, 124, 12, "entry size");
    pax = new Map();
    longName = undefined;
    const rejected = REJECTED_TYPES[type];
    if (rejected !== undefined) throw new T3ArchiveRejectedError(`archive entry ${name} is a ${rejected}`);
    const kind = type === "5" ? "directory" : type === "0" || type === "\0" || type === "7" ? "file" : undefined;
    if (kind === undefined) throw new T3ArchiveRejectedError(`archive entry ${name} has unsupported type ${JSON.stringify(type)}`);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_T3_ENTRY_BYTES) {
      throw new T3ArchiveRejectedError(`archive entry ${name} is larger than ${MAX_T3_ENTRY_BYTES} bytes`);
    }
    expanded += size;
    if (expanded > MAX_T3_EXPANDED_BYTES) throw new T3ArchiveRejectedError(`archive expands past ${MAX_T3_EXPANDED_BYTES} bytes`);
    if (name.startsWith("/")) throw new T3ArchiveRejectedError(`archive entry ${name} is an absolute path`);
    const segments = name.replace(/\/+$/, "").split("/");
    if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
      throw new T3ArchiveRejectedError(`archive entry ${name} has an unsafe path segment`);
    }
    if (segments[0] !== topDir || (segments.length === 1 && kind !== "directory")) {
      throw new T3ArchiveRejectedError(`archive entry ${name} is outside ${topDir}/`);
    }
    entries.push({ path: segments.join("/"), type: kind, size });
    if (kind === "file") skip = Math.ceil(size / 512) * 512;
  };

  const file = createReadStream(path);
  const stream = file.pipe(createGunzip());
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (ended) continue;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (!ended) {
        if (skip > 0) {
          const consumed = Math.min(skip, buffer.length);
          buffer = buffer.subarray(consumed);
          skip -= consumed;
          if (skip > 0) break;
          continue;
        }
        if (capture !== undefined) {
          if (buffer.length < capture.padded) break;
          const content = buffer.subarray(0, capture.size);
          buffer = buffer.subarray(capture.padded);
          if (capture.type === "x") pax = parsePax(content);
          else if (capture.type === "L") longName = cString(content, 0, content.length);
          else if (parsePax(content).has("path")) throw new T3ArchiveRejectedError("archive has a global path override");
          capture = undefined;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        let checksum = 0;
        for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
        if (checksum !== octal(header, 148, 8, "header checksum")) throw new T3ArchiveRejectedError("archive has a corrupt tar header");
        const type = String.fromCharCode(header[156]!);
        if (type === "x" || type === "g" || type === "L") {
          const size = octal(header, 124, 12, "header size");
          if (size > 1024 * 1024) throw new T3ArchiveRejectedError("archive has an oversized metadata header");
          capture = { type, size, padded: Math.ceil(size / 512) * 512 };
        } else {
          accept(header);
        }
      }
    }
  } catch (error) {
    if (error instanceof T3ArchiveRejectedError) throw error;
    throw new T3ArchiveRejectedError(`archive is not a valid .tar.gz: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stream.destroy();
    file.destroy();
  }
  if (!ended || skip > 0 || capture !== undefined) throw new T3ArchiveRejectedError("archive is truncated");
  if (!entries.some((entry) => entry.type === "file" && entry.path === `${topDir}/t3`)) {
    throw new T3ArchiveRejectedError(`archive has no ${topDir}/t3 binary`);
  }
  return entries;
}

async function prune(versionsDir: string, pinned: string, log: InstallPinnedT3Options["log"]): Promise<void> {
  const others = (await readdir(versionsDir))
    .filter((name) => name !== pinned && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name))
    .sort((left, right) => compareVersions(right, left));
  for (const name of others.slice(1)) {
    await rm(join(versionsDir, name), { recursive: true, force: true });
    log?.("t3.install.pruned", name);
  }
}

function installed(root: string, target: string, record: InstallRecord, downloaded: boolean): InstalledT3 {
  return {
    version: record.version,
    target,
    root,
    binary: join(root, "t3"),
    binarySha256: record.binarySha256,
    archiveSha256: record.archiveSha256,
    installedAt: record.installedAt,
    downloaded,
  };
}

/**
 * Installs the pinned T3 release under `<runtimeDir>/versions/<version>`: download, sha256 check
 * against t3.lock.json, listing check, extract into `downloads/<nonce>`, `t3 --version` check, then
 * one atomic rename. A verified existing install is reused; a tampered one is replaced.
 */
export async function installPinnedT3(options: InstallPinnedT3Options): Promise<InstalledT3> {
  const { pin, runtimeDir } = options;
  const run = options.runCommand ?? defaultRunCommand;
  const now = options.now ?? (() => new Date());
  const artifact = requireArtifact(pin, options.platform ?? process.platform, options.arch ?? process.arch);
  await ensurePrivateDirectory(runtimeDir);
  await assertNoDowngrade(runtimeDir, pin);

  const versionsDir = join(runtimeDir, "versions");
  const root = join(versionsDir, pin.version);
  const existing = await checkInstalled(root, pin, artifact);
  if (existing.kind === "verified") {
    await verifyT3Binary({ pin, binary: join(root, "t3") });
    return installed(root, artifact.target, existing.record, false);
  }
  if (existing.kind === "tampered") {
    options.log?.("t3.install.tampered", `${root}: ${existing.reason}; reinstalling`);
    await rm(root, { recursive: true, force: true });
  }

  const downloads = join(runtimeDir, "downloads");
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await removeStaleDownloads(downloads, now());
  const staging = join(downloads, randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    const url = t3ArtifactUrl(pin, artifact.name, options.downloadBaseUrl ?? defaultT3DownloadBaseUrl(pin));
    options.log?.("t3.install.downloading", url);
    const archive = join(staging, "archive.tar.gz");
    const archiveSha256 = await download({
      url,
      destination: archive,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    });
    if (archiveSha256 !== artifact.sha256) {
      throw new T3ArtifactVerificationError(
        `${artifact.name} sha256 mismatch: expected ${artifact.sha256} from t3.lock.json, got ${archiveSha256}`,
      );
    }

    const topDir = `t3-${pin.version}-${artifact.target}`;
    await inspectT3Archive(archive, topDir);
    const extractDir = join(staging, "x");
    await mkdir(extractDir, { mode: 0o700 });
    const extracted = await run(["tar", "-xzf", archive, "-C", extractDir, "--no-same-owner", "--no-same-permissions"]);
    if (extracted.exitCode !== 0) throw new Error(`extracting ${artifact.name} failed: ${extracted.stderr}`);
    const stagedRoot = join(extractDir, topDir);
    const locked = await run(["chmod", "-R", "go-w", stagedRoot]);
    if (locked.exitCode !== 0) throw new Error(`restricting ${stagedRoot} failed: ${locked.stderr}`);
    const stagedBinary = join(stagedRoot, "t3");
    await chmod(stagedBinary, 0o755);
    await verifyT3Binary({ pin, binary: stagedBinary });

    const record: InstallRecord = {
      version: pin.version,
      artifact: artifact.name,
      archiveSha256,
      binarySha256: await sha256File(stagedBinary),
      installedAt: now().toISOString(),
    };
    await writeFile(join(stagedRoot, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    try {
      await rename(stagedRoot, root);
    } catch (error) {
      // A concurrent install won the rename; reuse it if it verifies.
      const raced = await checkInstalled(root, pin, artifact);
      if (raced.kind !== "verified") throw error;
      return installed(root, artifact.target, raced.record, false);
    }
    options.log?.("t3.install.installed", `${pin.version} at ${root}`);
    await prune(versionsDir, pin.version, options.log);
    return installed(root, artifact.target, record, true);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface T3InstallStatus {
  readonly pinnedVersion: string;
  readonly target: string;
  readonly supported: boolean;
  readonly runtimeDir: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly binary: string | null;
  readonly binarySha256: string | null;
  readonly binarySha256Verified: boolean;
  readonly installedAt: string | null;
  readonly problem: string | null;
}

/** Read-only view of the managed install: never downloads, creates directories, or runs T3. */
export async function inspectInstalledT3(input: {
  readonly pin: T3Pin;
  readonly runtimeDir: string;
  readonly platform?: string;
  readonly arch?: string;
}): Promise<T3InstallStatus> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const artifact = t3ArtifactFor(input.pin, platform, arch);
  const root = join(input.runtimeDir, "versions", input.pin.version);
  const base = {
    pinnedVersion: input.pin.version,
    target: `${platform}-${arch}`,
    supported: artifact !== undefined,
    runtimeDir: input.runtimeDir,
  };
  const check: InstalledCheck = artifact === undefined ? { kind: "missing" } : await checkInstalled(root, input.pin, artifact);
  if (check.kind === "verified") {
    return {
      ...base,
      installed: true,
      version: check.record.version,
      binary: join(root, "t3"),
      binarySha256: check.record.binarySha256,
      binarySha256Verified: true,
      installedAt: check.record.installedAt,
      problem: null,
    };
  }
  const record = check.kind === "tampered" ? await readInstallRecord(root) : undefined;
  return {
    ...base,
    installed: check.kind === "tampered",
    version: record?.version ?? null,
    binary: check.kind === "tampered" ? join(root, "t3") : null,
    binarySha256: record?.binarySha256 ?? null,
    binarySha256Verified: false,
    installedAt: record?.installedAt ?? null,
    problem: check.kind === "tampered"
      ? `${check.reason}; run agent-tag t3 install to replace it`
      : artifact === undefined
        ? `t3.lock.json pins no artifact for ${platform}-${arch}`
        : null,
  };
}
