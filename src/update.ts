import { randomBytes } from "node:crypto";
import { chmod, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  compareVersions,
  DEFAULT_RELEASE_BASE_URL,
  normalizeReleaseTag,
  parseSha256Sums,
  releaseAssetName,
  releaseAssetUrl,
  SHA256SUMS_ASSET,
  sha256Hex,
  tagFromLatestRedirect,
  versionFromTag,
} from "./release.ts";
import type { BuildInfo } from "./version.ts";

const METADATA_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 10 * 60_000;
const SMOKE_TEST_TIMEOUT_MS = 30_000;
const TEMPORARY_PREFIX = ".agent-tag-update-";

export interface UpdateOptions {
  readonly check: boolean;
  readonly version: string | undefined;
}

export interface UpdateDependencies {
  readonly build: BuildInfo;
  readonly execPath: string;
  readonly releaseBaseUrl: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly log: (line: string) => void;
}

export type UpdateResult =
  | { readonly status: "up-to-date"; readonly current: string; readonly latest: string }
  | { readonly status: "available"; readonly current: string; readonly latest: string }
  | { readonly status: "updated"; readonly previous: string; readonly current: string; readonly path: string };

export function parseUpdateArguments(argv: readonly string[]): UpdateOptions {
  let check = false;
  let version: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--version") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--version requires a value");
      version = versionFromTag(normalizeReleaseTag(value));
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--version=")) {
      version = versionFromTag(normalizeReleaseTag(argument.slice("--version=".length)));
    } else {
      throw new Error(`unknown update option: ${argument}`);
    }
  }
  return { check, version };
}

export function releaseBaseUrlFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const override = env.AGENT_TAG_RELEASE_BASE_URL;
  if (override === undefined || override === "") return DEFAULT_RELEASE_BASE_URL;
  const url = new URL(override);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("AGENT_TAG_RELEASE_BASE_URL must be an http(s) URL");
  }
  return override.replace(/\/+$/, "");
}

/** Explains how to update an install that is not a self-replacing release binary. */
export function nonBinaryUpdateGuidance(build: BuildInfo): string {
  if (build.installKind === "container") {
    return "agent-tag is running from a container image; pull a newer image tag and recreate the container instead of `agent-tag update`.";
  }
  return [
    "agent-tag is running from a source checkout, so `agent-tag update` will not replace anything.",
    "Update the checkout instead: git pull && bun install --frozen-lockfile",
    "Then restart the service (on macOS: bun run service:upgrade -- /absolute/path/to/agent-tag.json).",
  ].join("\n");
}

async function fetchOk(
  dependencies: UpdateDependencies,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const response = await dependencies.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  return response;
}

export async function resolveLatestTag(dependencies: UpdateDependencies): Promise<string> {
  const url = `${dependencies.releaseBaseUrl}/latest`;
  const response = await dependencies.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) {
    throw new Error(`could not resolve the latest release from ${url} (HTTP ${response.status})`);
  }
  try {
    return tagFromLatestRedirect(new URL(location, url).pathname);
  } catch {
    throw new Error(noStableReleaseGuidance(dependencies.releaseBaseUrl));
  }
}

/**
 * GitHub's `releases/latest` skips prereleases and redirects to the release list when no
 * stable release exists, which is the normal state before GA.
 */
export function noStableReleaseGuidance(releaseBaseUrl: string): string {
  return [
    "no stable agent-tag release is published yet (the latest-release lookup skips prereleases).",
    `Pick a prerelease from ${releaseBaseUrl} and install it explicitly, for example: agent-tag update --version 0.1.0-rc.1`,
  ].join("\n");
}

async function smokeTest(path: string, expectedVersion: string): Promise<void> {
  const child = Bun.spawn([path, "version", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: SMOKE_TEST_TIMEOUT_MS,
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error(`downloaded binary failed its smoke test (exit ${exitCode})`);
  let reported: unknown;
  try {
    reported = (JSON.parse(stdout) as { version?: unknown }).version;
  } catch {
    throw new Error("downloaded binary printed invalid version JSON");
  }
  if (reported !== expectedVersion) {
    throw new Error(`downloaded binary reports version ${String(reported)}, expected ${expectedVersion}`);
  }
}

async function writeExecutable(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o700);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o755);
}

/** Reports whether a process with this pid exists (EPERM means it exists under another user). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Builds the staging filename beside the binary; it embeds the owner pid for stale detection. */
export function temporaryUpdateName(pid: number, nonce: string): string {
  return `${TEMPORARY_PREFIX}${pid}-${nonce}`;
}

/**
 * Removes temporary files that a crashed update left beside the binary. Each staging file
 * names its owner pid, so a file whose owner is still running belongs to a concurrent
 * update and is left alone; only files from dead (or unidentifiable) owners are removed.
 */
export async function removeStaleUpdateFiles(
  directory: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(TEMPORARY_PREFIX)) continue;
    const owner = /^(\d+)-/.exec(entry.slice(TEMPORARY_PREFIX.length))?.[1];
    const pid = owner === undefined ? Number.NaN : Number(owner);
    if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) continue;
    await rm(join(directory, entry), { force: true });
  }
}

export async function runUpdate(options: UpdateOptions, dependencies: UpdateDependencies): Promise<UpdateResult> {
  const { build } = dependencies;
  if (!options.check && build.installKind !== "binary") throw new Error(nonBinaryUpdateGuidance(build));

  const tag = options.version === undefined
    ? await resolveLatestTag(dependencies)
    : normalizeReleaseTag(options.version);
  const latest = versionFromTag(tag);
  const explicit = options.version !== undefined;
  const isNewer = compareVersions(latest, build.version) > 0;
  const isSame = compareVersions(latest, build.version) === 0;

  if (options.check) {
    return isNewer
      ? { status: "available", current: build.version, latest }
      : { status: "up-to-date", current: build.version, latest };
  }
  if (isSame || (!explicit && !isNewer)) return { status: "up-to-date", current: build.version, latest };
  if (build.target === undefined) throw new Error("no release binary exists for this platform");

  const executable = await realpath(dependencies.execPath);
  const directory = dirname(executable);
  const asset = releaseAssetName(build.target);
  dependencies.log(`downloading agent-tag ${latest} (${asset})`);

  const sumsResponse = await fetchOk(dependencies, releaseAssetUrl(dependencies.releaseBaseUrl, tag, SHA256SUMS_ASSET), METADATA_TIMEOUT_MS);
  const expected = parseSha256Sums(await sumsResponse.text()).get(asset);
  if (expected === undefined) throw new Error(`${SHA256SUMS_ASSET} for ${tag} has no entry for ${asset}`);

  const assetResponse = await fetchOk(dependencies, releaseAssetUrl(dependencies.releaseBaseUrl, tag, asset), ASSET_TIMEOUT_MS);
  const bytes = new Uint8Array(await assetResponse.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);

  await removeStaleUpdateFiles(directory);
  const temporary = join(directory, temporaryUpdateName(process.pid, randomBytes(6).toString("hex")));
  try {
    try {
      await writeExecutable(temporary, bytes);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
        throw new Error(`cannot write to ${directory}; re-run with permission to replace ${basename(executable)} or reinstall with install.sh`);
      }
      throw error;
    }
    await smokeTest(temporary, latest);
    // rename(2) within one directory is atomic: a running process keeps its open inode,
    // and new invocations see either the old or the new binary, never a partial file.
    await rename(temporary, executable);
  } finally {
    await rm(temporary, { force: true });
  }
  return { status: "updated", previous: build.version, current: latest, path: executable };
}

export function formatUpdateResult(result: UpdateResult): string {
  switch (result.status) {
    case "up-to-date":
      return `agent-tag ${result.current} is up to date (latest release: ${result.latest}).`;
    case "available":
      return `agent-tag ${result.latest} is available (installed: ${result.current}). Run \`agent-tag update\` to install it.`;
    case "updated":
      return `Updated agent-tag ${result.previous} -> ${result.current} at ${result.path}. Restart any running agent-tag service to use it.`;
  }
}
