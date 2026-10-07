import packageJson from "../package.json" with { type: "json" };

import { detectReleaseTarget, isReleaseTarget, type ReleaseTarget } from "./release.ts";

// Replaced by `bun build --define` in scripts/build-release.ts. Source runs leave them undefined.
declare const AGENT_TAG_BUILD_VERSION: string | undefined;
declare const AGENT_TAG_BUILD_TARGET: string | undefined;
declare const AGENT_TAG_BUILD_COMMIT: string | undefined;

export type InstallKind = "binary" | "source" | "container";

export interface BuildInfo {
  readonly version: string;
  readonly target: ReleaseTarget | undefined;
  readonly commit: string | undefined;
  readonly installKind: InstallKind;
}

export interface InstallKindInput {
  readonly buildTarget: string | undefined;
  readonly mainPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** True when the entrypoint runs from Bun's embedded filesystem, i.e. inside a `bun build --compile` binary. */
export function isCompiledEntrypoint(mainPath: string): boolean {
  return mainPath.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/.test(mainPath);
}

/**
 * A release binary carries an embedded target and runs its entrypoint from Bun's
 * virtual filesystem. Everything else is a source checkout or a container image.
 */
export function detectInstallKind(input: InstallKindInput): InstallKind {
  if (input.env.AGENT_TAG_INSTALL_KIND === "container") return "container";
  const embedded = isCompiledEntrypoint(input.mainPath);
  if (input.buildTarget !== undefined && isReleaseTarget(input.buildTarget) && embedded) return "binary";
  return "source";
}

function defined(value: () => string | undefined): string | undefined {
  try {
    const result = value();
    return typeof result === "string" && result !== "" ? result : undefined;
  } catch {
    return undefined;
  }
}

export function currentBuildInfo(): BuildInfo {
  const buildVersion = defined(() => AGENT_TAG_BUILD_VERSION);
  const buildTarget = defined(() => AGENT_TAG_BUILD_TARGET);
  const installKind = detectInstallKind({ buildTarget, mainPath: Bun.main, env: process.env });
  const target = buildTarget !== undefined && isReleaseTarget(buildTarget)
    ? buildTarget
    : detectReleaseTarget(process.platform, process.arch);
  return {
    version: buildVersion ?? packageJson.version,
    target,
    commit: defined(() => AGENT_TAG_BUILD_COMMIT),
    installKind,
  };
}

export function formatBuildInfo(info: BuildInfo): string {
  const details: string[] = [info.target ?? `${process.platform}-${process.arch}`, info.installKind];
  if (info.commit !== undefined) details.push(info.commit.slice(0, 12));
  return `agent-tag ${info.version} (${details.join(", ")})`;
}
