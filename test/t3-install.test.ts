import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  defaultT3RuntimeDir,
  inspectInstalledT3,
  installPinnedT3,
  parseT3DownloadBaseUrl,
  T3ArchiveRejectedError,
  T3ArtifactVerificationError,
  T3DowngradeError,
  T3UnsupportedPlatformError,
  type T3InstallEvent,
} from "../src/t3/install.ts";
import { defaultT3DownloadBaseUrl, PINNED_T3, t3ArtifactFor, t3ArtifactUrl } from "../src/t3/lock.ts";
import { parseT3Pin, type T3Pin } from "../src/t3/pin.ts";
import {
  buildFakeT3Tarball,
  CURRENT_TARGET,
  type FakeT3Mirror,
  type FakeTarball,
  fixturePin,
  rawTarGz,
  serveFakeT3Mirror,
  t3ArtifactName,
} from "./fixtures/fake-t3-tarball.ts";

const lockPath = resolve(import.meta.dir, "..", "t3.lock.json");
const mirrors: FakeT3Mirror[] = [];

afterEach(async () => {
  await Promise.all(mirrors.splice(0).map((mirror) => mirror.stop()));
});

async function runtimeDir(): Promise<string> {
  return defaultT3RuntimeDir(await mkdtemp(join(tmpdir(), "agent-tag-t3-install-")));
}

function mirrorFor(pin: T3Pin, tarball: FakeTarball): FakeT3Mirror {
  const mirror = serveFakeT3Mirror({ [`/${pin.tag}/${t3ArtifactName(pin.version)}`]: tarball.bytes });
  mirrors.push(mirror);
  return mirror;
}

async function listing(path: string): Promise<string[]> {
  return (await readdir(path).catch(() => [])).sort();
}

describe("embedded T3 lock", () => {
  test("PINNED_T3 equals t3.lock.json", async () => {
    expect(PINNED_T3).toEqual(parseT3Pin(await Bun.file(lockPath).json()));
  });

  test("rejects malformed lock entries", () => {
    const lock = structuredClone(PINNED_T3) as unknown as { artifacts: Record<string, { sha256: string }> };
    lock.artifacts["linux-x64"]!.sha256 = "not-a-sha";
    expect(() => parseT3Pin(lock)).toThrow();
    expect(() => parseT3Pin({ ...PINNED_T3, commit: "main" })).toThrow();
  });

  test("resolves pinned artifacts per platform and has none for darwin-x64 or win32", () => {
    expect(t3ArtifactFor(PINNED_T3, "darwin", "arm64")).toEqual({
      target: "darwin-arm64",
      name: "t3-0.0.45-darwin-arm64.tar.gz",
      sha256: "330a2431619b9b225a3d4f4e555bb165bbf83d57b72d6106e75cd2aabc70c8d6",
    });
    expect(t3ArtifactFor(PINNED_T3, "linux", "x64")?.name).toBe("t3-0.0.45-linux-x64.tar.gz");
    expect(t3ArtifactFor(PINNED_T3, "linux", "arm64")?.name).toBe("t3-0.0.45-linux-arm64.tar.gz");
    expect(t3ArtifactFor(PINNED_T3, "darwin", "x64")).toBeUndefined();
    expect(t3ArtifactFor(PINNED_T3, "win32", "x64")).toBeUndefined();
    expect(t3ArtifactFor(PINNED_T3, "constructor", "")).toBeUndefined();
  });

  test("builds GitHub release download URLs from the pinned source repository", () => {
    expect(defaultT3DownloadBaseUrl()).toBe("https://github.com/pingdotgg/t3code/releases/download");
    expect(t3ArtifactUrl(PINNED_T3, "t3-0.0.45-linux-x64.tar.gz")).toBe(
      "https://github.com/pingdotgg/t3code/releases/download/v0.0.45/t3-0.0.45-linux-x64.tar.gz",
    );
    expect(t3ArtifactUrl(PINNED_T3, "a.tar.gz", "https://mirror.example/t3/")).toBe("https://mirror.example/t3/v0.0.45/a.tar.gz");
    expect(() => t3ArtifactUrl(PINNED_T3, "../evil")).toThrow("invalid T3 artifact name");
  });

  test("download mirrors must be https unless they are loopback", () => {
    expect(parseT3DownloadBaseUrl("https://mirror.example/t3/")).toBe("https://mirror.example/t3");
    expect(parseT3DownloadBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => parseT3DownloadBaseUrl("http://mirror.example")).toThrow("must use https");
    expect(() => parseT3DownloadBaseUrl("not a url")).toThrow("invalid T3 download base URL");
  });
});

describe("installPinnedT3", () => {
  test("downloads, verifies, and atomically installs the pinned runtime", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const events: T3InstallEvent[] = [];

    const installed = await installPinnedT3({
      pin,
      runtimeDir: dir,
      downloadBaseUrl: mirror.baseUrl,
      log: (event) => events.push(event),
      now: () => new Date("2026-10-08T00:00:00.000Z"),
    });

    const root = join(dir, "versions", pin.version);
    expect(installed).toEqual({
      version: pin.version,
      target: CURRENT_TARGET,
      root,
      binary: join(root, "t3"),
      binarySha256: installed.binarySha256,
      archiveSha256: tarball.sha256,
      installedAt: "2026-10-08T00:00:00.000Z",
      downloaded: true,
    });
    expect(installed.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(join(root, "agent-tag-install.json")).json()).toEqual({
      version: pin.version,
      artifact: t3ArtifactName(pin.version),
      archiveSha256: tarball.sha256,
      binarySha256: installed.binarySha256,
      installedAt: "2026-10-08T00:00:00.000Z",
    });
    expect(await listing(root)).toEqual(["agent-tag-install.json", "client", "node_modules", "t3"]);
    expect((await stat(installed.binary)).mode & 0o777).toBe(0o755);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await listing(join(dir, "downloads"))).toEqual([]);
    expect(events).toEqual(["t3.install.downloading", "t3.install.installed"]);
    expect(mirror.requests).toEqual([`/${pin.tag}/${t3ArtifactName(pin.version)}`]);
  });

  test("re-running reuses a verified install without downloading", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const first = await installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    const second = await installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    expect(second).toEqual({ ...first, downloaded: false });
    expect(mirror.requests).toHaveLength(1);
  });

  test("concurrent installs converge on one verified version directory", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const results = await Promise.all([1, 2, 3].map(() => installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl })));
    expect(new Set(results.map((result) => result.binarySha256)).size).toBe(1);
    expect(await listing(join(dir, "versions"))).toEqual([pin.version]);
    expect(await listing(join(dir, "downloads"))).toEqual([]);
  });

  test("replaces a tampered binary and reports it in status first", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const first = await installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    await writeFile(first.binary, "#!/bin/sh\necho 't3 v0.0.45'\n# implant\n");

    const tamperedStatus = await inspectInstalledT3({ pin, runtimeDir: dir });
    expect(tamperedStatus).toMatchObject({ installed: true, binarySha256Verified: false });
    expect(tamperedStatus.problem).toContain("sha256 differs");

    const events: string[] = [];
    const second = await installPinnedT3({
      pin,
      runtimeDir: dir,
      downloadBaseUrl: mirror.baseUrl,
      log: (event, detail) => events.push(`${event} ${detail}`),
    });
    expect(second.downloaded).toBe(true);
    expect(second.binarySha256).toBe(first.binarySha256);
    expect(events[0]).toContain("t3.install.tampered");
    expect(mirror.requests).toHaveLength(2);
    expect((await inspectInstalledT3({ pin, runtimeDir: dir })).binarySha256Verified).toBe(true);
  });

  test("rejects an archive whose sha256 differs from the lock and leaves nothing behind", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: "0".repeat(64) });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const failure = installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    await expect(failure).rejects.toBeInstanceOf(T3ArtifactVerificationError);
    await expect(failure).rejects.toThrow(`expected ${"0".repeat(64)} from t3.lock.json, got ${tarball.sha256}`);
    expect(await listing(join(dir, "versions"))).toEqual([]);
    expect(await listing(join(dir, "downloads"))).toEqual([]);
  });

  test("reports HTTP failures with the URL", async () => {
    const pin = fixturePin({ sha256: "0".repeat(64) });
    const mirror = serveFakeT3Mirror({});
    mirrors.push(mirror);
    await expect(installPinnedT3({ pin, runtimeDir: await runtimeDir(), downloadBaseUrl: mirror.baseUrl })).rejects.toThrow(
      `downloading ${mirror.baseUrl}/${pin.tag}/${t3ArtifactName(pin.version)} failed: HTTP 404`,
    );
  });

  test("refuses archives that declare more than 256 MiB", async () => {
    const pin = fixturePin({ sha256: "0".repeat(64) });
    const dir = await runtimeDir();
    const fetch = async (): Promise<Response> =>
      new Response("tiny", { headers: { "content-length": String(300 * 1024 * 1024) } });
    await expect(installPinnedT3({ pin, runtimeDir: dir, fetch })).rejects.toThrow("over the 268435456-byte limit");
    expect(await listing(join(dir, "downloads"))).toEqual([]);
  });

  const top = `t3-${PINNED_T3.version}-${CURRENT_TARGET}`;
  const binary = { name: `${top}/t3`, type: "0", content: "#!/bin/sh\necho t3 v0.0.45\n", mode: 0o755 } as const;
  const hostile: ReadonlyArray<readonly [string, FakeTarball, string]> = [
    ["a symlink", rawTarGz([{ name: `${top}/`, type: "5" }, binary, { name: `${top}/link`, type: "2", linkname: "/etc/passwd" }]), "is a symbolic link"],
    ["a hard link", rawTarGz([{ name: `${top}/`, type: "5" }, binary, { name: `${top}/hard`, type: "1", linkname: `${top}/t3` }]), "is a hard link"],
    ["a ../ path", rawTarGz([binary, { name: `${top}/../evil`, type: "0", content: "x" }]), "unsafe path segment"],
    ["an absolute path", rawTarGz([binary, { name: "/tmp/evil", type: "0", content: "x" }]), "absolute path"],
    ["a wrong top directory", rawTarGz([{ name: "t3-0.0.44-other/t3", type: "0", content: "x" }]), "is outside"],
    ["an entry over 256 MiB", rawTarGz([{ name: `${top}/t3`, type: "0", declaredSize: 300 * 1024 * 1024 }]), "larger than"],
    ["no t3 binary", rawTarGz([{ name: `${top}/`, type: "5" }, { name: `${top}/README`, type: "0", content: "x" }]), "has no"],
    ["a device node", rawTarGz([binary, { name: `${top}/dev`, type: "3" }]), "character device"],
  ];
  for (const [label, tarball, message] of hostile) {
    test(`rejects ${label} before extracting`, async () => {
      const pin = fixturePin({ sha256: tarball.sha256 });
      const mirror = mirrorFor(pin, tarball);
      const dir = await runtimeDir();
      const failure = installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
      await expect(failure).rejects.toBeInstanceOf(T3ArchiveRejectedError);
      await expect(failure).rejects.toThrow(message);
      expect(await listing(join(dir, "versions"))).toEqual([]);
      expect(await listing(join(dir, "downloads"))).toEqual([]);
    });
  }

  test("rejects a binary whose --version does not match the pin", async () => {
    const tarball = await buildFakeT3Tarball({ reportedVersion: "0.0.44" });
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    await expect(installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl })).rejects.toThrow(
      'T3 binary reported "t3 v0.0.44"',
    );
    expect(await listing(join(dir, "versions"))).toEqual([]);
  });

  test("explains that darwin-x64 has no pinned artifact", async () => {
    const failure = installPinnedT3({ pin: PINNED_T3, runtimeDir: await runtimeDir(), platform: "darwin", arch: "x64" });
    await expect(failure).rejects.toBeInstanceOf(T3UnsupportedPlatformError);
    await expect(failure).rejects.toThrow("managed T3 is unavailable on darwin-x64");
  });

  test("keeps the pinned version plus the newest other version", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const old of ["0.0.40", "0.0.43", "0.0.9"]) await mkdir(join(dir, "versions", old), { recursive: true });
    await installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    expect(await listing(join(dir, "versions"))).toEqual(["0.0.43", pin.version]);
  });

  test("refuses to install a version older than one that already ran", async () => {
    const pin = fixturePin({ sha256: "0".repeat(64) });
    const mirror = serveFakeT3Mirror({});
    mirrors.push(mirror);
    const dir = await runtimeDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "state.json"), JSON.stringify({ highestVersionStarted: "0.0.46" }));
    const failure = installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    await expect(failure).rejects.toBeInstanceOf(T3DowngradeError);
    await expect(failure).rejects.toThrow("T3 0.0.46 already ran");
    expect(mirror.requests).toEqual([]);
  });

  test("refuses a runtime directory other users can read", async () => {
    const dir = await runtimeDir();
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await expect(
      installPinnedT3({ pin: fixturePin({ sha256: "0".repeat(64) }), runtimeDir: dir }),
    ).rejects.toThrow("must not grant group or world access");
  });
});

describe("inspectInstalledT3", () => {
  test("reports a missing install without creating anything", async () => {
    const dir = await runtimeDir();
    expect(await inspectInstalledT3({ pin: PINNED_T3, runtimeDir: dir, platform: "linux", arch: "x64" })).toEqual({
      pinnedVersion: "0.0.45",
      target: "linux-x64",
      supported: true,
      runtimeDir: dir,
      installed: false,
      version: null,
      binary: null,
      binarySha256: null,
      binarySha256Verified: false,
      installedAt: null,
      problem: null,
    });
    expect(await stat(dir).catch(() => undefined)).toBeUndefined();
    expect(
      (await inspectInstalledT3({ pin: PINNED_T3, runtimeDir: dir, platform: "darwin", arch: "x64" })).problem,
    ).toBe("t3.lock.json pins no artifact for darwin-x64");
  });

  test("reports a verified install", async () => {
    const tarball = await buildFakeT3Tarball();
    const pin = fixturePin({ sha256: tarball.sha256 });
    const mirror = mirrorFor(pin, tarball);
    const dir = await runtimeDir();
    const installed = await installPinnedT3({ pin, runtimeDir: dir, downloadBaseUrl: mirror.baseUrl });
    expect(await inspectInstalledT3({ pin, runtimeDir: dir })).toEqual({
      pinnedVersion: pin.version,
      target: CURRENT_TARGET,
      supported: true,
      runtimeDir: dir,
      installed: true,
      version: pin.version,
      binary: installed.binary,
      binarySha256: installed.binarySha256,
      binarySha256Verified: true,
      installedAt: installed.installedAt,
      problem: null,
    });
  });
});
