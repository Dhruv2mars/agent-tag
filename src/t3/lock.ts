// Imported, not read from disk, so compiled release binaries embed the pin (same as src/doctor.ts).
import t3Lock from "../../t3.lock.json" with { type: "json" };

import { parseT3Pin, type T3Pin } from "./pin.ts";

/** The T3 release this build of Agent Tag is pinned to (`t3.lock.json`). */
export const PINNED_T3: T3Pin = parseT3Pin(t3Lock);

/**
 * GitHub's release download root for the pinned source repository, e.g.
 * `https://github.com/pingdotgg/t3code/releases/download`. Asset URLs are `<root>/<tag>/<name>`;
 * checked on 2026-10-08 for v0.0.45 (darwin-arm64, linux-arm64, linux-x64 redirect to the asset
 * store; darwin-x64 is 404). The archive sha256 from the lock is authoritative, not the host.
 */
export function defaultT3DownloadBaseUrl(pin: T3Pin = PINNED_T3): string {
  return `${pin.sourceUrl.replace(/\/+$/, "")}/releases/download`;
}

export interface T3Artifact {
  readonly target: string;
  readonly name: string;
  readonly sha256: string;
}

/** The pinned artifact for a platform, or undefined when the release ships none (darwin-x64, win32). */
export function t3ArtifactFor(
  pin: T3Pin,
  platform: string = process.platform,
  arch: string = process.arch,
): T3Artifact | undefined {
  const target = `${platform}-${arch}`;
  const artifact = Object.hasOwn(pin.artifacts, target) ? pin.artifacts[target] : undefined;
  return artifact === undefined ? undefined : { target, name: artifact.name, sha256: artifact.sha256 };
}

export function t3ArtifactUrl(pin: T3Pin, name: string, base: string = defaultT3DownloadBaseUrl(pin)): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid T3 artifact name: ${name}`);
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(pin.tag)}/${name}`;
}
