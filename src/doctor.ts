import type { Stats } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { type AgentTagConfig, agentTagConfigSchema } from "./config.ts";
import { validateConfiguredProviders } from "./policy/provider.ts";
import { SecretString } from "./security/secret-file.ts";
import type { ServiceManager } from "./service-manager.ts";
import { AgentTagStore } from "./store/store.ts";
import { assertRestrictedOrchestrationSession, inspectT3Session, type T3Session } from "./t3/auth.ts";
import { inspectT3, type T3ServerInfo } from "./t3/gateway.ts";
import { parseT3Pin, type T3Pin } from "./t3/pin.ts";

export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  /** How to resolve a warn/fail manually. */
  readonly hint?: string;
  /** Set when `--fix` changed something for this check. */
  readonly fixed?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly configPath: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorDependencies {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly bunVersion: string;
  readonly uid: number | undefined;
  readonly now: () => Date;
  readonly pin: T3Pin;
  readonly bunRequirement: { readonly minimum: string; readonly pinned: string | undefined };
  readonly inspectSession: (input: { readonly baseUrl: string; readonly token: SecretString }) => Promise<T3Session>;
  readonly inspectT3: (config: AgentTagConfig["t3"]) => Promise<T3ServerInfo>;
  readonly storeDiagnostics: (config: AgentTagConfig) => Promise<Readonly<Record<string, number>>>;
  readonly service: ServiceManager | undefined;
}

export const T3_ORCHESTRATION_PROTOCOL_VERSION = 1;
const TOKEN_EXPIRY_WARNING_DAYS = 7;
const NETWORK_TIMEOUT_MS = 5_000;

const environmentSchema = z.object({
  serverVersion: z.string().min(1).optional(),
  orchestrationProtocolVersion: z.number().int().positive().optional(),
});

const slackAuthSchema = z.union([
  z.object({ ok: z.literal(true), team_id: z.string().min(1), user_id: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

const slackConnectionSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

/** Compares dotted numeric versions, ignoring any prerelease suffix. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function statOptional(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

function modeText(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

async function fetchWithTimeout(
  dependencies: Pick<DoctorDependencies, "fetch">,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return dependencies.fetch(url, { ...init, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
}

// ---------------------------------------------------------------------------------------------
// Individual checks. Each returns the check plus any value later checks depend on.

export async function checkConfig(
  configPath: string,
): Promise<{ readonly check: DoctorCheck; readonly config?: AgentTagConfig }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return {
      check: {
        id: "config",
        status: "fail",
        summary: errno(error) === "ENOENT" ? `config not found at ${configPath}` : `config is not valid JSON: ${errorMessage(error)}`,
        hint: "run `agent-tag onboard` to create one",
      },
    };
  }
  const parsed = agentTagConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      check: { id: "config", status: "fail", summary: `config is invalid: ${formatIssues(parsed.error)}` },
    };
  }
  const config = parsed.data;
  return {
    config,
    check: {
      id: "config",
      status: "pass",
      summary: `config is valid (${config.profiles.length} profile(s), ${config.routes.length} route(s))`,
    },
  };
}

export async function checkDataDirectory(
  config: AgentTagConfig,
  dependencies: Pick<DoctorDependencies, "uid">,
  fix: boolean,
): Promise<DoctorCheck> {
  const id = "data-dir";
  const path = config.dataDir;
  const fixes: string[] = [];
  let metadata = await statOptional(path);
  if (metadata === undefined) {
    if (!fix) return { id, status: "fail", summary: `data directory ${path} does not exist`, hint: "run `agent-tag doctor --fix` to create it with mode 0700" };
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    fixes.push("created with mode 0700");
    metadata = await stat(path);
  }
  if (!metadata.isDirectory()) return { id, status: "fail", summary: `data directory ${path} is not a directory` };
  if (dependencies.uid !== undefined && metadata.uid !== dependencies.uid) {
    return { id, status: "fail", summary: `data directory ${path} is owned by uid ${metadata.uid}, not the Agent Tag user` };
  }
  if ((metadata.mode & 0o077) !== 0) {
    if (!fix) {
      return { id, status: "fail", summary: `data directory ${path} has mode ${modeText(metadata.mode)}; group/world access is not allowed`, hint: "run `agent-tag doctor --fix` to chmod 0700" };
    }
    await chmod(path, 0o700);
    fixes.push(`chmod 0700 (was ${modeText(metadata.mode)})`);
  }
  const probe = join(path, `.agent-tag-doctor-${crypto.randomUUID()}`);
  try {
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    return { id, status: "fail", summary: `data directory ${path} is not writable: ${errno(error) ?? errorMessage(error)}` };
  } finally {
    await rm(probe, { force: true });
  }
  return {
    id,
    status: "pass",
    summary: `data directory ${path} is private and writable`,
    ...(fixes.length === 0 ? {} : { fixed: fixes.join(", ") }),
  };
}

export interface SecretFileSpec {
  readonly id: string;
  readonly path: string;
  readonly prefix?: string;
  readonly missingHint: string;
}

export function secretFileSpecs(config: AgentTagConfig): readonly SecretFileSpec[] {
  return [
    {
      id: "secret:slack-app-token",
      path: config.slack.appTokenFile,
      prefix: "xapp-",
      missingHint: "create a Socket Mode app-level token (connections:write) and rerun `agent-tag onboard`",
    },
    {
      id: "secret:slack-bot-token",
      path: config.slack.botTokenFile,
      prefix: "xoxb-",
      missingHint: "install the Slack app and rerun `agent-tag onboard` with its xoxb- bot token",
    },
    {
      id: "secret:t3-token",
      path: config.t3.tokenFile,
      missingHint: "rerun `agent-tag onboard` or `bun run enroll:t3` to mint a restricted T3 token",
    },
  ];
}

/** Validates one secret file without ever returning its contents. Returns the secret when usable. */
export async function checkSecretFile(
  spec: SecretFileSpec,
  dependencies: Pick<DoctorDependencies, "uid">,
  fix: boolean,
): Promise<{ readonly check: DoctorCheck; readonly secret?: SecretString }> {
  const { id, path } = spec;
  const fixes: string[] = [];
  const fixedField = (): { readonly fixed?: string } => (fixes.length === 0 ? {} : { fixed: fixes.join(", ") });
  const parent = dirname(path);
  let parentMetadata = await statOptional(parent);
  if (parentMetadata === undefined && fix) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    fixes.push(`created ${parent} with mode 0700`);
    parentMetadata = await stat(parent);
  }
  if (parentMetadata !== undefined) {
    if (!parentMetadata.isDirectory()) return { check: { id, status: "fail", summary: `secret parent ${parent} is not a directory` } };
    if (dependencies.uid !== undefined && parentMetadata.uid !== dependencies.uid) {
      return { check: { id, status: "fail", summary: `secret parent ${parent} is owned by another user` } };
    }
    if ((parentMetadata.mode & 0o077) !== 0) {
      if (!fix) {
        return { check: { id, status: "fail", summary: `secret parent ${parent} has mode ${modeText(parentMetadata.mode)}; must be 0700`, hint: "run `agent-tag doctor --fix` to chmod 0700" } };
      }
      await chmod(parent, 0o700);
      fixes.push(`chmod 0700 ${parent}`);
    }
  }
  const metadata = await statOptional(path);
  if (metadata === undefined) {
    return { check: { id, status: "fail", summary: `secret file ${path} is missing`, hint: spec.missingHint, ...fixedField() } };
  }
  if (!metadata.isFile()) return { check: { id, status: "fail", summary: `secret path ${path} is not a regular file` } };
  if (dependencies.uid !== undefined && metadata.uid !== dependencies.uid) {
    return { check: { id, status: "fail", summary: `secret file ${path} is owned by another user` } };
  }
  if ((metadata.mode & 0o077) !== 0) {
    if (!fix) {
      return { check: { id, status: "fail", summary: `secret file ${path} has mode ${modeText(metadata.mode)}; must be 0600`, hint: "run `agent-tag doctor --fix` to chmod 0600" } };
    }
    await chmod(path, 0o600);
    fixes.push(`chmod 0600 ${path}`);
  }
  const text = (await readFile(path, "utf8")).trim();
  if (text.length === 0) {
    return { check: { id, status: "fail", summary: `secret file ${path} is empty`, hint: spec.missingHint, ...fixedField() } };
  }
  if (spec.prefix !== undefined && !text.startsWith(spec.prefix)) {
    return {
      check: { id, status: "fail", summary: `secret file ${path} does not contain a ${spec.prefix}… token`, hint: "check that the app and bot tokens are not swapped", ...fixedField() },
    };
  }
  return {
    check: { id, status: "pass", summary: `${path} is present with mode 0600`, ...fixedField() },
    secret: new SecretString(text),
  };
}

export function checkBunVersion(dependencies: Pick<DoctorDependencies, "bunVersion" | "bunRequirement">): DoctorCheck {
  const { bunVersion, bunRequirement } = dependencies;
  if (compareVersions(bunVersion, bunRequirement.minimum) < 0) {
    return { id: "bun-version", status: "fail", summary: `Bun ${bunVersion} is older than the required ${bunRequirement.minimum}`, hint: "run `bun upgrade`" };
  }
  if (bunRequirement.pinned !== undefined && compareVersions(bunVersion, bunRequirement.pinned) !== 0) {
    return { id: "bun-version", status: "warn", summary: `Bun ${bunVersion} differs from the verified ${bunRequirement.pinned}` };
  }
  return { id: "bun-version", status: "pass", summary: `Bun ${bunVersion}` };
}

/** Shared with `agent-tag onboard`, so the wizard and doctor agree on which T3 servers are usable. */
export async function checkT3Environment(
  config: { readonly t3: Pick<AgentTagConfig["t3"], "baseUrl"> },
  dependencies: Pick<DoctorDependencies, "fetch">,
): Promise<{ readonly check: DoctorCheck; readonly reachable: boolean; readonly serverVersion?: string }> {
  const id = "t3-environment";
  const url = new URL("/.well-known/t3/environment", config.t3.baseUrl);
  let response: Response;
  try {
    response = await fetchWithTimeout(dependencies, url);
  } catch (error) {
    return {
      reachable: false,
      check: { id, status: "fail", summary: `T3 is not reachable at ${config.t3.baseUrl}: ${errorMessage(error)}`, hint: "start the pinned T3 server and check t3.baseUrl" },
    };
  }
  if (response.status === 404) {
    return {
      reachable: true,
      check: { id, status: "warn", summary: `T3 at ${config.t3.baseUrl} does not publish /.well-known/t3/environment; assuming protocol ${T3_ORCHESTRATION_PROTOCOL_VERSION}` },
    };
  }
  if (!response.ok) {
    return { reachable: false, check: { id, status: "fail", summary: `T3 environment endpoint returned HTTP ${response.status}` } };
  }
  const parsed = environmentSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    return { reachable: true, check: { id, status: "fail", summary: "T3 environment response is not recognized" } };
  }
  const protocol = parsed.data.orchestrationProtocolVersion ?? 1;
  const serverVersion = parsed.data.serverVersion;
  const versionText = serverVersion === undefined ? "unknown version" : `T3 ${serverVersion}`;
  if (protocol !== T3_ORCHESTRATION_PROTOCOL_VERSION) {
    return {
      reachable: true,
      ...(serverVersion === undefined ? {} : { serverVersion }),
      check: { id, status: "fail", summary: `${versionText} speaks orchestration protocol ${protocol}; Agent Tag requires ${T3_ORCHESTRATION_PROTOCOL_VERSION}`, hint: "run the T3 version pinned in t3.lock.json" },
    };
  }
  return {
    reachable: true,
    ...(serverVersion === undefined ? {} : { serverVersion }),
    check: { id, status: "pass", summary: `${versionText} reachable, orchestration protocol ${protocol}` },
  };
}

export function checkT3Version(serverVersion: string | undefined, pin: T3Pin): DoctorCheck {
  if (serverVersion === undefined) return { id: "t3-version", status: "skip", summary: "T3 did not report its version" };
  if (serverVersion.replace(/^v/, "") === pin.version) {
    return { id: "t3-version", status: "pass", summary: `T3 ${serverVersion} matches t3.lock.json` };
  }
  return {
    id: "t3-version",
    status: "warn",
    summary: `T3 ${serverVersion} differs from the pinned ${pin.version}; only the pinned release is verified`,
  };
}

export async function checkT3Session(
  config: AgentTagConfig,
  token: SecretString,
  dependencies: Pick<DoctorDependencies, "inspectSession" | "now">,
): Promise<DoctorCheck> {
  const id = "t3-session";
  let session: T3Session;
  try {
    session = await dependencies.inspectSession({ baseUrl: config.t3.baseUrl, token });
    assertRestrictedOrchestrationSession(session);
  } catch (error) {
    return { id, status: "fail", summary: `T3 token rejected: ${errorMessage(error)}`, hint: "mint a new restricted token with `bun run enroll:t3`" };
  }
  const remainingDays = (Date.parse(session.expiresAt) - dependencies.now().getTime()) / 86_400_000;
  if (remainingDays <= 0) {
    return { id, status: "fail", summary: `T3 token expired at ${session.expiresAt}`, hint: "mint a new restricted token with `bun run enroll:t3`" };
  }
  if (remainingDays < TOKEN_EXPIRY_WARNING_DAYS) {
    return { id, status: "warn", summary: `T3 token expires in ${remainingDays.toFixed(1)} days (${session.expiresAt})`, hint: "rotate it with `bun run enroll:t3` before it expires" };
  }
  return { id, status: "pass", summary: `T3 token has exact orchestration scopes; expires ${session.expiresAt}` };
}

export async function checkT3Providers(
  config: AgentTagConfig,
  dependencies: Pick<DoctorDependencies, "inspectT3">,
): Promise<DoctorCheck> {
  try {
    const server = await dependencies.inspectT3(config.t3);
    const selections = validateConfiguredProviders(config, server);
    return {
      id: "t3-providers",
      status: "pass",
      summary: selections.map((selection) => `${selection.profileId}: ${selection.instanceId}/${selection.model}`).join(", "),
    };
  } catch (error) {
    return { id: "t3-providers", status: "fail", summary: errorMessage(error), hint: "authenticate the provider in T3 or change the profile's provider/model" };
  }
}

async function slackCall(
  dependencies: DoctorDependencies,
  method: string,
  token: SecretString,
): Promise<unknown> {
  const response = await fetchWithTimeout(dependencies, `https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.exposeToBoundary()}`, "content-type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}`);
  return response.json();
}

export async function checkSlackBot(
  config: AgentTagConfig,
  token: SecretString,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  const id = "slack-bot-auth";
  try {
    const auth = slackAuthSchema.parse(await slackCall(dependencies, "auth.test", token));
    if (!auth.ok) return { id, status: "fail", summary: `Slack auth.test failed: ${auth.error}`, hint: "reinstall the Slack app and replace the bot token" };
    if (auth.team_id !== config.slack.workspaceId) {
      return { id, status: "fail", summary: `Slack bot belongs to workspace ${auth.team_id}, expected ${config.slack.workspaceId}` };
    }
    return { id, status: "pass", summary: `Slack bot ${auth.user_id} authenticated in ${auth.team_id}` };
  } catch (error) {
    return { id, status: "fail", summary: `Slack auth.test failed: ${errorMessage(error)}` };
  }
}

export async function checkSlackApp(token: SecretString, dependencies: DoctorDependencies): Promise<DoctorCheck> {
  const id = "slack-app-auth";
  try {
    const result = slackConnectionSchema.parse(await slackCall(dependencies, "apps.connections.open", token));
    if (!result.ok) return { id, status: "fail", summary: `Slack Socket Mode token rejected: ${result.error}`, hint: "create an app-level token with connections:write" };
    return { id, status: "pass", summary: "Slack Socket Mode app token accepted" };
  } catch (error) {
    return { id, status: "fail", summary: `Slack apps.connections.open failed: ${errorMessage(error)}` };
  }
}

export async function checkStore(
  config: AgentTagConfig,
  dependencies: Pick<DoctorDependencies, "storeDiagnostics">,
): Promise<DoctorCheck> {
  try {
    const counts = await dependencies.storeDiagnostics(config);
    return { id: "store", status: "pass", summary: `SQLite store migrated (${counts.tasks ?? 0} task(s), ${counts.operations ?? 0} operation(s))` };
  } catch (error) {
    return { id: "store", status: "fail", summary: `SQLite store failed to open: ${errorMessage(error)}` };
  }
}

export async function checkService(
  configPath: string,
  service: ServiceManager | undefined,
  options: { readonly fix: boolean; readonly blocked: boolean },
): Promise<DoctorCheck> {
  const id = "service";
  if (service === undefined) return { id, status: "skip", summary: `no supported service manager on ${process.platform}` };
  try {
    const unit = await service.unitState(configPath);
    if (!unit.installed) {
      return { id, status: "warn", summary: `${service.kind} service is not installed`, hint: `run \`agent-tag service install ${configPath}\`` };
    }
    if (!unit.sameConfig) {
      return { id, status: "warn", summary: `${service.kind} unit ${unit.unitPath} runs a different config` };
    }
    // Only template drift is repaired automatically. Moving the service onto another checkout or Bun
    // must be an explicit `service upgrade` from the intended checkout, never a side effect of `--fix`.
    if (!unit.current && !unit.sameCheckout) {
      return {
        id,
        status: "warn",
        summary: `${service.kind} unit ${unit.unitPath} runs a different Agent Tag checkout (${unit.installedCheckout ?? "unrecognized unit"})`,
        hint: `doctor --fix leaves it alone; to move the service, run \`agent-tag service upgrade ${configPath}\` from the checkout it should run`,
      };
    }
    if (!unit.current && !unit.sameBun) {
      return {
        id,
        status: "warn",
        summary: `${service.kind} unit ${unit.unitPath} runs a different Bun (${unit.installedBunPath ?? "unrecognized unit"})`,
        hint: `doctor --fix leaves it alone; run \`agent-tag service upgrade ${configPath}\` with the Bun the service should use`,
      };
    }
    let fixed: string | undefined;
    if (!unit.current) {
      if (!options.fix || options.blocked) {
        return {
          id,
          status: "warn",
          summary: `${service.kind} unit ${unit.unitPath} differs from the unit template this checkout generates`,
          hint: options.blocked ? "resolve the failed checks, then run `agent-tag doctor --fix`" : "run `agent-tag doctor --fix` or `agent-tag service upgrade`",
        };
      }
      await service.upgrade(configPath);
      fixed = "regenerated the service unit and restarted it";
    }
    let status = await service.status();
    if (!status.running && fixed === undefined) {
      if (!options.fix || options.blocked) {
        return { id, status: "warn", summary: `${service.kind} service is installed but not running`, hint: "run `agent-tag service restart` and check `agent-tag service logs`" };
      }
      await service.restart();
      fixed = "restarted the service";
      status = await service.status();
    }
    const hint = status.hints.join("; ");
    return {
      id,
      status: status.running ? "pass" : "warn",
      summary: `${service.kind} service is installed${status.running ? " and running" : " but not running"}`,
      ...(hint.length === 0 ? {} : { hint }),
      ...(fixed === undefined ? {} : { fixed }),
    };
  } catch (error) {
    return { id, status: "warn", summary: `could not inspect the ${service.kind} service: ${errorMessage(error)}` };
  }
}

// ---------------------------------------------------------------------------------------------

function skipped(id: string, reason: string): DoctorCheck {
  return { id, status: "skip", summary: reason };
}

export async function runDoctor(input: {
  readonly configPath: string;
  readonly fix: boolean;
  readonly dependencies: DoctorDependencies;
}): Promise<DoctorReport> {
  const configPath = resolve(input.configPath);
  const { dependencies, fix } = input;
  const checks: DoctorCheck[] = [];
  const finish = (): DoctorReport => ({
    ok: checks.every((check) => check.status !== "fail"),
    configPath,
    checks,
  });

  checks.push(checkBunVersion(dependencies));
  const configResult = await checkConfig(configPath);
  checks.push(configResult.check);
  const config = configResult.config;
  if (config === undefined) return finish();

  const dataDirectory = await checkDataDirectory(config, dependencies, fix);
  checks.push(dataDirectory);

  const secrets = new Map<string, SecretString>();
  for (const spec of secretFileSpecs(config)) {
    const result = await checkSecretFile(spec, dependencies, fix);
    checks.push(result.check);
    if (result.secret !== undefined) secrets.set(spec.id, result.secret);
  }

  checks.push(
    dataDirectory.status === "pass"
      ? await checkStore(config, dependencies)
      : skipped("store", "data directory is not usable"),
  );

  const environment = await checkT3Environment(config, dependencies);
  checks.push(environment.check);
  checks.push(checkT3Version(environment.serverVersion, dependencies.pin));
  const t3Token = secrets.get("secret:t3-token");
  if (!environment.reachable) {
    checks.push(skipped("t3-session", "T3 is not reachable"), skipped("t3-providers", "T3 is not reachable"));
  } else if (t3Token === undefined) {
    checks.push(skipped("t3-session", "T3 token is not usable"), skipped("t3-providers", "T3 token is not usable"));
  } else {
    const session = await checkT3Session(config, t3Token, dependencies);
    checks.push(session);
    checks.push(
      session.status === "fail"
        ? skipped("t3-providers", "T3 token was rejected")
        : await checkT3Providers(config, dependencies),
    );
  }

  const botToken = secrets.get("secret:slack-bot-token");
  checks.push(
    botToken === undefined
      ? skipped("slack-bot-auth", "Slack bot token is not usable")
      : await checkSlackBot(config, botToken, dependencies),
  );
  const appToken = secrets.get("secret:slack-app-token");
  checks.push(
    appToken === undefined
      ? skipped("slack-app-auth", "Slack app token is not usable")
      : await checkSlackApp(appToken, dependencies),
  );

  // Service repair reruns the doctor inside the installer, so only attempt it once everything else passes.
  const blocked = checks.some((check) => check.status === "fail");
  checks.push(await checkService(configPath, dependencies.service, { fix, blocked }));
  return finish();
}

export function formatDoctorReport(report: DoctorReport): string {
  const label: Record<DoctorStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const width = Math.max(...report.checks.map((check) => check.id.length));
  const lines = [`agent-tag doctor ${report.configPath}`];
  for (const check of report.checks) {
    lines.push(`  ${label[check.status]}  ${check.id.padEnd(width)}  ${check.summary}`);
    if (check.fixed !== undefined) lines.push(`        ${"".padEnd(width)}  fixed: ${check.fixed}`);
    if (check.hint !== undefined && check.status !== "pass") lines.push(`        ${"".padEnd(width)}  hint: ${check.hint}`);
    else if (check.hint !== undefined) lines.push(`        ${"".padEnd(width)}  note: ${check.hint}`);
  }
  const count = (status: DoctorStatus): number => report.checks.filter((check) => check.status === status).length;
  lines.push(`${count("pass")} passed, ${count("warn")} warning(s), ${count("fail")} failed, ${count("skip")} skipped`);
  return lines.join("\n");
}

const packageSchema = z.object({
  engines: z.object({ bun: z.string().min(1) }),
  packageManager: z.string().optional(),
});

export async function defaultDoctorDependencies(service: ServiceManager | undefined): Promise<DoctorDependencies> {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const pin = parseT3Pin(await Bun.file(join(repositoryRoot, "t3.lock.json")).json());
  const packageInfo = packageSchema.parse(await Bun.file(join(repositoryRoot, "package.json")).json());
  return {
    fetch: (url, init) => fetch(url, init),
    bunVersion: Bun.version,
    uid: process.getuid?.(),
    now: () => new Date(),
    pin,
    bunRequirement: {
      minimum: packageInfo.engines.bun.replace(/^>=\s*/, ""),
      pinned: packageInfo.packageManager?.startsWith("bun@") ? packageInfo.packageManager.slice(4) : undefined,
    },
    inspectSession: (sessionInput) =>
      inspectT3Session({ ...sessionInput, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) }),
    inspectT3: (t3) => inspectT3(t3, AbortSignal.timeout(15_000)),
    storeDiagnostics: async (config) => {
      const store = await AgentTagStore.open(join(config.dataDir, "agent-tag.sqlite"));
      try {
        return store.diagnostics();
      } finally {
        store.close();
      }
    },
    service,
  };
}
