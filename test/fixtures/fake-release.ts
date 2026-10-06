import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderSha256Sums, SHA256SUMS_ASSET, sha256Hex } from "../../src/release.ts";

/** A POSIX shell stand-in for a release binary that answers `version` like the real CLI. */
export function fakeBinaryScript(version: string, target: string): string {
  return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then
  printf '{"version":"%s","target":"%s","commit":null,"installKind":"binary"}\\n' "${version}" "${target}"
elif [ "$1" = "version" ]; then
  printf 'agent-tag %s (%s, binary)\\n' "${version}" "${target}"
else
  echo "fake agent-tag ${version}"
fi
`;
}

export interface FakeReleaseInput {
  readonly root: string;
  readonly tag: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly latest?: boolean;
  /** Overrides the published checksum for an asset to simulate tampering. */
  readonly corruptChecksums?: readonly string[];
}

/** Lays out `<root>/download/<tag>/...` (and `latest/download/...`) like GitHub Releases. */
export async function writeFakeRelease(input: FakeReleaseInput): Promise<void> {
  const sums = renderSha256Sums(
    Object.entries(input.assets).map(([name, content]) => ({
      name,
      sha256: input.corruptChecksums?.includes(name)
        ? sha256Hex(new TextEncoder().encode(`tampered ${content}`))
        : sha256Hex(new TextEncoder().encode(content)),
    })),
  );
  const directories = [join(input.root, "download", input.tag)];
  if (input.latest === true) directories.push(join(input.root, "latest", "download"));
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(input.assets)) {
      await writeFile(join(directory, name), content);
      await chmod(join(directory, name), 0o755);
    }
    await writeFile(join(directory, SHA256SUMS_ASSET), sums);
  }
}
