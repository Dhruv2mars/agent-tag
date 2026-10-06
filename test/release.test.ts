import { expect, test } from "bun:test";

import { compileCommand, parseBuildReleaseArguments } from "../scripts/build-release.ts";
import {
  compareVersions,
  detectReleaseTarget,
  normalizeReleaseTag,
  parseSha256Sums,
  RELEASE_TARGETS,
  releaseAssetName,
  releaseAssetUrl,
  renderSha256Sums,
  sha256Hex,
  tagFromLatestRedirect,
} from "../src/release.ts";
import { detectInstallKind, formatBuildInfo } from "../src/version.ts";

test("maps Node platform and arch to the four release targets", () => {
  expect(detectReleaseTarget("darwin", "arm64")).toBe("darwin-arm64");
  expect(detectReleaseTarget("darwin", "x64")).toBe("darwin-x64");
  expect(detectReleaseTarget("linux", "x64")).toBe("linux-x64");
  expect(detectReleaseTarget("linux", "arm64")).toBe("linux-arm64");
  expect(detectReleaseTarget("win32", "x64")).toBeUndefined();
  expect(detectReleaseTarget("linux", "ia32")).toBeUndefined();
  expect(RELEASE_TARGETS.map(releaseAssetName)).toEqual([
    "agent-tag-darwin-arm64",
    "agent-tag-darwin-x64",
    "agent-tag-linux-x64",
    "agent-tag-linux-arm64",
  ]);
});

test("normalizes release versions and rejects anything that is not semver", () => {
  expect(normalizeReleaseTag("1.2.3")).toBe("v1.2.3");
  expect(normalizeReleaseTag("v1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  for (const bad of ["latest", "1.2", "v01.2.3", "1.2.3/../x", "1.2.3 ", "vv1.2.3", ""]) {
    expect(() => normalizeReleaseTag(bad)).toThrow("invalid release version");
  }
});

test("orders versions by semver precedence", () => {
  const ordered = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0"];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as string;
    const current = ordered[index] as string;
    expect(compareVersions(previous, current)).toBe(-1);
    expect(compareVersions(current, previous)).toBe(1);
  }
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
});

test("round-trips sha256sum-compatible checksum files", () => {
  const a = sha256Hex(new TextEncoder().encode("a"));
  const b = sha256Hex(new TextEncoder().encode("b"));
  const text = renderSha256Sums([
    { name: "agent-tag-linux-x64", sha256: b },
    { name: "agent-tag-darwin-arm64", sha256: a },
  ]);
  expect(text).toBe(`${a}  agent-tag-darwin-arm64\n${b}  agent-tag-linux-x64\n`);
  expect(parseSha256Sums(text).get("agent-tag-linux-x64")).toBe(b);
  expect(parseSha256Sums(`${a.toUpperCase()} *agent-tag-linux-x64\n`).get("agent-tag-linux-x64")).toBe(a);
  expect(() => parseSha256Sums("nonsense\n")).toThrow("malformed");
  expect(() => parseSha256Sums(`${a}  x\n${b}  x\n`)).toThrow("duplicate");
  expect(() => renderSha256Sums([{ name: "../x", sha256: a }])).toThrow("invalid asset name");
});

test("builds GitHub Releases URLs and resolves the latest redirect", () => {
  expect(releaseAssetUrl("https://github.com/o/r/releases/", "0.1.0", "SHA256SUMS")).toBe(
    "https://github.com/o/r/releases/download/v0.1.0/SHA256SUMS",
  );
  expect(tagFromLatestRedirect("https://github.com/o/r/releases/tag/v0.4.1")).toBe("v0.4.1");
  expect(tagFromLatestRedirect("/o/r/releases/tag/v1.0.0-rc.2")).toBe("v1.0.0-rc.2");
  expect(() => tagFromLatestRedirect("https://github.com/o/r/releases")).toThrow("no published");
  expect(() => tagFromLatestRedirect("/o/r/releases/tag/nightly")).toThrow("invalid release version");
});

test("treats only an embedded release build as a self-updatable binary", () => {
  expect(detectInstallKind({ buildTarget: "darwin-arm64", mainPath: "/$bunfs/root/agent-tag", env: {} })).toBe("binary");
  expect(detectInstallKind({ buildTarget: undefined, mainPath: "/$bunfs/root/agent-tag", env: {} })).toBe("source");
  expect(detectInstallKind({ buildTarget: "darwin-arm64", mainPath: "/srv/agent-tag/src/cli.ts", env: {} })).toBe("source");
  expect(detectInstallKind({ buildTarget: undefined, mainPath: "/app/src/cli.ts", env: { AGENT_TAG_INSTALL_KIND: "container" } })).toBe("container");
  expect(formatBuildInfo({ version: "0.1.0", target: "linux-x64", commit: "0123456789abcdef", installKind: "binary" })).toBe(
    "agent-tag 0.1.0 (linux-x64, binary, 0123456789ab)",
  );
});

test("parses build-release arguments and embeds build metadata with --define", () => {
  const defaults = parseBuildReleaseArguments([]);
  expect(defaults.targets).toEqual([...RELEASE_TARGETS]);
  expect(defaults.sumsOnly).toBe(false);
  const options = parseBuildReleaseArguments(["--target", "linux-x64", "--target", "linux-x64", "--version", "v0.2.0", "--outdir", "/tmp/out", "--no-smoke"]);
  expect(options).toEqual({ targets: ["linux-x64"], version: "0.2.0", outdir: "/tmp/out", sumsOnly: false, smoke: false });
  expect(() => parseBuildReleaseArguments(["--target", "windows-x64"])).toThrow("--target must be one of");
  expect(() => parseBuildReleaseArguments(["--version", "next"])).toThrow("invalid release version");

  const command = compileCommand({ bunPath: "/bin/bun", target: "linux-arm64", version: "0.2.0", commit: "abc", outfile: "/tmp/out/agent-tag-linux-arm64" });
  expect(command).toContain("--compile");
  expect(command).toContain("--target=bun-linux-arm64");
  expect(command).toContain('--define=AGENT_TAG_BUILD_VERSION="0.2.0"');
  expect(command).toContain('--define=AGENT_TAG_BUILD_TARGET="linux-arm64"');
  expect(command.at(-1)).toBe("/tmp/out/agent-tag-linux-arm64");
  expect(compileCommand({ bunPath: "/bin/bun", target: "linux-x64", version: "0.2.0", commit: "", outfile: "/o" })).toContain(
    "--target=bun-linux-x64-baseline",
  );
});
