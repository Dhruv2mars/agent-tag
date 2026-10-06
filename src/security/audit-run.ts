import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../config.ts";
import type { RetentionPolicy } from "../store/retention.ts";
import { inspectT3Session, isT3CredentialRejection } from "../t3/auth.ts";
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
  summarizeFindings,
  type PathFact,
  type PathLink,
  type PathParent,
  type PathRole,
  type PathState,
  type ProfileSecurityFacts,
  type SecurityFinding,
  type SecurityReport,
  type T3SessionFacts,
} from "./audit.ts";
import { readSecretFile } from "./secret-file.ts";
import { scanForSecrets, type SecretCanary } from "./secret-scan.ts";

/** Where scripts/manage-launchd.ts points the macOS LaunchAgent logs. Other hosts pass `--log-dir`. */
export function defaultLogDirectory(home: string): string {
  return join(home, "Library", "Logs", "AgentTag");
}

/** Top-level files in the log directory (including rotated logs). An unreadable directory yields none. */
async function listLogFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;

/** lstat/stat failures that mean "this path cannot be inspected by the auditing user", not "this path is absent". */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "ENOTDIR", "ELOOP"]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Group or world writable without the sticky bit: another user can rename or replace entries. */
function replaceableByOthers(mode: number): boolean {
  return (mode & 0o022) !== 0 && (mode & 0o1000) === 0;
}

/** Mode and owner of the directory holding a path; whoever can write it can replace the path. */
async function parentState(path: string): Promise<PathParent | undefined> {
  try {
    const metadata = await stat(path);
    return { path, mode: metadata.mode, uid: metadata.uid };
  } catch {
    return undefined; // An unreadable parent already makes the path itself unreadable or is reported on its own.
  }
}

/**
 * Describes what the service will actually open. Agent Tag follows symlinks (stat), so mode, owner,
 * and kind come from the target; the link itself is reported separately.
 */
async function pathState(path: string): Promise<PathState & { readonly mtime?: Date }> {
  try {
    const own = await lstat(path);
    const link: PathLink | undefined = own.isSymbolicLink()
      ? {
          target: await realpath(path),
          replaceableByOthers: replaceableByOthers((await stat(dirname(path))).mode),
        }
      : undefined;
    const metadata = link === undefined ? own : await stat(path);
    const kind = metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other";
    const parent = await parentState(dirname(link?.target ?? path));
    return {
      kind,
      mode: metadata.mode,
      uid: metadata.uid,
      mtime: metadata.mtime,
      ...(link === undefined ? {} : { link }),
      ...(parent === undefined ? {} : { parent }),
    };
  } catch (error) {
    const code = errorCode(error);
    // A dangling symlink is as unusable as a missing path.
    if (code === "ENOENT") return { kind: "missing" };
    if (code !== undefined && UNREADABLE_CODES.has(code)) return { kind: "unreadable", code };
    throw error;
  }
}

async function fact(path: string, role: PathRole): Promise<PathFact & { readonly state: { readonly mtime?: Date } }> {
  return { path, role, state: await pathState(path) };
}

/**
 * Resolves every symlink in `path`, including parent components. A missing or unreadable tail is
 * appended to the canonical form of its nearest resolvable ancestor.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

// The audit reads facts from the raw JSON leniently, so a config that fails validation is still
// checked for the problems the schema exists to prevent (remote T3, wildcards, approval bypass).
const optionalString = z.string().optional().catch(undefined);
const optionalAbsolutePath = z.string().refine(isAbsolute).optional().catch(undefined);
const stringList = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.filter((item): item is string => typeof item === "string"));
const optionalDays = z.number().int().positive().optional().catch(undefined);

const auditInputSchema = z.object({
  dataDir: optionalAbsolutePath,
  t3: z.object({ baseUrl: optionalString, tokenFile: optionalAbsolutePath }).catch({}),
  slack: z.object({ appTokenFile: optionalAbsolutePath, botTokenFile: optionalAbsolutePath }).catch({}),
  access: z
    .object({
      allowedUserIds: stringList,
      allowedChannelIds: stringList,
      adminUserIds: z.array(z.string()).optional().catch(undefined),
    })
    .catch({ allowedUserIds: [], allowedChannelIds: [] }),
  profiles: z.array(z.unknown()).catch([]),
  retention: z.object({ auditDays: optionalDays, outboxDays: optionalDays, messageDays: optionalDays }).catch({}),
});

const profileRootsSchema = z.object({
  id: z.string().catch("(unnamed)"),
  repositoryRoots: stringList.transform((roots) => roots.filter((root) => isAbsolute(root))),
});

const profileFactsSchema = z
  .object({
    id: z.string(),
    runtimeMode: z.string(),
    isolation: z.object({ mode: z.string() }),
    externalWrites: z.object({ mode: z.string() }),
    ambient: z.object({ enabled: z.boolean() }).catch({ enabled: false }),
  })
  .transform(
    (profile): ProfileSecurityFacts => ({
      id: profile.id,
      runtimeMode: profile.runtimeMode,
      isolationMode: profile.isolation.mode,
      externalWritesMode: profile.externalWrites.mode,
      ambientEnabled: profile.ambient.enabled,
    }),
  );

interface AuditInputs {
  readonly dataDir: string | undefined;
  readonly t3BaseUrl: string | undefined;
  readonly secretFiles: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly access: { readonly allowedUserIds: string[]; readonly allowedChannelIds: string[]; readonly adminUserIds?: string[] | undefined };
  readonly roots: ReadonlyArray<{ readonly profileId: string; readonly root: string }>;
  readonly profiles: ReadonlyArray<ProfileSecurityFacts>;
  readonly retention: RetentionPolicy;
}

export function readAuditInputs(raw: unknown): AuditInputs {
  const input = auditInputSchema.parse(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {});
  const secretFiles = [
    { name: "t3-service-token", path: input.t3.tokenFile },
    { name: "slack-app-token", path: input.slack.appTokenFile },
    { name: "slack-bot-token", path: input.slack.botTokenFile },
  ].flatMap(({ name, path }) => (path === undefined ? [] : [{ name, path }]));
  return {
    dataDir: input.dataDir,
    t3BaseUrl: input.t3.baseUrl,
    secretFiles,
    access: input.access,
    roots: input.profiles.flatMap((profile) => {
      const parsed = profileRootsSchema.safeParse(profile);
      return parsed.success ? parsed.data.repositoryRoots.map((root) => ({ profileId: parsed.data.id, root })) : [];
    }),
    profiles: input.profiles.flatMap((profile) => {
      const parsed = profileFactsSchema.safeParse(profile);
      return parsed.success ? [parsed.data] : [];
    }),
    retention: input.retention,
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export interface SecurityAuditOptions {
  readonly configPath: string;
  readonly now?: Date;
  readonly home?: string;
  readonly ownerUid?: number | undefined;
  /** Skip the T3 session request (scope and expiry). */
  readonly offline?: boolean;
  /** Directory holding the service logs; defaults to the macOS LaunchAgent location. */
  readonly logDirectory?: string;
  /** Log files to check; defaults to every top-level file in `logDirectory`. */
  readonly logFiles?: readonly string[];
  readonly inspectSession?: (input: { readonly baseUrl: string; readonly tokenFile: string }) => Promise<T3SessionFacts>;
}

async function defaultInspectSession(input: {
  readonly baseUrl: string;
  readonly tokenFile: string;
}): Promise<T3SessionFacts> {
  const token = await readSecretFile(input.tokenFile);
  return inspectT3Session({ baseUrl: input.baseUrl, token, signal: AbortSignal.timeout(5_000) });
}

export async function runSecurityAudit(options: SecurityAuditOptions): Promise<SecurityReport> {
  const now = options.now ?? new Date();
  const home = options.home ?? homedir();
  const ownerUid = "ownerUid" in options ? options.ownerUid : process.getuid?.();
  const logDirectory = options.logDirectory ?? defaultLogDirectory(home);
  const logFiles = options.logFiles ?? (await listLogFiles(logDirectory));
  const findings: SecurityFinding[] = [];
  const finish = (): SecurityReport => summarizeFindings(findings, now.toISOString());

  findings.push(...checkPathPermissions(await fact(options.configPath, "config"), ownerUid));
  let rawText: string;
  let raw: unknown;
  try {
    rawText = await Bun.file(options.configPath).text();
    raw = JSON.parse(rawText);
  } catch {
    findings.push({
      id: "config-unreadable",
      severity: "high",
      message: "config cannot be read as JSON",
      path: options.configPath,
    });
    return finish();
  }
  findings.push(...checkInlineCredentials(rawText, raw));
  const parsed = agentTagConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))];
    findings.push({
      id: "config-invalid",
      severity: "high",
      message: `config fails validation at ${paths.join(", ")}; the service will not start, and the checks below use the fields that could be read`,
      path: options.configPath,
    });
  }
  const inputs = readAuditInputs(raw);
  const databasePath = inputs.dataDir === undefined ? undefined : join(inputs.dataDir, "agent-tag.sqlite");

  const facts = await Promise.all([
    ...inputs.secretFiles.map(({ path }) => fact(path, "secret-file")),
    ...[...new Set(inputs.secretFiles.map(({ path }) => dirname(path)))].map((path) => fact(path, "secret-directory")),
    ...(inputs.dataDir === undefined ? [] : [fact(inputs.dataDir, "data-directory")]),
    ...(databasePath === undefined ? [] : DATABASE_SUFFIXES.map((suffix) => fact(`${databasePath}${suffix}`, "database"))),
    fact(logDirectory, "log-directory"),
    ...logFiles.map((path) => fact(path, "log")),
  ]);
  const dataDirectory = facts.find((item) => item.role === "data-directory")?.state;
  const parentPrivate =
    dataDirectory !== undefined &&
    dataDirectory.kind === "directory" &&
    (dataDirectory.mode & 0o077) === 0 &&
    (ownerUid === undefined || dataDirectory.uid === ownerUid);
  for (const item of facts) findings.push(...checkPathPermissions(item, ownerUid, { parentPrivate }));

  findings.push(...checkAccess(inputs.access));
  if (inputs.t3BaseUrl !== undefined) findings.push(...checkT3Transport(inputs.t3BaseUrl));

  const tokenFile = inputs.secretFiles.find((item) => item.name === "t3-service-token")?.path;
  const tokenState = facts.find((item) => item.role === "secret-file" && item.path === tokenFile)?.state;
  const tokenModifiedAt = tokenState?.mtime?.toISOString();
  if (options.offline === true) {
    findings.push(...checkT3Session({ now: now.toISOString(), unavailableReason: "offline mode", tokenModifiedAt }));
  } else if (!parsed.success) {
    // Only a validated config guarantees a loopback T3 URL; never send the token anywhere else.
    findings.push(
      ...checkT3Session({ now: now.toISOString(), unavailableReason: "the config is invalid", tokenModifiedAt }),
    );
  } else {
    try {
      const session = await (options.inspectSession ?? defaultInspectSession)({
        baseUrl: parsed.data.t3.baseUrl,
        tokenFile: parsed.data.t3.tokenFile,
      });
      findings.push(...checkT3Session({ now: now.toISOString(), session }));
    } catch (error) {
      findings.push(
        ...checkT3Session(
          isT3CredentialRejection(error)
            ? { now: now.toISOString(), rejectedStatus: error.status }
            : { now: now.toISOString(), unavailableReason: errorReason(error), tokenModifiedAt },
        ),
      );
    }
  }

  // Containment is decided on canonical paths so a symlinked root, home, or parent directory cannot hide it.
  const protectedPaths = [
    ...(inputs.dataDir === undefined ? [] : [{ label: "data directory", path: inputs.dataDir, severity: "high" as const }]),
    ...inputs.secretFiles.map(({ name, path }) => ({ label: `${name} file`, path, severity: "high" as const })),
    { label: "config file", path: options.configPath, severity: "medium" as const },
  ];
  findings.push(
    ...checkRepositoryRoots({
      roots: await Promise.all(inputs.roots.map(async (entry) => ({ ...entry, realRoot: await canonicalPath(entry.root) }))),
      home,
      realHome: await canonicalPath(home),
      protectedPaths: await Promise.all(
        protectedPaths.map(async (entry) => ({ ...entry, realPath: await canonicalPath(entry.path) })),
      ),
    }),
  );
  findings.push(...checkProfiles(inputs.profiles));
  findings.push(...checkRetention(inputs.retention));

  const scanRoots = facts
    .filter((item) => (item.role === "data-directory" || item.role === "log-directory") && item.state.kind === "directory")
    .map((item) => item.path);
  if (scanRoots.length > 0) {
    const canaries: SecretCanary[] = [];
    for (const secretFile of inputs.secretFiles) {
      try {
        canaries.push({ name: secretFile.name, secret: await readSecretFile(secretFile.path) });
      } catch {
        // Permission and existence problems are already reported above; scan for known patterns only.
      }
    }
    const excludedPaths = facts
      .filter((item) => item.role === "secret-file" && item.state.kind === "file")
      .map((item) => item.path);
    try {
      // The scanner reports resolved paths, so match the store files under the resolved data directory.
      const realDataDir = inputs.dataDir === undefined ? undefined : await canonicalPath(inputs.dataDir);
      const databasePaths =
        realDataDir === undefined ? [] : DATABASE_SUFFIXES.map((suffix) => join(realDataDir, `agent-tag.sqlite${suffix}`));
      findings.push(
        ...checkSecretScan(await scanForSecrets({ roots: scanRoots, canaries, excludedPaths }), { databasePaths }),
      );
    } catch (error) {
      // Per-entry failures are reported by the scan itself; this is a scan that could not run at all.
      findings.push({
        id: "secret-scan-failed",
        severity: "high",
        message: `secret scan of the data and log directories failed, so leaked credentials would go unreported: ${errorReason(error)}`,
      });
    }
  }
  return finish();
}
