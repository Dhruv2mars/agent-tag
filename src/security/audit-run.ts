import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../config.ts";
import { inspectT3Session } from "../t3/auth.ts";
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
  type PathRole,
  type PathState,
  type SecurityFinding,
  type SecurityReport,
  type T3SessionFacts,
} from "./audit.ts";
import { readSecretFile } from "./secret-file.ts";
import { scanForSecrets, type SecretCanary } from "./secret-scan.ts";

/** LaunchAgent log locations written by scripts/manage-launchd.ts. */
export function defaultLogPaths(home: string): { readonly directory: string; readonly files: readonly string[] } {
  const directory = join(home, "Library", "Logs", "AgentTag");
  return { directory, files: [join(directory, "service.stdout.log"), join(directory, "service.stderr.log")] };
}

async function pathState(path: string): Promise<PathState & { readonly mtime?: Date }> {
  try {
    const metadata = await lstat(path);
    const kind = metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other";
    return { kind, mode: metadata.mode, uid: metadata.uid, mtime: metadata.mtime };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function fact(path: string, role: PathRole): Promise<PathFact> {
  return { path, role, state: await pathState(path) };
}

const adminExtension = z
  .object({ access: z.object({ adminUserIds: z.array(z.string()).optional() }).loose() })
  .loose();

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
  readonly logDirectory?: string;
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
  const logs = defaultLogPaths(home);
  const logDirectory = options.logDirectory ?? logs.directory;
  const logFiles = options.logFiles ?? logs.files;
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
      message: `config fails validation at ${paths.join(", ")}`,
      path: options.configPath,
    });
    return finish();
  }
  const config = parsed.data;
  const databasePath = join(config.dataDir, "agent-tag.sqlite");
  const secretFiles = [
    { name: "t3-service-token", path: config.t3.tokenFile },
    { name: "slack-app-token", path: config.slack.appTokenFile },
    { name: "slack-bot-token", path: config.slack.botTokenFile },
  ];

  const facts = await Promise.all([
    ...secretFiles.map(({ path }) => fact(path, "secret-file")),
    ...[...new Set(secretFiles.map(({ path }) => dirname(path)))].map((path) => fact(path, "secret-directory")),
    fact(config.dataDir, "data-directory"),
    ...["", "-wal", "-shm"].map((suffix) => fact(`${databasePath}${suffix}`, "database")),
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

  const extension = adminExtension.safeParse(raw);
  findings.push(
    ...checkAccess({
      allowedUserIds: config.access.allowedUserIds,
      allowedChannelIds: config.access.allowedChannelIds,
      adminUserIds: extension.success ? extension.data.access.adminUserIds : undefined,
    }),
  );
  findings.push(...checkT3Transport(config.t3.baseUrl));

  const tokenState = await pathState(config.t3.tokenFile);
  const tokenModifiedAt = "mtime" in tokenState && tokenState.mtime !== undefined
    ? tokenState.mtime.toISOString()
    : undefined;
  if (options.offline === true) {
    findings.push(...checkT3Session({ now: now.toISOString(), unavailableReason: "offline mode", tokenModifiedAt }));
  } else {
    try {
      const session = await (options.inspectSession ?? defaultInspectSession)({
        baseUrl: config.t3.baseUrl,
        tokenFile: config.t3.tokenFile,
      });
      findings.push(...checkT3Session({ now: now.toISOString(), session }));
    } catch (error) {
      findings.push(
        ...checkT3Session({ now: now.toISOString(), unavailableReason: errorReason(error), tokenModifiedAt }),
      );
    }
  }

  findings.push(
    ...checkRepositoryRoots({
      roots: config.profiles.flatMap((profile) =>
        profile.repositoryRoots.map((root) => ({ profileId: profile.id, root })),
      ),
      home,
      protectedPaths: [
        { label: "data directory", path: config.dataDir, severity: "high" },
        ...secretFiles.map(({ name, path }) => ({ label: `${name} file`, path, severity: "high" as const })),
        { label: "config file", path: options.configPath, severity: "medium" },
      ],
    }),
  );
  findings.push(
    ...checkProfiles(
      config.profiles.map((profile) => ({
        id: profile.id,
        runtimeMode: profile.runtimeMode,
        isolationMode: profile.isolation.mode,
        externalWritesMode: profile.externalWrites.mode,
        ambientEnabled: profile.ambient.enabled,
      })),
    ),
  );
  findings.push(...checkRetention(config.retention));

  const scanRoots = facts
    .filter((item) => (item.role === "data-directory" || item.role === "log-directory") && item.state.kind === "directory")
    .map((item) => item.path);
  if (scanRoots.length > 0) {
    const canaries: SecretCanary[] = [];
    for (const secretFile of secretFiles) {
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
      findings.push(...checkSecretScan(await scanForSecrets({ roots: scanRoots, canaries, excludedPaths })));
    } catch (error) {
      findings.push({
        id: "secret-scan-failed",
        severity: "medium",
        message: `secret scan of the data and log directories failed: ${errorReason(error)}`,
      });
    }
  }
  return finish();
}
