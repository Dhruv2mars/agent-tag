import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../src/release.ts";
import { PINNED_T3 } from "../../src/t3/lock.ts";
import type { T3Pin } from "../../src/t3/pin.ts";

export const CURRENT_TARGET = `${process.platform}-${process.arch}`;

/**
 * A POSIX shell stand-in for the T3 CLI that answers `--version`. Like the real Node-based CLI it
 * fails with MODULE_NOT_FOUND when its bundled dependencies are gone. It also fails when a
 * `<its directory>.broken` sibling exists, so tests can break one runtime without touching its files.
 */
export function fakeT3Script(reportedVersion: string): string {
  return `#!/bin/sh
root=$(dirname "$0")
if [ ! -f "$root/node_modules/example/index.js" ] || [ -e "$root.broken" ]; then
  echo "Error: Cannot find module 'example' (MODULE_NOT_FOUND)" >&2
  exit 1
fi
if [ "$1" = "--version" ]; then echo "t3 v${reportedVersion}"; exit 0; fi
echo "fake t3" >&2
exit 2
`;
}

export function t3ArtifactName(version: string, target: string = CURRENT_TARGET): string {
  return `t3-${version}-${target}.tar.gz`;
}

/** The embedded pin with the version and one artifact replaced by a fixture's. */
export function fixturePin(input: { readonly version?: string; readonly sha256: string; readonly target?: string }): T3Pin {
  const version = input.version ?? PINNED_T3.version;
  const target = input.target ?? CURRENT_TARGET;
  return {
    ...PINNED_T3,
    version,
    tag: `v${version}`,
    artifacts: { [target]: { name: t3ArtifactName(version, target), sha256: input.sha256 } },
  };
}

export interface FakeTarball {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
}

/** Builds a realistic tarball with the system `tar -czf`, laid out like the real T3 release. */
export async function buildFakeT3Tarball(input: {
  readonly version?: string;
  readonly reportedVersion?: string;
  readonly target?: string;
} = {}): Promise<FakeTarball> {
  const version = input.version ?? PINNED_T3.version;
  const topDir = `t3-${version}-${input.target ?? CURRENT_TARGET}`;
  const work = await mkdtemp(join(tmpdir(), "agent-tag-fake-t3-"));
  const root = join(work, topDir);
  await mkdir(join(root, "node_modules", "example"), { recursive: true });
  await mkdir(join(root, "client"), { recursive: true });
  await writeFile(join(root, "t3"), fakeT3Script(input.reportedVersion ?? version));
  await chmod(join(root, "t3"), 0o755);
  await writeFile(join(root, "node_modules", "example", "index.js"), "module.exports = 1;\n");
  await writeFile(join(root, "client", "index.html"), "<!doctype html>\n");
  const archive = join(work, "archive.tar.gz");
  const child = Bun.spawn(["tar", "-czf", archive, "-C", work, topDir], {
    // Keeps macOS bsdtar from adding AppleDouble `._*` entries.
    env: { ...Bun.env, COPYFILE_DISABLE: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  return { bytes, sha256: sha256Hex(bytes) };
}

export interface RawTarEntry {
  readonly name: string;
  /** Tar typeflag: "0" file, "5" directory, "1" hard link, "2" symlink. */
  readonly type: string;
  readonly content?: string;
  readonly linkname?: string;
  /** Overrides the header size field without writing that much data. */
  readonly declaredSize?: number;
  readonly mode?: number;
}

/** Hand-writes a ustar .tar.gz so tests can produce entries `tar -czf` refuses to create. */
export function rawTarGz(entries: readonly RawTarEntry[]): FakeTarball {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const data = encoder.encode(entry.content ?? "");
    const header = new Uint8Array(512);
    const put = (offset: number, text: string): void => header.set(encoder.encode(text), offset);
    const octalField = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;
    put(0, entry.name);
    put(100, octalField(entry.mode ?? (entry.type === "5" ? 0o755 : 0o644), 8));
    put(108, octalField(0, 8));
    put(116, octalField(0, 8));
    put(124, octalField(entry.declaredSize ?? data.length, 12));
    put(136, octalField(0, 12));
    put(148, "        ");
    put(156, entry.type);
    put(157, entry.linkname ?? "");
    put(257, "ustar\u000000");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (entry.declaredSize === undefined && data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.length;
  }
  const bytes = Bun.gzipSync(tar);
  return { bytes, sha256: sha256Hex(bytes) };
}

export interface FakeT3Mirror {
  readonly baseUrl: string;
  readonly requests: string[];
  stop(): Promise<void>;
}

/** Serves `/<path>` → bytes on loopback, like GitHub's `releases/download/<tag>/<asset>`. */
export function serveFakeT3Mirror(files: Readonly<Record<string, Uint8Array<ArrayBuffer>>>): FakeT3Mirror {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const body = files[path];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
