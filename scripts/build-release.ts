import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import {
  bunCompileTarget,
  detectReleaseTarget,
  isReleaseTarget,
  normalizeReleaseTag,
  RELEASE_TARGETS,
  releaseAssetName,
  renderSha256Sums,
  SHA256SUMS_ASSET,
  sha256Hex,
  versionFromTag,
  type ReleaseTarget,
} from "../src/release.ts";

export interface BuildReleaseOptions {
  readonly targets: readonly ReleaseTarget[];
  readonly version: string;
  readonly outdir: string;
  readonly sumsOnly: boolean;
  readonly smoke: boolean;
}

const repository = resolve(import.meta.dir, "..");

const USAGE =
  "usage: bun run scripts/build-release.ts [--target TARGET]... [--version X.Y.Z] [--outdir DIR] [--sums-only] [--no-smoke]";

export function parseBuildReleaseArguments(argv: readonly string[]): BuildReleaseOptions {
  const targets: ReleaseTarget[] = [];
  let version = packageJson.version;
  let outdir = join(repository, "dist");
  let sumsOnly = false;
  let smoke = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--target") {
      if (value === undefined || !isReleaseTarget(value)) {
        throw new Error(`--target must be one of ${RELEASE_TARGETS.join(", ")}`);
      }
      if (!targets.includes(value)) targets.push(value);
      index += 1;
    } else if (argument === "--version") {
      if (value === undefined) throw new Error(USAGE);
      version = versionFromTag(normalizeReleaseTag(value));
      index += 1;
    } else if (argument === "--outdir") {
      if (value === undefined) throw new Error(USAGE);
      outdir = resolve(value);
      index += 1;
    } else if (argument === "--sums-only") {
      sumsOnly = true;
    } else if (argument === "--no-smoke") {
      smoke = false;
    } else {
      throw new Error(USAGE);
    }
  }
  return { targets: targets.length === 0 ? [...RELEASE_TARGETS] : targets, version, outdir, sumsOnly, smoke };
}

async function run(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`command failed with exit code ${exitCode}: ${command.join(" ")}\n${stdout.trim()}\n${stderr.trim()}`);
  }
  return stdout.trim();
}

async function gitCommit(): Promise<string> {
  try {
    return await run(["git", "rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

export function compileCommand(input: {
  readonly bunPath: string;
  readonly target: ReleaseTarget;
  readonly version: string;
  readonly commit: string;
  readonly outfile: string;
}): readonly string[] {
  return [
    input.bunPath,
    "build",
    "--compile",
    "--sourcemap",
    `--target=${bunCompileTarget(input.target)}`,
    `--define=AGENT_TAG_BUILD_VERSION=${JSON.stringify(input.version)}`,
    `--define=AGENT_TAG_BUILD_TARGET=${JSON.stringify(input.target)}`,
    `--define=AGENT_TAG_BUILD_COMMIT=${JSON.stringify(input.commit)}`,
    "src/cli.ts",
    "--outfile",
    input.outfile,
  ];
}

async function smokeTest(path: string, version: string, target: ReleaseTarget): Promise<void> {
  const help = await run([path, "--help"]);
  if (!help.includes("agent-tag version")) throw new Error(`${path} --help did not print usage`);
  const reported: unknown = JSON.parse(await run([path, "version", "--json"]));
  const expected = { version, target, installKind: "binary" };
  for (const [key, value] of Object.entries(expected)) {
    if ((reported as Record<string, unknown>)[key] !== value) {
      throw new Error(`${path} version reported ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`);
    }
  }
}

/** Writes SHA256SUMS over every release binary already present in `outdir`. */
export async function writeSha256Sums(outdir: string): Promise<string> {
  const names = (await readdir(outdir)).filter((name) => name.startsWith("agent-tag-")).sort();
  if (names.length === 0) throw new Error(`no agent-tag-* binaries in ${outdir}`);
  const entries = await Promise.all(
    names.map(async (name) => ({ name, sha256: sha256Hex(await Bun.file(join(outdir, name)).bytes()) })),
  );
  const sums = renderSha256Sums(entries);
  await Bun.write(join(outdir, SHA256SUMS_ASSET), sums);
  return sums;
}

export async function buildRelease(options: BuildReleaseOptions): Promise<string> {
  await mkdir(options.outdir, { recursive: true });
  if (!options.sumsOnly) {
    const commit = await gitCommit();
    const host = detectReleaseTarget(process.platform, process.arch);
    for (const target of options.targets) {
      const outfile = join(options.outdir, releaseAssetName(target));
      await rm(outfile, { force: true });
      await run(compileCommand({ bunPath: process.execPath, target, version: options.version, commit, outfile }));
      // The sourcemap is embedded in the executable; drop the side file so it is never published.
      await rm(join(options.outdir, "cli.js.map"), { force: true });
      if (options.smoke && target === host) await smokeTest(outfile, options.version, target);
      console.error(`built ${outfile}${target === host && options.smoke ? " (smoke-tested)" : ""}`);
    }
  }
  return writeSha256Sums(options.outdir);
}

if (import.meta.main) {
  const options = parseBuildReleaseArguments(process.argv.slice(2));
  process.stdout.write(await buildRelease(options));
}
