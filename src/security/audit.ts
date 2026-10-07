import { isAbsolute, relative, resolve, sep } from "node:path";

import { REQUIRED_T3_SCOPES } from "../t3/auth.ts";
import type { RetentionPolicy } from "../store/retention.ts";
import { knownSecretClasses } from "./redact.ts";
import type { SecretScanResult } from "./secret-scan.ts";

export type SecuritySeverity = "high" | "medium" | "low" | "info";

export interface SecurityFinding {
  /** Stable kebab-case check identifier. */
  readonly id: string;
  readonly severity: SecuritySeverity;
  readonly message: string;
  readonly path?: string;
  readonly remediation?: string;
}

export interface SecurityReport {
  readonly generatedAt: string;
  readonly result: "pass" | "fail";
  readonly counts: Readonly<Record<SecuritySeverity, number>>;
  readonly findings: ReadonlyArray<SecurityFinding>;
}

const SEVERITY_ORDER: Readonly<Record<SecuritySeverity, number>> = { high: 0, medium: 1, low: 2, info: 3 };

export function summarizeFindings(
  findings: ReadonlyArray<SecurityFinding>,
  generatedAt: string,
): SecurityReport {
  const sorted = [...findings].sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || left.id.localeCompare(right.id),
  );
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of sorted) counts[finding.severity] += 1;
  return { generatedAt, result: counts.high > 0 ? "fail" : "pass", counts, findings: sorted };
}

export function formatSecurityReport(report: SecurityReport): string {
  const lines = report.findings.map((finding) => {
    const location = finding.path === undefined ? "" : ` (${finding.path})`;
    const fix = finding.remediation === undefined ? "" : `\n        fix: ${finding.remediation}`;
    return `${finding.severity.toUpperCase().padEnd(6)} ${finding.id}: ${finding.message}${location}${fix}`;
  });
  const { high, medium, low, info } = report.counts;
  lines.push(`\n${report.result.toUpperCase()}: ${high} high, ${medium} medium, ${low} low, ${info} info`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File permissions

export type PathRole =
  | "config"
  | "secret-file"
  | "secret-directory"
  | "data-directory"
  | "database"
  | "log"
  | "log-directory";

/** Present when the configured path is a symbolic link; mode, owner, and kind then describe its target. */
export interface PathLink {
  readonly target: string;
  /** Another local user can replace the link because its directory is group or world writable without the sticky bit. */
  readonly replaceableByOthers: boolean;
}

export type PathState =
  | { readonly kind: "missing" }
  /** The auditing user cannot stat the path (for example EACCES on a parent owned by another account). */
  | { readonly kind: "unreadable"; readonly code: string }
  | {
      readonly kind: "file" | "directory" | "other";
      readonly mode: number;
      readonly uid: number;
      readonly link?: PathLink | undefined;
    };

export interface PathFact {
  readonly path: string;
  readonly role: PathRole;
  readonly state: PathState;
}

const DIRECTORY_ROLES: ReadonlySet<PathRole> = new Set(["secret-directory", "data-directory", "log-directory"]);
const PRIVATE_ROLES: ReadonlySet<PathRole> = new Set([
  "secret-file",
  "secret-directory",
  "data-directory",
  "database",
]);

/** A directory on the way to an audited path: its own ancestors, or the directory holding a symlink on the way. */
export interface GuardDirectory {
  readonly path: string;
  readonly mode: number;
  readonly uid: number;
  /** The audited paths someone could swap by renaming or replacing entries in this directory. */
  readonly guards: ReadonlyArray<{ readonly role: PathRole; readonly path: string }>;
}

/**
 * Why another local user could rename or replace entries in `directory`, or undefined if they cannot.
 * Root-owned directories are trusted as owners; the owner of a directory can replace its entries even
 * with the sticky bit.
 */
export function directoryReplaceability(
  directory: { readonly mode: number; readonly uid: number },
  ownerUid: number | undefined,
): string | undefined {
  const mode = directory.mode & 0o7777;
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    return `has mode ${formatMode(mode)} (${(mode & 0o002) !== 0 ? "world" : "group"} writable without the sticky bit)`;
  }
  if (ownerUid !== undefined && directory.uid !== ownerUid && directory.uid !== 0) {
    return `is owned by uid ${directory.uid}, not the Agent Tag user (uid ${ownerUid})`;
  }
  return undefined;
}

/**
 * Whoever can rename or replace an entry in any directory on the way to a path (each real ancestor, and the
 * directory holding each symlink on the way) can swap the path itself, whatever its own mode. One finding per
 * directory.
 */
export function checkReplaceableAncestors(
  directories: ReadonlyArray<GuardDirectory>,
  ownerUid: number | undefined,
): SecurityFinding[] {
  return directories.flatMap((directory): SecurityFinding[] => {
    const reason = directoryReplaceability(directory, ownerUid);
    if (reason === undefined || directory.guards.length === 0) return [];
    const roles = [...new Set(directory.guards.map((guard) => guard.role))];
    const sensitive = roles.some((role) => role !== "log" && role !== "log-directory");
    return [{
      id: "ancestor-replaceable",
      severity: sensitive ? "high" : "medium",
      message: `${directory.path} ${reason}; another local user can rename or replace what is inside it, swapping the ${roles.join(", ")} below it${roles.includes("config") ? " and changing the allowlist" : ""}`,
      path: directory.path,
      remediation: `make ${directory.path} owned by the service user or root and not writable by others (chmod go-w), or move Agent Tag's files out from under it`,
    }];
  });
}

export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * `parentPrivate` marks a file whose directory already denies group and world access; loose modes on
 * database files are then defence-in-depth issues rather than exposures.
 */
export function checkPathPermissions(
  fact: PathFact,
  ownerUid: number | undefined,
  options: { readonly parentPrivate?: boolean } = {},
): SecurityFinding[] {
  const { path, role, state } = fact;
  const directory = DIRECTORY_ROLES.has(role);
  const expected = directory ? "0700" : "0600";
  if (state.kind === "missing") {
    if (role === "secret-file" || role === "secret-directory" || role === "config") {
      return [{ id: `${role}-missing`, severity: "high", message: `${role} does not exist`, path }];
    }
    if (role === "data-directory") {
      return [{
        id: "data-directory-missing",
        severity: "info",
        message: "data directory does not exist yet; the service creates it with mode 0700",
        path,
      }];
    }
    if (role === "log-directory") {
      return [{
        id: "log-directory-missing",
        severity: "low",
        message: "log directory does not exist; service logs were not checked for permissions or leaked credentials",
        path,
        remediation: "pass --log-dir with the directory your process manager writes Agent Tag logs to",
      }];
    }
    return [];
  }
  const sensitive = role !== "log" && role !== "log-directory";
  if (state.kind === "unreadable") {
    return [{
      id: `${role}-unreadable`,
      severity: sensitive ? "high" : "low",
      message: `${role} cannot be inspected by the auditing user (${state.code}); its owner and mode were not checked`,
      path,
      remediation: "run the audit as the Agent Tag service user (for example with sudo -u)",
    }];
  }
  const findings: SecurityFinding[] = [];
  if (state.link !== undefined) {
    findings.push(
      state.link.replaceableByOthers
        ? {
            id: `${role}-symlink`,
            severity: sensitive ? "high" : "medium",
            message: `${role} is a symbolic link to ${state.link.target} in a directory other users can write; they can repoint it`,
            path,
            remediation: `point the config at ${state.link.target}, or make the link's directory writable only by the service user`,
          }
        : {
            id: `${role}-symlink`,
            severity: "info",
            message: `${role} is a symbolic link to ${state.link.target}; checks apply to the target`,
            path,
          },
    );
  }
  if (state.kind !== (directory ? "directory" : "file")) {
    findings.push({
      id: `${role}-type`,
      severity: sensitive ? "high" : "low",
      message: `${role} is not a regular ${directory ? "directory" : "file"}`,
      path,
    });
  }
  if (ownerUid !== undefined && state.uid !== ownerUid) {
    findings.push({
      id: `${role}-owner`,
      severity: sensitive ? "high" : "medium",
      message: `${role} is owned by uid ${state.uid}, not the Agent Tag user (uid ${ownerUid})`,
      path,
      remediation: `chown the path to the service user`,
    });
  }
  const mode = state.mode & 0o777;
  const remediation = `chmod ${expected.slice(1)} ${state.link?.target ?? path}`;
  if (PRIVATE_ROLES.has(role)) {
    if ((mode & 0o077) !== 0) {
      const shielded = role === "database" && options.parentPrivate === true;
      findings.push({
        id: `${role}-mode`,
        severity: shielded ? "low" : "high",
        message: `${role} has mode ${formatMode(mode)}; expected ${expected} or stricter${shielded ? " (the private data directory still blocks other users)" : ""}`,
        path,
        remediation,
      });
    }
  } else if (role === "config") {
    if ((mode & 0o022) !== 0) {
      findings.push({
        id: "config-writable",
        severity: "high",
        message: `config has mode ${formatMode(mode)}; other users can change the allowlist`,
        path,
        remediation,
      });
    } else if ((mode & 0o004) !== 0) {
      findings.push({
        id: "config-world-readable",
        severity: "medium",
        message: `config has mode ${formatMode(mode)}; any local user can read routes and secret file locations`,
        path,
        remediation,
      });
    } else if ((mode & 0o040) !== 0) {
      findings.push({
        id: "config-group-readable",
        severity: "low",
        message: `config has mode ${formatMode(mode)}; group members can read it`,
        path,
        remediation,
      });
    }
  } else if (role === "log") {
    if ((mode & 0o006) !== 0) {
      findings.push({
        id: "log-world-accessible",
        severity: "medium",
        message: `log has mode ${formatMode(mode)}; any local user can read or modify service logs`,
        path,
        remediation,
      });
    } else if ((mode & 0o060) !== 0) {
      findings.push({
        id: "log-group-accessible",
        severity: "low",
        message: `log has mode ${formatMode(mode)}; group members can read service logs`,
        path,
        remediation,
      });
    }
  } else if ((mode & 0o007) !== 0) {
    findings.push({
      id: "log-directory-world-accessible",
      severity: "low",
      message: `log directory has mode ${formatMode(mode)}; expected 0700`,
      path,
      remediation,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Config contents

/** Finds credentials embedded in the config text or in `*token` fields. Never echoes values. */
export function checkInlineCredentials(rawConfigText: string, rawConfig: unknown): SecurityFinding[] {
  const findings: SecurityFinding[] = knownSecretClasses(rawConfigText).map((secretClass) => ({
    id: "config-inline-credential",
    severity: "high",
    message: `config contains a ${secretClass} credential`,
    remediation: "move the credential into a mode-0600 secret file and reference it with a *File field",
  }));
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (/(token|secret|password)$/i.test(key) && typeof child === "string" && child.length > 0) {
        findings.push({
          id: "config-inline-token-field",
          severity: "high",
          message: `config field ${childPath} holds an inline credential value`,
          remediation: "store the value in a mode-0600 secret file and reference it with a *File field",
        });
      }
      visit(child, childPath);
    }
  };
  visit(rawConfig, "");
  return findings;
}

const WILDCARDS = new Set(["*", "all", "everyone", "any"]);

export function checkAccess(input: {
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly allowedChannelIds: ReadonlyArray<string>;
  readonly adminUserIds?: ReadonlyArray<string> | undefined;
}): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const [label, ids] of [
    ["users", input.allowedUserIds],
    ["channels", input.allowedChannelIds],
  ] as const) {
    if (ids.some((id) => WILDCARDS.has(id.trim().toLowerCase()) || id.includes("*"))) {
      findings.push({
        id: `access-${label}-wildcard`,
        severity: "high",
        message: `access.allowed${label === "users" ? "User" : "Channel"}Ids contains a wildcard; anyone can drive code execution`,
        remediation: "list explicit Slack IDs",
      });
    } else if (ids.length === 0) {
      findings.push({
        id: `access-${label}-empty`,
        severity: "medium",
        message: `access.allowed${label === "users" ? "User" : "Channel"}Ids is empty`,
      });
    }
  }
  findings.push({
    id: "access-summary",
    severity: "info",
    message: `${input.allowedUserIds.length} Slack user(s) in ${input.allowedChannelIds.length} conversation(s) can make the agent run code in the configured repositories`,
  });
  if (input.adminUserIds === undefined || input.adminUserIds.length === 0) {
    findings.push({
      id: "access-no-admins",
      severity: "info",
      message: "no admin users are configured; every allowed user has equal authority over every routed profile",
    });
  } else {
    findings.push({
      id: "access-admins",
      severity: "info",
      message: `${input.adminUserIds.length} admin user(s) configured`,
    });
    const allowed = new Set(input.allowedUserIds);
    if (input.adminUserIds.some((id) => !allowed.has(id))) {
      findings.push({
        id: "access-admin-not-allowed",
        severity: "low",
        message: "an admin user is not in access.allowedUserIds",
      });
    }
  }
  return findings;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function checkT3Transport(baseUrl: string): SecurityFinding[] {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [{ id: "t3-url-invalid", severity: "high", message: "t3.baseUrl is not a valid URL" }];
  }
  if (isLoopbackHost(url.hostname)) return [];
  if (url.protocol !== "https:") {
    return [{
      id: "t3-url-plaintext-remote",
      severity: "high",
      message: `t3.baseUrl points at non-loopback host ${url.hostname} without TLS; the T3 token crosses the network in cleartext`,
      remediation: "run T3 on the same host and use a loopback URL",
    }];
  }
  return [{
    id: "t3-url-remote",
    severity: "medium",
    message: `t3.baseUrl points at non-loopback host ${url.hostname}; the T3 token leaves this machine`,
    remediation: "prefer a loopback T3 on the same host",
  }];
}

export interface T3SessionFacts {
  readonly scopes: ReadonlyArray<string>;
  readonly sessionMethod: string;
  readonly expiresAt: string;
}

const T3_TOKEN_AGE_WARNING_DAYS = 30;

export function checkT3Session(input: {
  readonly now: string;
  readonly session?: T3SessionFacts | undefined;
  readonly unavailableReason?: string | undefined;
  /** HTTP status when T3 answered and refused the token (401 or 403). */
  readonly rejectedStatus?: number | undefined;
  readonly tokenModifiedAt?: string | undefined;
}): SecurityFinding[] {
  const nowMs = Date.parse(input.now);
  const findings: SecurityFinding[] = [];
  const session = input.session;
  if (input.rejectedStatus !== undefined) {
    return [{
      id: "t3-token-rejected",
      severity: "high",
      message: `T3 rejected the service token (HTTP ${input.rejectedStatus}); it is expired, revoked, or not a T3 token`,
      remediation: "re-enroll with bun run enroll:t3",
    }];
  }
  if (session === undefined) {
    findings.push({
      id: "t3-session-unchecked",
      severity: "info",
      message: `T3 token scope and expiry were not checked: ${input.unavailableReason ?? "skipped"}`,
    });
    if (input.tokenModifiedAt !== undefined) {
      const ageDays = Math.floor((nowMs - Date.parse(input.tokenModifiedAt)) / 86_400_000);
      if (ageDays > T3_TOKEN_AGE_WARNING_DAYS) {
        findings.push({
          id: "t3-token-old",
          severity: "medium",
          message: `T3 token file was last written ${ageDays} days ago; restricted T3 tokens are time-limited`,
          remediation: "run doctor against a live T3, or re-enroll with bun run enroll:t3",
        });
      }
    }
    return findings;
  }
  const remainingMs = Date.parse(session.expiresAt) - nowMs;
  const remainingDays = Math.floor(remainingMs / 86_400_000);
  if (remainingMs <= 0) {
    findings.push({ id: "t3-token-expired", severity: "high", message: "T3 service token has expired" });
  } else if (remainingDays < 3) {
    findings.push({
      id: "t3-token-expiring",
      severity: "high",
      message: `T3 service token expires in under 3 days (${session.expiresAt})`,
      remediation: "re-enroll with bun run enroll:t3",
    });
  } else if (remainingDays < 7) {
    findings.push({
      id: "t3-token-expiring",
      severity: "medium",
      message: `T3 service token expires in ${remainingDays} days (${session.expiresAt})`,
      remediation: "re-enroll with bun run enroll:t3",
    });
  } else {
    findings.push({
      id: "t3-token-expiry",
      severity: "info",
      message: `T3 service token expires in ${remainingDays} days (${session.expiresAt})`,
    });
  }
  const required = new Set<string>(REQUIRED_T3_SCOPES);
  const extra = session.scopes.filter((scope) => !required.has(scope));
  const missing = REQUIRED_T3_SCOPES.filter((scope) => !session.scopes.includes(scope));
  if (extra.length > 0) {
    findings.push({
      id: "t3-token-overscoped",
      severity: "high",
      message: `T3 service token carries extra scopes (${extra.join(", ")}); an admin-capable token must never be the service token`,
      remediation: "mint a restricted token with bun run enroll:t3 and keep the admin token offline",
    });
  }
  if (missing.length > 0) {
    findings.push({
      id: "t3-token-underscoped",
      severity: "medium",
      message: `T3 service token lacks required scopes (${missing.join(", ")})`,
    });
  }
  if (session.sessionMethod !== "bearer-access-token") {
    findings.push({
      id: "t3-token-method",
      severity: "medium",
      message: `T3 service credential uses ${session.sessionMethod}, not a bearer access token`,
    });
  }
  return findings;
}

function isWithin(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * `realRoot`, `realHome`, and `realPath` are the symlink-free forms of each path. When present they
 * decide containment, so a root that links to the home directory (or sits under a linked parent such
 * as macOS /tmp) is still caught. Findings report the configured paths.
 */
export function checkRepositoryRoots(input: {
  readonly roots: ReadonlyArray<{ readonly profileId: string; readonly root: string; readonly realRoot?: string }>;
  readonly home: string;
  readonly realHome?: string;
  readonly protectedPaths: ReadonlyArray<{
    readonly label: string;
    readonly path: string;
    readonly realPath?: string;
    readonly severity: SecuritySeverity;
  }>;
}): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const home = input.realHome ?? input.home;
  for (const { profileId, root, realRoot } of input.roots) {
    const normalized = resolve(realRoot ?? root);
    if (normalized === "/") {
      findings.push({
        id: "repo-root-filesystem",
        severity: "high",
        message: `profile ${profileId} allows the filesystem root as a repository`,
        path: root,
        remediation: "list individual repository checkouts",
      });
    } else if (isWithin(home, normalized)) {
      findings.push({
        id: "repo-root-home",
        severity: "high",
        message: `profile ${profileId} repository root contains the home directory (SSH keys, cloud credentials, Agent Tag secrets)`,
        path: root,
        remediation: "list individual repository checkouts",
      });
    }
    for (const target of input.protectedPaths) {
      if (isWithin(target.realPath ?? target.path, normalized)) {
        findings.push({
          id: "repo-root-contains-private-path",
          severity: target.severity,
          message: `profile ${profileId} repository root contains the ${target.label}`,
          path: target.path,
          remediation: `move the ${target.label} outside every repository root`,
        });
      }
    }
  }
  return findings;
}

export interface ProfileSecurityFacts {
  readonly id: string;
  readonly runtimeMode: string;
  readonly isolationMode: string;
  readonly externalWritesMode: string;
  readonly ambientEnabled: boolean;
}

export function checkProfiles(profiles: ReadonlyArray<ProfileSecurityFacts>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const profile of profiles) {
    if (profile.runtimeMode === "full-access" || profile.runtimeMode === "auto") {
      findings.push({
        id: "profile-approval-bypass",
        severity: "high",
        message: `profile ${profile.id} runs with ${profile.runtimeMode}; commands and edits run without approval`,
        remediation: "use runtimeMode approval-required",
      });
    } else if (profile.runtimeMode === "auto-accept-edits") {
      findings.push({
        id: "profile-auto-accept-edits",
        severity: "medium",
        message: `profile ${profile.id} applies file edits without approval`,
        remediation: "use runtimeMode approval-required unless every allowed user is trusted to change the repository",
      });
    }
    if (profile.isolationMode === "trusted-same-user") {
      findings.push({
        id: "profile-tier1-same-user",
        severity: "info",
        message: `profile ${profile.id} runs agents as the service user; agents can read anything that user can, including Agent Tag secrets`,
      });
    } else {
      findings.push({
        id: "profile-isolation-unenforced",
        severity: "medium",
        message: `profile ${profile.id} declares isolation ${profile.isolationMode}, which Agent Tag does not enforce; agents run as the T3 server user`,
        remediation: "run T3 itself under the dedicated account or container (see SECURITY.md tier 2)",
      });
    }
    findings.push({
      id: "profile-external-writes-advisory",
      severity: "low",
      message: `profile ${profile.id} externalWrites=${profile.externalWritesMode} is recorded but not enforced where tools execute`,
    });
    if (profile.ambientEnabled) {
      findings.push({
        id: "profile-ambient-enabled",
        severity: "info",
        message: `profile ${profile.id} answers unmentioned keyword messages in its channels`,
      });
    }
  }
  return findings;
}

export function checkRetention(policy: RetentionPolicy): SecurityFinding[] {
  const unset = (
    [
      ["auditDays", policy.auditDays],
      ["outboxDays", policy.outboxDays],
      ["messageDays", policy.messageDays],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (unset.length === 3) {
    return [{
      id: "retention-disabled",
      severity: "low",
      message: "no retention is configured; Slack text, outbox payloads, and audit rows are kept forever",
      remediation: "set retention.messageDays, retention.outboxDays, and retention.auditDays",
    }];
  }
  if (unset.length > 0) {
    return [{
      id: "retention-partial",
      severity: "info",
      message: `retention is not configured for ${unset.join(", ")}`,
    }];
  }
  return [];
}

const STORE_SECRET_REMEDIATION =
  "rotate the credential first. agent-tag prune only redacts rows older than the retention window and never touches interactions, schedules, or memory, so overwrite the remaining rows, then purge freed pages with VACUUM or backup and restore (docs/operations.md#purging-content-from-the-store)";

/** `databasePaths` are the SQLite store files (main, -wal, -shm), which need a different cleanup than logs. */
export function checkSecretScan(
  result: SecretScanResult,
  options: { readonly databasePaths?: ReadonlyArray<string> } = {},
): SecurityFinding[] {
  const databasePaths = new Set((options.databasePaths ?? []).map((path) => resolve(path)));
  const findings: SecurityFinding[] = result.findings.map((finding) => ({
    id: "secret-at-rest",
    severity: "high",
    message:
      finding.kind === "exact-secret"
        ? `file contains the configured ${finding.canaryName} credential`
        : `file contains a ${finding.patternName} credential`,
    path: finding.path,
    remediation: databasePaths.has(resolve(finding.path))
      ? STORE_SECRET_REMEDIATION
      : "rotate the credential, then delete or rewrite the file",
  }));
  if (result.symlinksSkipped > 0) {
    findings.push({
      id: "secret-scan-incomplete",
      severity: "low",
      message: `secret scan skipped ${result.symlinksSkipped} symbolic link(s)`,
    });
  }
  // An entry the scan could not read may hold a credential, so the audit cannot pass with one.
  const listed = result.skippedEntries.slice(0, MAX_LISTED_UNSCANNED_ENTRIES);
  for (const entry of listed) {
    findings.push({
      id: "secret-scan-unreadable",
      severity: "high",
      message: `secret scan could not check this path (${entry.reason}), so a credential in it would go unreported`,
      path: entry.path,
      remediation: UNSCANNED_REMEDIATION,
    });
  }
  const unlisted = result.skippedEntries.length - listed.length;
  if (unlisted > 0) {
    findings.push({
      id: "secret-scan-unreadable",
      severity: "high",
      message: `secret scan could not check ${unlisted} more path(s) beyond those listed`,
      remediation: UNSCANNED_REMEDIATION,
    });
  }
  return findings;
}

const MAX_LISTED_UNSCANNED_ENTRIES = 20;
const UNSCANNED_REMEDIATION =
  "run the audit as the service user and make the path readable by it; if logs were rotating, re-run the audit";
