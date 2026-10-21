import { expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SecretString } from "../src/security/secret-file.ts";
import { CHANGED_DURING_SCAN, scanForSecrets, scanTextForSecrets } from "../src/security/secret-scan.ts";

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

async function withFixture(prefix: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(await realpath(directory));
  } finally {
    if (!directory.startsWith(`${tmpdir()}/${prefix}`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

test("secret scan keeps findings and lists unreadable files and directories instead of failing", async () => {
  if (process.getuid?.() === 0) return; // root bypasses file permissions
  await withFixture("agent-tag-secret-unreadable-", async (directory) => {
    const slackToken = `xoxb-${"D4".repeat(15)}`;
    const lockedFile = join(directory, "a-locked.log");
    const lockedDirectory = join(directory, "b-locked-dir");
    await writeFile(lockedFile, "unreadable\n");
    await mkdir(lockedDirectory);
    await writeFile(join(lockedDirectory, "inner.log"), "hidden\n");
    await writeFile(join(directory, "c-leak.sqlite"), `x ${slackToken} x`);
    await chmod(lockedFile, 0o000);
    await chmod(lockedDirectory, 0o000);
    try {
      const result = await scanForSecrets({ roots: [directory] });
      expect(result.findings).toEqual([
        { kind: "known-token-pattern", path: join(directory, "c-leak.sqlite"), patternName: "slack-token" },
      ]);
      expect(result.skippedEntries).toEqual([
        { path: lockedFile, reason: "EACCES" },
        { path: lockedDirectory, reason: "EACCES" },
      ]);
      expect(result.filesScanned).toBe(1);
      expect(JSON.stringify(result)).not.toContain(slackToken);
    } finally {
      await chmod(lockedDirectory, 0o700);
      await chmod(lockedFile, 0o600);
    }
  });
});

test("secret scan follows content that log rotation renames mid-scan", async () => {
  await withFixture("agent-tag-secret-rotate-", async (directory) => {
    const leak = `xoxb-${"E5".repeat(15)}`;
    const log = join(directory, "service.log");
    await writeFile(join(directory, "0-first.log"), "{}\n");
    await writeFile(log, `x ${leak} x\n`);
    let rotated = false;
    const result = await scanForSecrets({
      roots: [directory],
      afterFile: async (path) => {
        // Rotate the leaky log after it was listed but before it is read: rename it and start a fresh one.
        if (rotated || !path.endsWith("0-first.log")) return;
        rotated = true;
        await rename(log, `${log}.1`);
        await writeFile(log, "{}\n");
      },
    });
    expect(rotated).toBe(true);
    expect(result.findings).toEqual([{ kind: "known-token-pattern", path: `${log}.1`, patternName: "slack-token" }]);
    expect(result.skippedEntries).toEqual([]);
  });
});

test("secret scan treats a file removed before it is read as gone, not unreadable", async () => {
  await withFixture("agent-tag-secret-vanish-", async (directory) => {
    const doomed = join(directory, "service.log.9");
    await writeFile(join(directory, "0-first.log"), "{}\n");
    await writeFile(doomed, "old\n");
    const result = await scanForSecrets({
      roots: [directory],
      afterFile: async (path) => {
        if (path.endsWith("0-first.log")) await rm(doomed, { force: true });
      },
    });
    expect(result.skippedEntries).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });
});

test("secret scan reports a tree that never stops changing as unchecked", async () => {
  await withFixture("agent-tag-secret-churn-", async (directory) => {
    await writeFile(join(directory, "0.log"), "{}\n");
    let counter = 0;
    const result = await scanForSecrets({
      roots: [directory],
      afterFile: async () => {
        counter += 1;
        await writeFile(join(directory, `${counter}.log`), "{}\n");
      },
    });
    expect(result.skippedEntries.length).toBeGreaterThan(0);
    expect(result.skippedEntries.every((entry) => entry.reason === CHANGED_DURING_SCAN)).toBe(true);
  });
});

test("secret scan rereads a log that was appended to after its first read", async () => {
  await withFixture("agent-tag-secret-append-", async (directory) => {
    const leak = `xoxb-${"G7".repeat(15)}`;
    const first = join(directory, "a.log");
    await writeFile(first, "{}\n");
    await writeFile(join(directory, "b.log"), "{}\n");
    let appended = false;
    const result = await scanForSecrets({
      roots: [directory],
      afterFile: async (path) => {
        // a.log was already read; it grows while b.log is being scanned.
        if (appended || !path.endsWith("b.log")) return;
        appended = true;
        await appendFile(first, `x ${leak} x\n`);
      },
    });
    expect(appended).toBe(true);
    expect(result.findings).toEqual([{ kind: "known-token-pattern", path: first, patternName: "slack-token" }]);
    expect(result.skippedEntries).toEqual([]);
    expect(result.filesScanned).toBe(2);
    expect(JSON.stringify(result)).not.toContain(leak);
  });
});

test("secret scan reports a log that keeps growing past the pass cap as unchecked", async () => {
  await withFixture("agent-tag-secret-growing-", async (directory) => {
    const live = join(directory, "a.log");
    await writeFile(live, "{}\n");
    await writeFile(join(directory, "b.log"), "{}\n");
    const result = await scanForSecrets({
      roots: [directory],
      afterFile: async () => {
        await appendFile(live, "{}\n");
      },
    });
    expect(result.skippedEntries).toEqual([{ path: live, reason: CHANGED_DURING_SCAN }]);
  });
});

test("scanTextForSecrets reports line numbers and classes, never values", () => {
  const pat = `github_pat_${"A".repeat(30)}`;
  const slackToken = `xoxb-${"C".repeat(30)}`;
  const canary = `canary-${"d".repeat(40)}`;
  const text = ["clean line", `const a = "${pat}";`, "", `x ${slackToken} and ${canary}`, `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`].join("\n");
  const findings = scanTextForSecrets(text, { canaries: [{ name: "configured", secret: new SecretString(canary) }] });
  expect(findings).toEqual([
    { kind: "known-token-pattern", line: 2, patternName: "github-fine-grained-token" },
    { kind: "exact-secret", line: 4, canaryName: "configured" },
    { kind: "known-token-pattern", line: 4, patternName: "slack-token" },
    { kind: "known-token-pattern", line: 5, patternName: "private-key" },
  ]);
  const serialized = JSON.stringify(findings);
  expect(serialized).not.toContain(pat);
  expect(serialized).not.toContain(slackToken);
  expect(serialized).not.toContain(canary);
  expect(scanTextForSecrets("nothing to see\nhere")).toEqual([]);
});

test("the configured scan of a managed install skips T3's release and key pair but still scans its logs", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-tag-secret-scan-managed-")));
  try {
    const dataDir = join(directory, "data");
    const secrets = join(directory, "secrets");
    const home = join(dataDir, "t3", "home");
    const runtime = join(dataDir, "t3", "runtime");
    await mkdir(join(runtime, "versions", "0.0.45"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "userdata", "secrets"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "userdata", "logs"), { recursive: true, mode: 0o700 });
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await chmod(dataDir, 0o700);
    const t3Token = "t3-restricted-canary-value-0123456789";
    await writeFile(join(secrets, "t3-token"), t3Token, { mode: 0o600 });
    await writeFile(join(secrets, "slack-app-token"), "xapp-1-canary-app", { mode: 0o600 });
    await writeFile(join(secrets, "slack-bot-token"), "xoxb-canary-bot", { mode: 0o600 });
    const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    await writeFile(join(runtime, "versions", "0.0.45", "t3"), `${pem}\n`);
    await writeFile(join(home, "userdata", "secrets", "cloud-link-ed25519-key-pair.bin"), `${pem}\n`);
    await writeFile(join(home, "userdata", "logs", "server.log"), `bearer ${t3Token}\n`);
    const template = await Bun.file(join(import.meta.dir, "..", "config", "agent-tag.example.json")).json();
    const configPath = join(directory, "agent-tag.json");
    await writeFile(configPath, JSON.stringify({
      ...template,
      dataDir,
      t3: { mode: "managed", port: 37_899, tokenFile: join(secrets, "t3-token") },
      slack: { ...template.slack, appTokenFile: join(secrets, "slack-app-token"), botTokenFile: join(secrets, "slack-bot-token") },
      profiles: template.profiles.map((profile: Record<string, unknown>) => ({ ...profile, repositoryRoots: [directory] })),
      routes: template.routes.map((route: Record<string, unknown>) => ({ ...route, repositoryRoot: directory })),
    }), { mode: 0o600 });

    const run = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "scripts", "scan-secrets.ts"), "--config", configPath], { stdout: "pipe", stderr: "pipe" });
    if (run.stdout.toString().length === 0) throw new Error(run.stderr.toString());
    const report = JSON.parse(run.stdout.toString());
    expect(report.findings.map((finding: { path: string; kind: string }) => [finding.path, finding.kind])).toEqual([
      [join(home, "userdata", "logs", "server.log"), "exact-secret"],
    ]);
    expect(run.stdout.toString()).not.toContain(t3Token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
