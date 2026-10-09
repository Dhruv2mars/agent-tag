import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSecretFile, replaceSecretFile, SecretString } from "../src/security/secret-file.ts";

const directories: string[] = [];

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-secret-file-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function permissionBits(metadata: { readonly mode: number }): number {
  return metadata.mode & 0o777;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("replaceSecretFile", () => {
  test("writes a 0600 file into a 0700 directory that readSecretFile reads back", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "t3-token");
    await replaceSecretFile({ path, secret: new SecretString("first-token") });
    expect(permissionBits(await stat(path))).toBe(0o600);
    expect((await readSecretFile(path)).exposeToBoundary()).toBe("first-token");
    expect(await readdir(directory)).toEqual(["t3-token"]);
  });

  test("replacing an existing file keeps 0600 and leaves no .tmp files behind", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "t3-token");
    await replaceSecretFile({ path, secret: new SecretString("old-token") });
    await replaceSecretFile({ path, secret: new SecretString("new-token") });
    expect(await readFile(path, "utf8")).toBe("new-token\n");
    expect(permissionBits(await stat(path))).toBe(0o600);
    // Only the target remains: no `.t3-token.<hex>.tmp` left by either replace.
    expect(await readdir(directory)).toEqual(["t3-token"]);
  });

  test("concurrent readers see the old or the new full secret, never a partial or missing one", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "t3-token");
    const values = ["A".repeat(4096), "B".repeat(4096)];
    await replaceSecretFile({ path, secret: new SecretString(values[0]!) });
    const reads: Promise<string>[] = [];
    for (let round = 0; round < 50; round += 1) {
      const replacing = replaceSecretFile({ path, secret: new SecretString(values[round % 2]!) });
      for (let read = 0; read < 4; read += 1) reads.push(readFile(path, "utf8"));
      await replacing;
    }
    const contents = await Promise.all(reads);
    expect(contents).toHaveLength(200);
    // Each stored secret is written with a trailing newline.
    const allowed = new Set(values.map((value) => `${value}\n`));
    expect(contents.filter((content) => !allowed.has(content)).length).toBe(0);
  });

  test("refuses to write into a directory that group or world can access", async () => {
    const directory = await privateDirectory();
    await chmod(directory, 0o755);
    const path = join(directory, "t3-token");
    await expect(replaceSecretFile({ path, secret: new SecretString("token") })).rejects.toThrow(
      `secret parent must not grant group or world access: ${directory}`,
    );
    await expect(readSecretFile(path)).rejects.toThrow("secret parent must not grant group or world access");
    // The check runs before any temp file is created.
    expect(await readdir(directory)).toEqual([]);
  });
});
