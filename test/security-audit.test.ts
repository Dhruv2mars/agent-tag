import { describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAccess,
  checkInlineCredentials,
  checkPathPermissions,
  checkProfiles,
  checkReplaceableAncestors,
  checkRepositoryRoots,
  checkRetention,
  checkSecretScan,
  checkT3Session,
  checkT3Transport,
  formatSecurityReport,
  isLoopbackHost,
  summarizeFindings,
  type PathRole,
  type SecurityFinding,
} from "../src/security/audit.ts";
import { canonicalPath, guardDirectories, readAuditInputs, runSecurityAudit } from "../src/security/audit-run.ts";
import { T3HttpError } from "../src/t3/auth.ts";
import { parseCliArguments, runSecurityCli } from "../src/security/cli.ts";

const uid = 501;
const now = "2026-09-21T00:00:00.000Z";

function ids(findings: ReadonlyArray<SecurityFinding>): string[] {
  return findings.map((finding) => `${finding.severity}:${finding.id}`);
}

function file(role: PathRole, mode: number, owner = uid) {
  return checkPathPermissions({ path: `/x/${role}`, role, state: { kind: "file", mode: 0o100000 | mode, uid: owner } }, uid);
}

function directory(role: PathRole, mode: number) {
  return checkPathPermissions({ path: `/x/${role}`, role, state: { kind: "directory", mode: 0o040000 | mode, uid } }, uid);
}

describe("file permission checks", () => {
  test("secret files, the data directory, and the database must be owner-only", () => {
    expect(file("secret-file", 0o600)).toEqual([]);
    expect(file("secret-file", 0o400)).toEqual([]);
    expect(ids(file("secret-file", 0o644))).toEqual(["high:secret-file-mode"]);
    expect(ids(file("database", 0o640))).toEqual(["high:database-mode"]);
    expect(directory("data-directory", 0o700)).toEqual([]);
    expect(ids(directory("data-directory", 0o755))).toEqual(["high:data-directory-mode"]);
    expect(ids(directory("secret-directory", 0o750))).toEqual(["high:secret-directory-mode"]);
    expect(file("secret-file", 0o644)[0]?.message).toContain("0644");
    const shm = { path: "/x/db-shm", role: "database" as const, state: { kind: "file" as const, mode: 0o644, uid } };
    expect(ids(checkPathPermissions(shm, uid, { parentPrivate: true }))).toEqual(["low:database-mode"]);
    expect(ids(checkPathPermissions({ ...shm, role: "secret-file" }, uid, { parentPrivate: true }))).toEqual([
      "high:secret-file-mode",
    ]);
  });

  test("ownership, type, and existence problems are reported", () => {
    expect(ids(file("secret-file", 0o600, 0))).toEqual(["high:secret-file-owner"]);
    expect(ids(directory("secret-file", 0o700))).toEqual(["high:secret-file-type"]);
    expect(ids(checkPathPermissions({ path: "/x", role: "secret-file", state: { kind: "missing" } }, uid))).toEqual([
      "high:secret-file-missing",
    ]);
    expect(ids(checkPathPermissions({ path: "/x", role: "data-directory", state: { kind: "missing" } }, uid))).toEqual([
      "info:data-directory-missing",
    ]);
    expect(checkPathPermissions({ path: "/x", role: "log", state: { kind: "missing" } }, uid)).toEqual([]);
    const noLogs = checkPathPermissions({ path: "/x", role: "log-directory", state: { kind: "missing" } }, uid);
    expect(ids(noLogs)).toEqual(["low:log-directory-missing"]);
    expect(noLogs[0]?.remediation).toContain("--log-dir");
    expect(checkPathPermissions({ path: "/x", role: "secret-file", state: { kind: "file", mode: 0o600, uid: 0 } }, undefined)).toEqual([]);
  });

  test("symbolic links are graded by who can repoint them, and checks apply to the target", () => {
    const linked = (role: PathRole, replaceableByOthers: boolean, mode = 0o600) =>
      checkPathPermissions(
        { path: "/x/link", role, state: { kind: "file", mode, uid, link: { target: "/real/file", replaceableByOthers } } },
        uid,
      );
    expect(ids(linked("secret-file", false))).toEqual(["info:secret-file-symlink"]);
    expect(ids(linked("secret-file", true))).toEqual(["high:secret-file-symlink"]);
    expect(ids(linked("log", true))).toEqual(["medium:log-symlink"]);
    const loose = linked("secret-file", false, 0o644);
    expect(ids(loose)).toEqual(["info:secret-file-symlink", "high:secret-file-mode"]);
    expect(loose[1]?.remediation).toBe("chmod 600 /real/file");
  });

  test("a directory on the way to a path that other users can write lets them replace the path", () => {
    const guarded = (mode: number, options: { owner?: number; roles?: ReadonlyArray<PathRole> } = {}) =>
      checkReplaceableAncestors(
        [
          {
            path: "/shared",
            mode: 0o040000 | mode,
            uid: options.owner ?? uid,
            guards: (options.roles ?? ["config"]).map((role) => ({ role, path: `/shared/private/${role}` })),
          },
        ],
        uid,
      );
    const config = guarded(0o777);
    expect(ids(config)).toEqual(["high:ancestor-replaceable"]);
    expect(config[0]?.path).toBe("/shared");
    expect(config[0]?.message).toContain("world writable without the sticky bit");
    expect(config[0]?.message).toContain("changing the allowlist");
    expect(ids(guarded(0o775))).toEqual(["high:ancestor-replaceable"]);
    expect(guarded(0o775)[0]?.message).toContain("group writable");
    expect(ids(guarded(0o755, { owner: 777 }))).toEqual(["high:ancestor-replaceable"]);
    expect(guarded(0o1777)).toEqual([]);
    expect(guarded(0o755, { owner: 0 })).toEqual([]);
    expect(guarded(0o700)).toEqual([]);
    expect(ids(guarded(0o777, { roles: ["secret-file", "log"] }))).toEqual(["high:ancestor-replaceable"]);
    expect(ids(guarded(0o777, { roles: ["log-directory", "log"] }))).toEqual(["medium:ancestor-replaceable"]);
    expect(guarded(0o777, { roles: [] })).toEqual([]);
  });

  test("paths the auditing user cannot stat are reported instead of crashing", () => {
    const unreadable = (role: PathRole) =>
      checkPathPermissions({ path: "/x", role, state: { kind: "unreadable", code: "EACCES" } }, uid);
    for (const role of ["config", "secret-file", "secret-directory", "data-directory", "database"] as const) {
      expect(ids(unreadable(role))).toEqual([`high:${role}-unreadable`]);
    }
    expect(ids(unreadable("log"))).toEqual(["low:log-unreadable"]);
    expect(unreadable("secret-file")[0]?.message).toContain("EACCES");
  });

  test("config and logs grade read and write exposure", () => {
    expect(file("config", 0o600)).toEqual([]);
    expect(ids(file("config", 0o640))).toEqual(["low:config-group-readable"]);
    expect(ids(file("config", 0o644))).toEqual(["medium:config-world-readable"]);
    expect(ids(file("config", 0o664))).toEqual(["high:config-writable"]);
    expect(file("log", 0o600)).toEqual([]);
    expect(ids(file("log", 0o640))).toEqual(["low:log-group-accessible"]);
    expect(ids(file("log", 0o644))).toEqual(["medium:log-world-accessible"]);
    expect(ids(directory("log-directory", 0o755))).toEqual(["low:log-directory-world-accessible"]);
    expect(ids(file("log", 0o600, 0))).toEqual(["medium:log-owner"]);
  });
});

describe("config checks", () => {
  test("flags inline credentials without echoing them", () => {
    const token = `xoxb-${"Z9".repeat(15)}`;
    const raw = { slack: { botToken: "inline", appTokenFile: "/secrets/app" }, profiles: [{ apiSecret: "x" }] };
    const findings = checkInlineCredentials(`{"note":"${token}"}`, raw);
    expect(ids(findings)).toEqual([
      "high:config-inline-credential",
      "high:config-inline-token-field",
      "high:config-inline-token-field",
    ]);
    expect(findings.map((finding) => finding.message).join("\n")).toContain("slack.botToken");
    expect(findings.map((finding) => finding.message).join("\n")).toContain("profiles[0].apiSecret");
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(checkInlineCredentials('{"slack":{"botTokenFile":"/s/b"}}', { slack: { botTokenFile: "/s/b" } })).toEqual([]);
  });

  test("grades allowlists and admin configuration", () => {
    expect(ids(checkAccess({ allowedUserIds: ["U1"], allowedChannelIds: ["C1"] }))).toEqual([
      "info:access-summary",
      "info:access-no-admins",
    ]);
    expect(ids(checkAccess({ allowedUserIds: ["*"], allowedChannelIds: [] }))).toEqual([
      "high:access-users-wildcard",
      "medium:access-channels-empty",
      "info:access-summary",
      "info:access-no-admins",
    ]);
    expect(ids(checkAccess({ allowedUserIds: ["U1"], allowedChannelIds: ["C*"], adminUserIds: ["U2"] }))).toEqual([
      "high:access-channels-wildcard",
      "info:access-summary",
      "info:access-admins",
      "low:access-admin-not-allowed",
    ]);
  });

  test("requires TLS for a non-loopback T3", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(checkT3Transport("http://127.0.0.1:37841")).toEqual([]);
    expect(ids(checkT3Transport("http://t3.internal:37841"))).toEqual(["high:t3-url-plaintext-remote"]);
    expect(ids(checkT3Transport("https://t3.internal"))).toEqual(["medium:t3-url-remote"]);
    expect(ids(checkT3Transport("not a url"))).toEqual(["high:t3-url-invalid"]);
  });

  test("grades T3 token expiry, scope, and age", () => {
    const session = (expiresAt: string, scopes = ["orchestration:read", "orchestration:operate"]) => ({
      scopes,
      sessionMethod: "bearer-access-token",
      expiresAt,
    });
    expect(ids(checkT3Session({ now, session: session("2026-10-20T00:00:00.000Z") }))).toEqual(["info:t3-token-expiry"]);
    expect(ids(checkT3Session({ now, session: session("2026-09-25T00:00:00.000Z") }))).toEqual(["medium:t3-token-expiring"]);
    expect(ids(checkT3Session({ now, session: session("2026-09-22T00:00:00.000Z") }))).toEqual(["high:t3-token-expiring"]);
    expect(ids(checkT3Session({ now, session: session("2026-09-20T00:00:00.000Z") }))).toEqual(["high:t3-token-expired"]);
    expect(
      ids(checkT3Session({ now, session: session("2026-10-20T00:00:00.000Z", ["orchestration:read", "access:write"]) })),
    ).toEqual(["info:t3-token-expiry", "high:t3-token-overscoped", "medium:t3-token-underscoped"]);
    expect(
      ids(checkT3Session({ now, unavailableReason: "offline", tokenModifiedAt: "2026-07-01T00:00:00.000Z" })),
    ).toEqual(["info:t3-session-unchecked", "medium:t3-token-old"]);
    expect(ids(checkT3Session({ now, unavailableReason: "offline", tokenModifiedAt: "2026-09-01T00:00:00.000Z" }))).toEqual([
      "info:t3-session-unchecked",
    ]);
    const rejected = checkT3Session({ now, rejectedStatus: 401, tokenModifiedAt: "2026-09-01T00:00:00.000Z" });
    expect(ids(rejected)).toEqual(["high:t3-token-rejected"]);
    expect(rejected[0]?.message).toContain("HTTP 401");
  });

  test("rejects repository roots that expose the home directory or Agent Tag state", () => {
    const protectedPaths = [
      { label: "data directory", path: "/srv/agent-tag/data", severity: "high" as const },
      { label: "config file", path: "/srv/agent-tag/agent-tag.json", severity: "medium" as const },
    ];
    const check = (root: string) =>
      ids(checkRepositoryRoots({ roots: [{ profileId: "p", root }], home: "/Users/me", protectedPaths }));
    expect(check("/srv/repos/app")).toEqual([]);
    expect(check("/")).toEqual(["high:repo-root-filesystem", "high:repo-root-contains-private-path", "medium:repo-root-contains-private-path"]);
    expect(check("/Users/me")).toEqual(["high:repo-root-home"]);
    expect(check("/Users")).toEqual(["high:repo-root-home"]);
    expect(check("/Users/me/code/app")).toEqual([]);
    expect(check("/Users/meow")).toEqual([]);
    expect(check("/srv/agent-tag")).toEqual(["high:repo-root-contains-private-path", "medium:repo-root-contains-private-path"]);
    // Canonical forms decide: a root that links to home, and a root above a linked parent such as macOS /tmp.
    expect(
      ids(checkRepositoryRoots({ roots: [{ profileId: "p", root: "/srv/link", realRoot: "/Users/me" }], home: "/Users/me", protectedPaths: [] })),
    ).toEqual(["high:repo-root-home"]);
    expect(
      ids(
        checkRepositoryRoots({
          roots: [{ profileId: "p", root: "/private/tmp", realRoot: "/private/tmp" }],
          home: "/Users/me",
          protectedPaths: [{ label: "data directory", path: "/tmp/sa/data", realPath: "/private/tmp/sa/data", severity: "high" }],
        }),
      ),
    ).toEqual(["high:repo-root-contains-private-path"]);
    expect(
      ids(checkRepositoryRoots({ roots: [{ profileId: "p", root: "/srv/repos/app" }], home: "/var/home/me", realHome: "/srv/repos/app/me", protectedPaths: [] })),
    ).toEqual(["high:repo-root-home"]);
  });

  test("flags approval bypass and unenforced isolation", () => {
    const base = { id: "p", isolationMode: "trusted-same-user", externalWritesMode: "deny", ambientEnabled: false };
    expect(ids(checkProfiles([{ ...base, runtimeMode: "approval-required" }]))).toEqual([
      "info:profile-tier1-same-user",
      "low:profile-external-writes-advisory",
    ]);
    expect(ids(checkProfiles([{ ...base, runtimeMode: "auto-accept-edits", ambientEnabled: true }]))).toEqual([
      "medium:profile-auto-accept-edits",
      "info:profile-tier1-same-user",
      "low:profile-external-writes-advisory",
      "info:profile-ambient-enabled",
    ]);
    expect(ids(checkProfiles([{ ...base, runtimeMode: "full-access", isolationMode: "container" }]))).toEqual([
      "high:profile-approval-bypass",
      "medium:profile-isolation-unenforced",
      "low:profile-external-writes-advisory",
    ]);
  });

  test("reports missing retention and secret scan hits", () => {
    expect(ids(checkRetention({}))).toEqual(["low:retention-disabled"]);
    expect(ids(checkRetention({ auditDays: 1 }))).toEqual(["info:retention-partial"]);
    expect(checkRetention({ auditDays: 1, outboxDays: 1, messageDays: 1 })).toEqual([]);
    expect(
      ids(
        checkSecretScan({
          filesScanned: 2,
          bytesScanned: 10,
          symlinksSkipped: 1,
          skippedEntries: [],
          findings: [
            { kind: "exact-secret", path: "/d/a", canaryName: "slack-bot-token" },
            { kind: "known-token-pattern", path: "/d/b", patternName: "github-token" },
          ],
        }),
      ),
    ).toEqual(["high:secret-at-rest", "high:secret-at-rest", "low:secret-scan-incomplete"]);
    const remediations = checkSecretScan(
      {
        filesScanned: 2,
        bytesScanned: 10,
        symlinksSkipped: 0,
        skippedEntries: [],
        findings: [
          { kind: "known-token-pattern", path: "/d/agent-tag.sqlite-wal", patternName: "slack-token" },
          { kind: "known-token-pattern", path: "/logs/service.stderr.log", patternName: "slack-token" },
        ],
      },
      { databasePaths: ["/d/agent-tag.sqlite", "/d/agent-tag.sqlite-wal"] },
    ).map((finding) => finding.remediation);
    expect(remediations[0]).toContain("docs/operations.md#purging-content-from-the-store");
    expect(remediations[0]).toContain("VACUUM");
    expect(remediations[1]).toBe("rotate the credential, then delete or rewrite the file");
  });

  test("an entry the secret scan could not read is high severity, listed by path, and capped", () => {
    const unreadable = checkSecretScan({
      filesScanned: 1,
      bytesScanned: 10,
      symlinksSkipped: 0,
      skippedEntries: [
        { path: "/d/locked.bin", reason: "EACCES" },
        { path: "/logs/agent-tag.log", reason: "changed during the scan" },
      ],
      findings: [{ kind: "known-token-pattern", path: "/d/a", patternName: "slack-token" }],
    });
    expect(ids(unreadable)).toEqual(["high:secret-at-rest", "high:secret-scan-unreadable", "high:secret-scan-unreadable"]);
    expect(unreadable.slice(1).map((finding) => finding.path)).toEqual(["/d/locked.bin", "/logs/agent-tag.log"]);
    expect(unreadable[1]?.message).toContain("EACCES");
    expect(summarizeFindings(unreadable.slice(1), now).result).toBe("fail");

    const many = checkSecretScan({
      filesScanned: 0,
      bytesScanned: 0,
      symlinksSkipped: 0,
      skippedEntries: Array.from({ length: 25 }, (_, index) => ({ path: `/d/f${index}`, reason: "EACCES" })),
      findings: [],
    });
    expect(many).toHaveLength(21);
    expect(many.filter((finding) => finding.path !== undefined)).toHaveLength(20);
    expect(many.at(-1)?.message).toContain("5 more path(s)");
  });

  test("reads audit facts leniently from a config that fails validation", () => {
    const inputs = readAuditInputs({
      dataDir: "relative/data",
      t3: { baseUrl: "http://10.0.0.5", tokenFile: "/s/t3" },
      slack: "broken",
      access: { allowedUserIds: ["*", 7], allowedChannelIds: "C1" },
      profiles: [
        { id: "a", repositoryRoots: ["/", "relative"], runtimeMode: "full-access", isolation: { mode: "trusted-same-user" }, externalWrites: { mode: "deny" } },
        { repositoryRoots: ["/srv/b"] },
        "junk",
      ],
      retention: { auditDays: -1, messageDays: 30 },
    });
    expect(inputs.dataDir).toBeUndefined();
    expect(inputs.t3BaseUrl).toBe("http://10.0.0.5");
    expect(inputs.secretFiles).toEqual([{ name: "t3-service-token", path: "/s/t3" }]);
    expect(inputs.access).toEqual({ allowedUserIds: ["*"], allowedChannelIds: [] });
    expect(inputs.roots).toEqual([
      { profileId: "a", root: "/" },
      { profileId: "(unnamed)", root: "/srv/b" },
    ]);
    expect(inputs.profiles).toEqual([
      { id: "a", runtimeMode: "full-access", isolationMode: "trusted-same-user", externalWritesMode: "deny", ambientEnabled: false },
    ]);
    expect(inputs.retention).toEqual({ messageDays: 30 });
    expect(readAuditInputs([]).secretFiles).toEqual([]);
  });

  test("sorts findings and fails only on high severity", () => {
    const report = summarizeFindings(
      [
        { id: "b", severity: "info", message: "i" },
        { id: "a", severity: "medium", message: "m", path: "/p", remediation: "fix it" },
      ],
      now,
    );
    expect(report.result).toBe("pass");
    expect(report.findings.map((finding) => finding.id)).toEqual(["a", "b"]);
    expect(report.counts).toEqual({ high: 0, medium: 1, low: 0, info: 1 });
    expect(formatSecurityReport(report)).toContain("MEDIUM a: m (/p)\n        fix: fix it");
    expect(summarizeFindings([{ id: "x", severity: "high", message: "h" }], now).result).toBe("fail");
  });

  test("parses CLI flags strictly", () => {
    const parsed = parseCliArguments(["audit", "--json", "/c.json"], ["--json"]);
    expect(parsed.positionals).toEqual(["audit", "/c.json"]);
    expect([...parsed.flags]).toEqual(["--json"]);
    expect(() => parseCliArguments(["--force"], ["--json"])).toThrow("unknown option --force");
    expect([...parseCliArguments(["audit", "--log-dir", "/var/log/at", "/c"], [], ["--log-dir"]).values]).toEqual([
      ["--log-dir", "/var/log/at"],
    ]);
    expect(parseCliArguments(["--log-dir=/l", "/c"], [], ["--log-dir"]).values.get("--log-dir")).toBe("/l");
    expect(() => parseCliArguments(["/c", "--log-dir"], [], ["--log-dir"])).toThrow("needs a value");
    expect(() => parseCliArguments(["--log-dir", "--json"], ["--json"], ["--log-dir"])).toThrow("needs a value");
    expect(() => parseCliArguments(["--json=1"], ["--json"])).toThrow("unknown option --json=1");
  });
});

describe("security audit run", () => {
  async function withHost(
    run: (input: { readonly root: string; readonly configPath: string; readonly config: Record<string, unknown> }) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "agent-tag-security-"));
    try {
      const secrets = join(root, "secrets");
      const data = join(root, "data");
      const logs = join(root, "logs");
      await mkdir(secrets, { mode: 0o700 });
      await mkdir(data, { mode: 0o700 });
      await mkdir(logs, { mode: 0o700 });
      await mkdir(join(root, "repo"));
      for (const name of ["t3-token", "slack-app-token", "slack-bot-token"]) {
        await writeFile(join(secrets, name), `${name}-${"q".repeat(40)}\n`, { mode: 0o600 });
      }
      await writeFile(join(logs, "service.stdout.log"), "{}\n", { mode: 0o600 });
      const config = {
        version: 1,
        dataDir: data,
        t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: join(secrets, "t3-token") },
        slack: {
          workspaceId: "T1",
          appTokenFile: join(secrets, "slack-app-token"),
          botTokenFile: join(secrets, "slack-bot-token"),
        },
        access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
        profiles: [
          {
            id: "engineering",
            repositoryRoots: [join(root, "repo")],
            defaultProviderInstanceId: "codex",
            defaultModel: "gpt",
            runtimeMode: "approval-required",
            isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
            externalWrites: { mode: "deny" },
            memory: { shared: true, privateDm: false, retentionDays: 30 },
          },
        ],
        routes: [{ conversationId: "C1", profileId: "engineering" }],
        limits: { maxConcurrentTasks: 1 },
        retention: { auditDays: 365, outboxDays: 30, messageDays: 30 },
      };
      const configPath = join(root, "agent-tag.json");
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await run({ root, configPath, config });
    } finally {
      if (!root.startsWith(`${tmpdir()}/agent-tag-security-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${root}`);
      }
      await rm(root, { recursive: true });
    }
  }

  test("passes a private host and fails once secrets leak or permissions loosen", async () => {
    await withHost(async ({ root, configPath }) => {
      const options = {
        configPath,
        now: new Date(now),
        home: "/nonexistent-home",
        logDirectory: join(root, "logs"),
        logFiles: [join(root, "logs", "service.stdout.log")],
        inspectSession: async () => ({
          scopes: ["orchestration:read", "orchestration:operate"],
          sessionMethod: "bearer-access-token",
          expiresAt: "2026-10-20T00:00:00.000Z",
        }),
      };
      const clean = await runSecurityAudit(options);
      expect(clean.result).toBe("pass");
      expect(clean.counts.high).toBe(0);
      expect(ids(clean.findings)).toContain("info:t3-token-expiry");

      await writeFile(join(root, "logs", "service.stdout.log"), `leak ${"t3-token-"}${"q".repeat(40)}\n`, { mode: 0o600 });
      await chmod(join(root, "secrets", "slack-bot-token"), 0o644);
      await chmod(join(root, "logs", "service.stdout.log"), 0o644);
      const leaky = await runSecurityAudit(options);
      expect(leaky.result).toBe("fail");
      expect(ids(leaky.findings)).toEqual(
        expect.arrayContaining(["high:secret-file-mode", "high:secret-at-rest", "medium:log-world-accessible"]),
      );
      expect(JSON.stringify(leaky)).not.toContain("q".repeat(40));
    });
  });

  test("offline mode reports an old token file and a session failure is not fatal", async () => {
    await withHost(async ({ root, configPath }) => {
      const old = new Date("2026-07-01T00:00:00.000Z");
      await utimes(join(root, "secrets", "t3-token"), old, old);
      const offline = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true });
      expect(ids(offline.findings)).toEqual(expect.arrayContaining(["info:t3-session-unchecked", "medium:t3-token-old"]));
      const unreachable = await runSecurityAudit({
        configPath,
        now: new Date(now),
        home: "/nonexistent-home",
        inspectSession: async () => {
          throw new T3HttpError("session", 503);
        },
      });
      expect(unreachable.findings.find((finding) => finding.id === "t3-session-unchecked")?.message).toContain("HTTP 503");
      expect(ids(unreachable.findings)).toContain("medium:t3-token-old");
    });
  });

  test("fails when T3 rejects the service token", async () => {
    await withHost(async ({ configPath }) => {
      for (const status of [401, 403]) {
        const report = await runSecurityAudit({
          configPath,
          now: new Date(now),
          home: "/nonexistent-home",
          inspectSession: async () => {
            throw new T3HttpError("session", status);
          },
        });
        expect(report.result).toBe("fail");
        expect(ids(report.findings)).toContain("high:t3-token-rejected");
        expect(ids(report.findings)).not.toContain("info:t3-session-unchecked");
      }
    });
  });

  test("keeps checking a config that fails validation, without sending the token anywhere", async () => {
    await withHost(async ({ root, configPath, config }) => {
      const profiles = config.profiles as Array<Record<string, unknown>>;
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          t3: { ...(config.t3 as object), baseUrl: "http://10.0.0.5:37841" },
          access: { allowedUserIds: ["*"], allowedChannelIds: [] },
          profiles: profiles.map((profile) => ({ ...profile, runtimeMode: "full-access" })),
        }),
        { mode: 0o600 },
      );
      await chmod(join(root, "secrets", "slack-bot-token"), 0o644);
      let inspected = false;
      const report = await runSecurityAudit({
        configPath,
        now: new Date(now),
        home: "/nonexistent-home",
        logDirectory: join(root, "logs"),
        logFiles: [],
        inspectSession: async () => {
          inspected = true;
          throw new Error("must not be called");
        },
      });
      expect(inspected).toBe(false);
      expect(report.result).toBe("fail");
      expect(ids(report.findings)).toEqual(
        expect.arrayContaining([
          "high:config-invalid",
          "high:t3-url-plaintext-remote",
          "high:access-users-wildcard",
          "medium:access-channels-empty",
          "high:profile-approval-bypass",
          "high:secret-file-mode",
          "info:t3-session-unchecked",
        ]),
      );
      expect(report.findings.find((finding) => finding.id === "config-invalid")?.message).toContain("access.allowedUserIds");
    });
  });

  test("reports unreadable config without continuing", async () => {
    await withHost(async ({ root, configPath }) => {
      await writeFile(configPath, "{", { mode: 0o600 });
      expect(ids((await runSecurityAudit({ configPath, now: new Date(now), home: "/h" })).findings)).toEqual([
        "high:config-unreadable",
      ]);
      expect(ids((await runSecurityAudit({ configPath: join(root, "missing.json"), now: new Date(now), home: "/h" })).findings)).toEqual([
        "high:config-missing",
        "high:config-unreadable",
      ]);
    });
  });

  test("sees through symlinked repository roots and parent directories", async () => {
    await withHost(async ({ root, configPath, config }) => {
      const home = join(root, "home");
      await mkdir(home);
      await symlink(home, join(root, "home-link"));
      await symlink(root, join(root, "root-link"));
      const profiles = config.profiles as Array<Record<string, unknown>>;
      const write = async (repositoryRoots: string[], dataDir = config.dataDir) =>
        writeFile(
          configPath,
          JSON.stringify({ ...config, dataDir, profiles: profiles.map((profile) => ({ ...profile, repositoryRoots })) }),
          { mode: 0o600 },
        );
      const audit = async () =>
        ids((await runSecurityAudit({ configPath, now: new Date(now), home, offline: true, logDirectory: join(root, "logs"), logFiles: [] })).findings);

      await write([join(root, "home-link")]);
      expect(await audit()).toContain("high:repo-root-home");

      // The data directory is configured through a linked parent; the root names the real directory.
      await write([await realpath(root)], join(root, "root-link", "data"));
      expect(await audit()).toEqual(expect.arrayContaining(["high:repo-root-contains-private-path"]));

      await write([join(root, "repo")]);
      expect(await audit()).not.toContain("high:repo-root-contains-private-path");
      expect(await canonicalPath(join(root, "root-link", "missing", "x"))).toBe(join(await realpath(root), "missing", "x"));
    });
  });

  test("reports a symlinked secret file that other users can repoint", async () => {
    await withHost(async ({ root, configPath, config }) => {
      const shared = join(root, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      await symlink(join(root, "secrets", "slack-app-token"), join(shared, "slack-app-token"));
      const slack = config.slack as Record<string, unknown>;
      await writeFile(configPath, JSON.stringify({ ...config, slack: { ...slack, appTokenFile: join(shared, "slack-app-token") } }), { mode: 0o600 });
      const report = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] });
      expect(ids(report.findings)).toEqual(expect.arrayContaining(["high:secret-file-symlink", "high:secret-directory-mode"]));
      expect(ids(report.findings)).not.toContain("high:secret-file-mode");
    });
  });

  test("an unreadable secrets directory is a finding, not a crash", async () => {
    if (process.getuid?.() === 0) return; // root bypasses directory permissions
    await withHost(async ({ root, configPath }) => {
      await chmod(join(root, "secrets"), 0o000);
      try {
        const report = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] });
        expect(report.result).toBe("fail");
        expect(ids(report.findings).filter((id) => id === "high:secret-file-unreadable")).toHaveLength(3);
        expect(ids(report.findings)).not.toContain("high:secret-file-missing");
      } finally {
        await chmod(join(root, "secrets"), 0o700);
      }
    });
  });

  test("points a credential found in the store at the purge procedure", async () => {
    await withHost(async ({ root, configPath }) => {
      await writeFile(join(root, "data", "agent-tag.sqlite"), `x xoxb-${"A1".repeat(15)} x`, { mode: 0o600 });
      await writeFile(join(root, "logs", "service.stderr.log"), `x xoxb-${"B2".repeat(15)} x`, { mode: 0o600 });
      const report = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] });
      const atRest = report.findings.filter((finding) => finding.id === "secret-at-rest");
      expect(atRest).toHaveLength(2);
      const store = atRest.find((finding) => finding.path?.endsWith("agent-tag.sqlite"));
      expect(store?.remediation).toContain("#purging-content-from-the-store");
      expect(atRest.find((finding) => finding.path?.endsWith(".log"))?.remediation).not.toContain("VACUUM");
    });
  });

  test("an unreadable file in the data directory does not hide a leak elsewhere or let the audit pass", async () => {
    if (process.getuid?.() === 0) return; // root bypasses file permissions
    await withHost(async ({ root, configPath }) => {
      const locked = join(root, "data", "locked.bin");
      const lockedDirectory = join(root, "logs", "archive");
      await writeFile(locked, "x\n", { mode: 0o600 });
      await mkdir(lockedDirectory, { mode: 0o700 });
      await chmod(locked, 0o000);
      await chmod(lockedDirectory, 0o000);
      const options = { configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] };
      try {
        const clean = await runSecurityAudit(options);
        expect(clean.result).toBe("fail");
        expect(ids(clean.findings)).not.toContain("high:secret-scan-failed");
        expect(clean.findings.filter((finding) => finding.id === "secret-scan-unreadable").map((finding) => finding.path)).toEqual([
          join(await realpath(root), "data", "locked.bin"),
          join(await realpath(root), "logs", "archive"),
        ]);

        const leak = `xoxb-${"F6".repeat(15)}`;
        await writeFile(join(root, "logs", "service.stdout.log"), `x ${leak} x\n`, { mode: 0o600 });
        const leaky = await runSecurityAudit(options);
        expect(leaky.findings.find((finding) => finding.id === "secret-at-rest")?.path).toBe(
          await realpath(join(root, "logs", "service.stdout.log")),
        );
        expect(ids(leaky.findings).filter((id) => id === "high:secret-scan-unreadable")).toHaveLength(2);
        expect(JSON.stringify(leaky)).not.toContain(leak);
      } finally {
        await chmod(lockedDirectory, 0o700);
        await chmod(locked, 0o600);
      }
    });
  });

  test("a private deployment under any directory other users can write fails the audit", async () => {
    await withHost(async ({ root, configPath }) => {
      const options = { configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] };
      const replaceable = async () =>
        (await runSecurityAudit(options)).findings.filter((finding) => finding.id === "ancestor-replaceable");
      expect(await replaceable()).toEqual([]);
      const realRoot = await realpath(root);
      try {
        // The secrets, data, and log directories stay private (0700); the shared directory above them is enough.
        await chmod(root, 0o777);
        const shared = await runSecurityAudit(options);
        expect(shared.result).toBe("fail");
        const found = shared.findings.filter((finding) => finding.id === "ancestor-replaceable");
        expect(found.map((finding) => `${finding.severity}:${finding.path}`)).toEqual([`high:${realRoot}`]);
        expect(found[0]?.message).toContain("config");
        expect(found[0]?.message).toContain("secret-file");
        expect(found[0]?.message).toContain("changing the allowlist");
        // Bun's chmod drops the sticky bit (Bun 1.3), so set it with the system tool.
        expect(Bun.spawnSync(["chmod", "1777", root]).exitCode).toBe(0);
        expect(await replaceable()).toEqual([]);
      } finally {
        await chmod(root, 0o700);
      }
    });
  });

  test("a symlinked component is followed, and the directory holding the link is checked", async () => {
    await withHost(async ({ root, configPath, config }) => {
      const realRoot = await realpath(root);
      const shared = join(root, "shared");
      await mkdir(shared, { mode: 0o700 });
      await symlink(join(root, "secrets"), join(shared, "secrets-link"));
      const linked = join(shared, "secrets-link", "slack-app-token");
      expect(await guardDirectories(linked)).toEqual(
        expect.arrayContaining([realRoot, join(realRoot, "shared"), join(realRoot, "secrets")]),
      );
      // `..` after a link climbs from the link target, not lexically (join() would collapse it, so build the string).
      const climbed = await guardDirectories(`${shared}/secrets-link/../data/agent-tag.sqlite`);
      expect(climbed).toEqual(expect.arrayContaining([realRoot, join(realRoot, "shared"), join(realRoot, "data")]));
      expect(climbed).not.toContain(join(realRoot, "shared", "data"));

      const slack = config.slack as Record<string, unknown>;
      await writeFile(configPath, JSON.stringify({ ...config, slack: { ...slack, appTokenFile: linked } }), { mode: 0o600 });
      const options = { configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] };
      expect((await runSecurityAudit(options)).findings.filter((finding) => finding.id === "ancestor-replaceable")).toEqual([]);
      try {
        await chmod(shared, 0o777);
        const report = await runSecurityAudit(options);
        expect(report.result).toBe("fail");
        const found = report.findings.filter((finding) => finding.id === "ancestor-replaceable");
        expect(found.map((finding) => `${finding.severity}:${finding.path}`)).toEqual([`high:${join(realRoot, "shared")}`]);
        expect(found[0]?.message).toContain("secret-file");
      } finally {
        await chmod(shared, 0o700);
      }
    });
  });

  test("a loose store file is downgraded only while it really sits inside the private data directory", async () => {
    await withHost(async ({ root, configPath }) => {
      const options = { configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: join(root, "logs"), logFiles: [] };
      const store = join(root, "data", "agent-tag.sqlite");
      await writeFile(store, "store\n", { mode: 0o644 });
      await chmod(store, 0o644);
      const inside = await runSecurityAudit(options);
      expect(inside.findings.filter((finding) => finding.id === "database-mode").map((finding) => finding.severity)).toEqual(["low"]);
      expect(inside.result).toBe("pass");

      // The link stays in the private directory, but the file it opens is readable through a traversable one.
      await rm(store);
      const exposed = join(root, "exposed");
      await mkdir(exposed, { mode: 0o755 });
      await chmod(exposed, 0o755);
      await writeFile(join(exposed, "agent-tag.sqlite"), "store\n", { mode: 0o644 });
      await chmod(join(exposed, "agent-tag.sqlite"), 0o644);
      await symlink(join(exposed, "agent-tag.sqlite"), store);
      const outside = await runSecurityAudit(options);
      expect(outside.findings.filter((finding) => finding.id === "database-mode").map((finding) => finding.severity)).toEqual(["high"]);
      expect(outside.result).toBe("fail");
    });
  });

  test("checks every file in a custom log directory and says when no logs were found", async () => {
    await withHost(async ({ root, configPath }) => {
      const missing = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true });
      expect(ids(missing.findings)).toContain("low:log-directory-missing");

      const logs = join(root, "var-log");
      await mkdir(logs, { mode: 0o700 });
      await writeFile(join(logs, "agent-tag.log"), "{}\n", { mode: 0o600 });
      await writeFile(join(logs, "agent-tag.log.1"), `x xoxb-${"C3".repeat(15)} x`, { mode: 0o644 });
      const custom = await runSecurityAudit({ configPath, now: new Date(now), home: "/nonexistent-home", offline: true, logDirectory: logs });
      expect(ids(custom.findings)).not.toContain("low:log-directory-missing");
      expect(custom.findings.filter((finding) => finding.id === "log-world-accessible").map((finding) => finding.path)).toEqual([
        join(logs, "agent-tag.log.1"),
      ]);
      expect(ids(custom.findings)).toContain("high:secret-at-rest");

      const printed: string[] = [];
      const log = spyOn(console, "log").mockImplementation((line: string) => {
        printed.push(line);
      });
      try {
        expect(await runSecurityCli(["security", "audit", configPath, "--json", "--offline", "--log-dir", logs])).toBe(1);
      } finally {
        log.mockRestore();
      }
      const report = JSON.parse(printed.join("\n")) as { findings: Array<{ id: string; path?: string }> };
      expect(report.findings.some((finding) => finding.id === "log-world-accessible" && finding.path === join(logs, "agent-tag.log.1"))).toBe(true);
    });
  });
});
