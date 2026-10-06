import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SecretString } from "../src/security/secret-file.ts";
import { scanForSecrets } from "../src/security/secret-scan.ts";

test("secret scan reports exact and structured credentials without returning their values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-secret-scan-"));
  const scanRoot = join(directory, "tree");
  const secretDirectory = join(scanRoot, ".private");
  const canary = `fixture-${"c".repeat(80)}`;
  const slackToken = `xoxb-${"A".repeat(30)}`;
  try {
    await mkdir(scanRoot, { mode: 0o700 });
    await mkdir(secretDirectory, { mode: 0o700 });
    const secretPath = join(secretDirectory, "service-token");
    await writeFile(secretPath, `${canary}\n`, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    await writeFile(join(scanRoot, "clean.txt"), "ordinary release notes\n");
    await writeFile(join(scanRoot, "leak.bin"), Buffer.concat([
      Buffer.alloc(65_500, 0x2e),
      Buffer.from(`${canary}\n${slackToken}\n`, "utf8"),
    ]));
    const canonicalScanRoot = await realpath(scanRoot);

    const result = await scanForSecrets({
      roots: [scanRoot],
      canaries: [{ name: "fixture-service-token", secret: new SecretString(canary) }],
      excludedPaths: [secretPath],
    });

    expect(result.filesScanned).toBe(2);
    expect(result.symlinksSkipped).toBe(0);
    expect(result.findings).toEqual([
      {
        kind: "exact-secret",
        path: join(canonicalScanRoot, "leak.bin"),
        canaryName: "fixture-service-token",
      },
      { kind: "known-token-pattern", path: join(canonicalScanRoot, "leak.bin"), patternName: "slack-token" },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(slackToken);
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-secret-scan-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("secret scan reports skipped symbolic links as an incomplete scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-secret-symlink-"));
  try {
    const outside = join(directory, "outside.txt");
    const root = join(directory, "tree");
    await writeFile(outside, "outside\n");
    await mkdir(root);
    await symlink(outside, join(root, "linked-secret"));
    const result = await scanForSecrets({ roots: [root] });
    expect(result.filesScanned).toBe(0);
    expect(result.symlinksSkipped).toBe(1);
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-secret-symlink-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});

test("secret scan accepts a clean tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-secret-clean-"));
  try {
    await writeFile(join(directory, "README.md"), "No credentials here.\n");
    const result = await scanForSecrets({ roots: [directory] });
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-secret-clean-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});
