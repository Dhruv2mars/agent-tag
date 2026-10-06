import { createHash } from "node:crypto";

export const AGENT_TAG_REPOSITORY = "Dhruv2mars/agent-tag";
export const DEFAULT_RELEASE_BASE_URL = `https://github.com/${AGENT_TAG_REPOSITORY}/releases`;
export const SHA256SUMS_ASSET = "SHA256SUMS";

export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value);
}

export function detectReleaseTarget(platform: string, arch: string): ReleaseTarget | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  const target = `${os}-${cpu}`;
  return isReleaseTarget(target) ? target : undefined;
}

export function releaseAssetName(target: ReleaseTarget): string {
  return `agent-tag-${target}`;
}

/**
 * x64 builds use Bun's baseline runtime so they also start on CPUs (and virtualized
 * hosts) without AVX2; the I/O-bound service gains nothing from the AVX2 build.
 */
export function bunCompileTarget(target: ReleaseTarget): string {
  return target.endsWith("-x64") ? `bun-${target}-baseline` : `bun-${target}`;
}

/** Accepts `1.2.3` or `v1.2.3` (with optional prerelease) and returns the `v`-prefixed tag. */
export function normalizeReleaseTag(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  if (!TAG_PATTERN.test(tag)) throw new Error(`invalid release version: ${version}`);
  return tag;
}

export function versionFromTag(tag: string): string {
  return normalizeReleaseTag(tag).slice(1);
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic-version ordering: negative when `left` is older than `right`. */
export function compareVersions(left: string, right: string): number {
  const a = TAG_PATTERN.exec(normalizeReleaseTag(left));
  const b = TAG_PATTERN.exec(normalizeReleaseTag(right));
  if (a === null || b === null) throw new Error("invalid release version");
  for (const index of [1, 2, 3]) {
    const difference = Math.sign(Number(a[index]) - Number(b[index]));
    if (difference !== 0) return difference;
  }
  const leftPre = a[4];
  const rightPre = b[4];
  if (leftPre === undefined || rightPre === undefined) {
    return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  }
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const difference = compareIdentifiers(leftPart, rightPart);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ChecksumEntry {
  readonly name: string;
  readonly sha256: string;
}

/** Renders `sha256sum`-compatible lines, sorted by file name for reproducible output. */
export function renderSha256Sums(entries: readonly ChecksumEntry[]): string {
  return [...entries]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`invalid sha256 for ${entry.name}`);
      if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) throw new Error(`invalid asset name: ${entry.name}`);
      return `${entry.sha256}  ${entry.name}\n`;
    })
    .join("");
}

export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(trimmed);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error("malformed SHA256SUMS line");
    }
    if (sums.has(match[2])) throw new Error(`duplicate SHA256SUMS entry: ${match[2]}`);
    sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function releaseAssetUrl(baseUrl: string, tag: string, asset: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/download/${normalizeReleaseTag(tag)}/${asset}`;
}

/** Extracts the tag from the `releases/latest` redirect target (`.../releases/tag/v1.2.3`). */
export function tagFromLatestRedirect(location: string): string {
  const match = /\/releases\/tag\/([^/?#]+)\/?(?:[?#].*)?$/.exec(location);
  if (match === null || match[1] === undefined) throw new Error("no published agent-tag release found");
  return normalizeReleaseTag(decodeURIComponent(match[1]));
}
