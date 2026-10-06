import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAccess,
  checkInlineCredentials,
  checkPathPermissions,
  checkProfiles,
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
import { runSecurityAudit } from "../src/security/audit-run.ts";
import { parseCliArguments } from "../src/security/cli.ts";

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
    expect(checkPathPermissions({ path: "/x", role: "secret-file", state: { kind: "file", mode: 0o600, uid: 0 } }, undefined)).toEqual([]);
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
          findings: [
            { kind: "exact-secret", path: "/d/a", canaryName: "slack-bot-token" },
            { kind: "known-token-pattern", path: "/d/b", patternName: "github-token" },
          ],
        }),
      ),
    ).toEqual(["high:secret-at-rest", "high:secret-at-rest", "low:secret-scan-incomplete"]);
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
          throw new Error("T3 session endpoint returned HTTP 401");
        },
      });
      expect(unreachable.findings.find((finding) => finding.id === "t3-session-unchecked")?.message).toContain("HTTP 401");
    });
  });

  test("reports invalid or unreadable config without continuing", async () => {
    await withHost(async ({ root, configPath, config }) => {
      await writeFile(configPath, JSON.stringify({ ...config, access: { allowedUserIds: [] } }), { mode: 0o600 });
      const invalid = await runSecurityAudit({ configPath, now: new Date(now), home: "/h", offline: true });
      expect(ids(invalid.findings)).toEqual(["high:config-invalid"]);
      expect(invalid.findings[0]?.message).toContain("access.allowedUserIds");
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
});
