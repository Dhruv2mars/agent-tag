import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type { CommandRunner } from "./command.ts";
import { type AgentTagConfig, agentTagConfigSchema } from "./config.ts";
import { checkT3Environment } from "./doctor.ts";
import type { Prompter } from "./prompt.ts";
import { createSecretFile, readSecretFile, SecretString } from "./security/secret-file.ts";
import type { ServiceStatusReport } from "./service-manager.ts";
import {
  parseIssuedT3Session,
  T3_ADMIN_SESSION_TTL,
  t3AdminSessionIssueCommand,
  t3AdminSessionRevokeCommand,
} from "./t3/admin-session.ts";
import type { T3ServerInfo } from "./t3/gateway.ts";

export const SLACK_APP_TOKEN_ENV = "AGENT_TAG_SLACK_APP_TOKEN";
export const SLACK_BOT_TOKEN_ENV = "AGENT_TAG_SLACK_BOT_TOKEN";

const SLACK_ID = /^[A-Z][A-Z0-9]+$/;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const PROVIDER_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RUNTIME_MODES = ["approval-required", "auto-accept-edits"] as const;
type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface OnboardOptions {
  readonly interactive: boolean;
  readonly acceptRisk: boolean;
  readonly force: boolean;
  readonly home?: string;
  readonly configPath?: string;
  readonly workspaceId?: string;
  readonly skipSlackCheck: boolean;
  readonly t3BaseUrl?: string;
  readonly t3BaseDir?: string;
  readonly t3Bin?: string;
  readonly t3AdminTokenFile?: string;
  readonly t3IssueToken: boolean;
  readonly repositoryRoots?: string;
  readonly baseBranch?: string;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly profileId?: string;
  readonly allowedUserIds?: string;
  readonly allowedChannelIds?: string;
  readonly maxConcurrentTasks?: string;
  /** Undefined asks interactively and means "no" in non-interactive mode. */
  readonly installService?: boolean;
}

export interface OnboardDependencies {
  readonly prompter: Prompter;
  readonly print: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly cwd: string;
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly runCommand: CommandRunner;
  /** Exchanges an administrative T3 token for a restricted orchestration token and verifies it. */
  readonly enrollT3: (input: { readonly baseUrl: string; readonly administrativeToken: SecretString }) => Promise<SecretString>;
  readonly listT3Providers: (t3: Pick<AgentTagConfig["t3"], "baseUrl" | "tokenFile">) => Promise<T3ServerInfo>;
  /** Undefined when this platform has no supported service manager. */
  readonly installService: ((configPath: string) => Promise<ServiceStatusReport>) | undefined;
  /** Parsed `config/agent-tag.example.json`; supplies profile, memory, and limit defaults. */
  readonly template: unknown;
  /** Parsed `config/slack-manifest.example.json`. */
  readonly manifest: unknown;
}

export type SecretOutcome = "created" | "kept" | "missing";

export interface OnboardResult {
  readonly configPath: string;
  readonly config: AgentTagConfig;
  readonly secrets: {
    readonly slackAppToken: SecretOutcome;
    readonly slackBotToken: SecretOutcome;
    readonly t3Token: SecretOutcome;
  };
  readonly service?: ServiceStatusReport;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

export interface OnboardPaths {
  readonly home: string;
  readonly configPath: string;
  readonly dataDir: string;
  readonly secretsDir: string;
  readonly appTokenFile: string;
  readonly botTokenFile: string;
  readonly t3TokenFile: string;
}

export function defaultAgentTagHome(env: Readonly<Record<string, string | undefined>>, homeDirectory: string): string {
  const configured = env.AGENT_TAG_HOME;
  return configured !== undefined && isAbsolute(configured) ? configured : join(homeDirectory, ".agent-tag");
}

export function onboardPaths(home: string, configPath?: string): OnboardPaths {
  const secretsDir = join(home, "secrets");
  return {
    home,
    configPath: configPath ?? join(home, "agent-tag.json"),
    dataDir: join(home, "data"),
    secretsDir,
    appTokenFile: join(secretsDir, "slack-app-token"),
    botTokenFile: join(secretsDir, "slack-bot-token"),
    t3TokenFile: join(secretsDir, "t3-token"),
  };
}

/** Slack's documented "create app from manifest" deep link. */
export function slackManifestUrl(manifest: unknown): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/** Splits a comma/space separated list, trims, dedupes, and validates each Slack ID. */
export function parseSlackIdList(value: string, label: string): string[] {
  const ids = [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item.length > 0))];
  if (ids.length === 0) throw new Error(`${label}: at least one ID is required`);
  for (const id of ids) {
    if (!SLACK_ID.test(id)) throw new Error(`${label}: ${JSON.stringify(id)} is not a Slack ID`);
  }
  return ids;
}

export function parsePathList(value: string, cwd: string): string[] {
  const paths = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) throw new Error("at least one repository root is required");
  return [...new Set(paths.map((path) => resolve(cwd, path)))];
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (host === "127.0.0.1" || host === "localhost" || host === "[::1]");
  } catch {
    return false;
  }
}

const serverRuntimeSchema = z.object({
  origin: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
});

/** Reads the running T3 server's advertised origin from `<baseDir>/userdata/server-runtime.json`. */
export async function detectT3Runtime(baseDir: string): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(baseDir, "userdata", "server-runtime.json"), "utf8"));
  } catch {
    return undefined;
  }
  const parsed = serverRuntimeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { origin, host, port } = parsed.data;
  const candidate = origin ?? (host !== undefined && port !== undefined ? `http://${host}:${port}` : undefined);
  if (candidate === undefined || !isLoopbackUrl(candidate)) return undefined;
  return new URL(candidate).origin;
}

/** T3's own base-dir resolution: `--t3-base-dir`, then `$T3CODE_HOME`, then `~/.t3`. */
export function defaultT3BaseDir(env: Readonly<Record<string, string | undefined>>, homeDirectory: string): string {
  const configured = env.T3CODE_HOME?.trim();
  return configured !== undefined && configured.length > 0 ? configured : join(homeDirectory, ".t3");
}

function effectivePort(url: URL): string {
  return url.port.length > 0 ? url.port : url.protocol === "https:" ? "443" : "80";
}

/**
 * Explains why `t3 auth session issue --base-dir DIR` may target a different T3 instance than `baseUrl`,
 * or returns undefined when DIR's running server is the one at `baseUrl`. Both URLs are loopback, so
 * scheme and port identify the server regardless of `localhost` versus `127.0.0.1`.
 */
export function t3BaseDirMismatch(input: {
  readonly baseUrl: string;
  readonly baseDir: string;
  readonly detected: string | undefined;
}): string | undefined {
  if (input.detected === undefined) {
    return `${input.baseDir} has no running T3 server (no userdata/server-runtime.json), so it may not be the instance at ${input.baseUrl}`;
  }
  const detected = new URL(input.detected);
  const configured = new URL(input.baseUrl);
  if (detected.protocol === configured.protocol && effectivePort(detected) === effectivePort(configured)) return undefined;
  return `${input.baseDir} belongs to the T3 server at ${input.detected}, not ${input.baseUrl}`;
}

export interface OnboardAnswers {
  readonly paths: OnboardPaths;
  readonly t3BaseUrl: string;
  readonly workspaceId: string;
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly profileId: string;
  readonly repositoryRoots: readonly string[];
  readonly baseBranch: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly maxConcurrentTasks: number;
}

/** Builds a config from the example template plus answers; throws with readable issues when invalid. */
export function buildOnboardConfig(template: unknown, answers: OnboardAnswers): { readonly config: AgentTagConfig; readonly json: string } {
  const base = agentTagConfigSchema.parse(template);
  const templateProfile = base.profiles[0];
  if (templateProfile === undefined) throw new Error("config template has no profile");
  // Model policy keys keep their schema defaults rather than being written out; the wizard does not ask about them.
  const { allowedModels: _allowedModels, modelSwitch: _modelSwitch, ...baseProfile } = templateProfile;
  const candidate = {
    version: 1,
    dataDir: answers.paths.dataDir,
    t3: { baseUrl: answers.t3BaseUrl, tokenFile: answers.paths.t3TokenFile },
    slack: {
      workspaceId: answers.workspaceId,
      appTokenFile: answers.paths.appTokenFile,
      botTokenFile: answers.paths.botTokenFile,
    },
    access: {
      allowedUserIds: [...answers.allowedUserIds],
      allowedChannelIds: [...answers.allowedChannelIds],
    },
    profiles: [
      {
        ...baseProfile,
        id: answers.profileId,
        repositoryRoots: [...answers.repositoryRoots],
        baseBranch: answers.baseBranch,
        defaultProviderInstanceId: answers.providerInstanceId,
        defaultModel: answers.model,
        runtimeMode: answers.runtimeMode,
        externalWrites: { mode: "approval-required", allowedTools: [] },
        memory: { ...baseProfile.memory, privateDm: false },
        ambient: { ...baseProfile.ambient, enabled: false, keywords: [] },
      },
    ],
    routes: answers.allowedChannelIds.map((conversationId) => ({
      conversationId,
      conversationType: "channel",
      profileId: answers.profileId,
    })),
    limits: { ...base.limits, maxConcurrentTasks: answers.maxConcurrentTasks },
  };
  const parsed = agentTagConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`generated config is invalid: ${issues}`);
  }
  return { config: parsed.data, json: `${JSON.stringify(candidate, null, 2)}\n` };
}

// ---------------------------------------------------------------------------------------------
// Wizard

interface Context {
  readonly options: OnboardOptions;
  readonly deps: OnboardDependencies;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves one value from a flag, a prompt, or a default, validating each source the same way. */
async function resolveValue<T>(
  context: Context,
  input: {
    readonly flag: string;
    readonly value: string | undefined;
    readonly question: string;
    readonly defaultValue?: string;
    readonly parse: (raw: string) => T;
  },
): Promise<T> {
  const { options, deps } = context;
  const parseWithFlag = (raw: string): T => {
    try {
      return input.parse(raw);
    } catch (error) {
      throw new Error(`--${input.flag}: ${errorMessage(error)}`);
    }
  };
  if (input.value !== undefined) return parseWithFlag(input.value);
  if (!options.interactive) {
    if (input.defaultValue !== undefined) return parseWithFlag(input.defaultValue);
    throw new Error(`missing --${input.flag} (required in non-interactive mode)`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await deps.prompter.ask(input.question, input.defaultValue);
    try {
      return input.parse(answer);
    } catch (error) {
      deps.print(`  ${errorMessage(error)}`);
    }
  }
  throw new Error(`no valid answer for: ${input.question}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivateFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.agent-tag-config.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function provisionSlackSecret(
  context: Context,
  input: { readonly label: string; readonly path: string; readonly prefix: string; readonly envName: string },
): Promise<{ readonly outcome: SecretOutcome; readonly secret: SecretString }> {
  const { options, deps } = context;
  if (await exists(input.path)) {
    const secret = await readSecretFile(input.path);
    if (!secret.exposeToBoundary().startsWith(input.prefix)) {
      throw new Error(`${input.path} does not contain a ${input.prefix}… token; delete it and rerun onboard`);
    }
    deps.print(`  keeping existing ${input.label} at ${input.path}`);
    return { outcome: "kept", secret };
  }
  const validate = (value: string): string | undefined =>
    value.startsWith(input.prefix) ? undefined : `${input.label} must start with ${input.prefix}`;
  let value = deps.env[input.envName]?.trim();
  if (value !== undefined && value.length > 0) {
    const problem = validate(value);
    if (problem !== undefined) throw new Error(`${input.envName}: ${problem}`);
  } else if (!options.interactive) {
    throw new Error(`missing ${input.label}: set ${input.envName} or create ${input.path} (mode 0600)`);
  } else {
    value = undefined;
    for (let attempt = 0; attempt < 5 && value === undefined; attempt += 1) {
      const answer = await deps.prompter.secret(`Paste the ${input.label}`);
      const problem = validate(answer);
      if (problem === undefined) value = answer;
      else deps.print(`  ${problem}`);
    }
    if (value === undefined) throw new Error(`no valid ${input.label} entered`);
  }
  const secret = new SecretString(value);
  await createSecretFile({ path: input.path, secret });
  deps.print(`  wrote ${input.label} to ${input.path} (mode 0600)`);
  return { outcome: "created", secret };
}

const slackAuthSchema = z.union([
  z.object({ ok: z.literal(true), team_id: z.string().min(1), team: z.string().optional(), user: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

async function slackWorkspace(context: Context, botToken: SecretString): Promise<string | undefined> {
  const { deps } = context;
  try {
    const response = await deps.fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken.exposeToBoundary()}`, "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
    });
    const auth = slackAuthSchema.parse(await response.json());
    if (!auth.ok) {
      deps.print(`  Slack auth.test failed: ${auth.error}`);
      return undefined;
    }
    deps.print(`  Slack bot ${auth.user ?? ""} authenticated in workspace ${auth.team ?? ""} (${auth.team_id})`);
    return auth.team_id;
  } catch (error) {
    deps.print(`  Slack auth.test failed: ${errorMessage(error)}`);
    return undefined;
  }
}

/** The onboarding admin session is short-lived, labeled, and revoked as soon as enrollment ends. */
export { parseIssuedT3Session, T3_ADMIN_SESSION_TTL };
export const T3_ADMIN_SESSION_LABEL = "agent-tag-onboard";

type T3Probe =
  | { readonly usable: true }
  | { readonly usable: false; readonly reachable: boolean; readonly problem: string };

/** Probes T3 with doctor's own environment check, so onboarding never proceeds against a server doctor fails. */
async function probeT3(context: Context, baseUrl: string): Promise<T3Probe> {
  const { deps } = context;
  const { check, reachable } = await checkT3Environment({ t3: { baseUrl } }, { fetch: deps.fetch });
  deps.print(`  ${check.summary}`);
  if (check.status !== "fail") return { usable: true };
  return { usable: false, reachable, problem: check.hint === undefined ? check.summary : `${check.summary} (${check.hint})` };
}

async function provisionT3Token(
  context: Context,
  input: {
    readonly baseUrl: string;
    readonly baseDir: string;
    readonly path: string;
    /** Set when the base dir may belong to another T3 instance; the CLI must not issue a session then. */
    readonly baseDirMismatch: string | undefined;
  },
): Promise<SecretOutcome> {
  const { options, deps } = context;
  if (await exists(input.path)) {
    await readSecretFile(input.path);
    deps.print(`  keeping existing T3 token at ${input.path}`);
    return "kept";
  }
  const t3Bin = options.t3Bin ?? deps.env.AGENT_TAG_T3_BIN ?? "t3";
  const issueCommand = t3AdminSessionIssueCommand({ t3Bin, baseDir: input.baseDir, label: T3_ADMIN_SESSION_LABEL });
  const enrollHint = `bun run enroll:t3 -- --base-url ${input.baseUrl} --admin-token-file ADMIN_TOKEN_FILE --output ${input.path}`;

  let administrativeToken: SecretString | undefined;
  let issuedSessionId: string | undefined;
  let explicit = false;
  if (options.t3AdminTokenFile !== undefined) {
    explicit = true;
    administrativeToken = await readSecretFile(resolve(deps.cwd, options.t3AdminTokenFile));
  } else if (input.baseDirMismatch !== undefined) {
    // A session issued for another instance carries its signing keys and would fail enrollment here.
    const advice = `pass --t3-base-dir for the T3 instance at ${input.baseUrl}, or --t3-admin-token-file`;
    if (options.t3IssueToken) throw new Error(`cannot issue a T3 admin session: ${input.baseDirMismatch}; ${advice}`);
    deps.print(`  not issuing a T3 admin session: ${input.baseDirMismatch}`);
    deps.print(`  ${advice}`);
  } else {
    const issue = options.t3IssueToken ||
      (options.interactive &&
        (await deps.prompter.confirm(
          `  Issue a ${T3_ADMIN_SESSION_TTL} T3 admin session now with \`${issueCommand.join(" ")}\`? It mints one restricted token, is revoked right after, and is never stored`,
          true,
        )));
    explicit = options.t3IssueToken;
    if (issue) {
      const result = await deps.runCommand(issueCommand);
      const issued = result.exitCode === 0 ? parseIssuedT3Session(result.stdout.trim()) : undefined;
      if (issued === undefined) {
        const reason = result.exitCode !== 0
          ? `\`${issueCommand.slice(0, 4).join(" ")}\` failed with exit code ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr.split("\n")[0]}` : ""}`
          : `\`${issueCommand.slice(0, 4).join(" ")}\` printed output Agent Tag does not recognize; any session it issued expires in ${T3_ADMIN_SESSION_TTL} (see \`${t3Bin} auth session list --base-dir ${input.baseDir}\`)`;
        if (explicit) throw new Error(reason);
        deps.print(`  ${reason}`);
      } else {
        administrativeToken = issued.token;
        issuedSessionId = issued.sessionId;
      }
    }
  }
  if (administrativeToken === undefined) {
    deps.print("  no T3 token configured yet. Mint one later with:");
    deps.print(`    ${enrollHint}`);
    return "missing";
  }
  try {
    const restricted = await deps.enrollT3({ baseUrl: input.baseUrl, administrativeToken });
    await createSecretFile({ path: input.path, secret: restricted });
  } catch (error) {
    if (explicit) throw error;
    deps.print(`  T3 enrollment failed: ${errorMessage(error)}`);
    deps.print(`  retry later with: ${enrollHint}`);
    return "missing";
  } finally {
    if (issuedSessionId !== undefined) {
      await revokeT3Session(context, { t3Bin, baseDir: input.baseDir, sessionId: issuedSessionId });
    }
  }
  deps.print(`  wrote restricted T3 token (orchestration:read, orchestration:operate) to ${input.path}`);
  return "created";
}

/** Revokes the onboarding admin session; failure only warns because the session expires on its own. */
async function revokeT3Session(
  context: Context,
  input: { readonly t3Bin: string; readonly baseDir: string; readonly sessionId: string },
): Promise<void> {
  const { deps } = context;
  const command = t3AdminSessionRevokeCommand(input);
  let failure: string | undefined;
  try {
    const result = await deps.runCommand(command);
    if (result.exitCode !== 0) failure = `exit code ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr.split("\n")[0]}` : ""}`;
  } catch (error) {
    failure = errorMessage(error);
  }
  if (failure === undefined) {
    deps.print(`  revoked the onboarding T3 admin session ${input.sessionId}`);
    return;
  }
  deps.print(`  warning: could not revoke the onboarding T3 admin session ${input.sessionId} (${failure}); it expires in ${T3_ADMIN_SESSION_TTL}`);
  deps.print(`  revoke it now with: ${command.join(" ")}`);
}

type T3Provider = T3ServerInfo["providers"][number];

interface ProviderDiscovery {
  /** Every provider T3 reported; the model default follows whichever one the operator selects. */
  readonly providers: readonly T3Provider[];
  /** The first ready, authenticated provider. */
  readonly providerInstanceId?: string;
}

async function discoverProviders(context: Context, t3: Pick<AgentTagConfig["t3"], "baseUrl" | "tokenFile">): Promise<ProviderDiscovery | undefined> {
  const { deps } = context;
  try {
    const server = await deps.listT3Providers(t3);
    const ready = server.providers.filter(
      (provider) => provider.enabled && provider.installed && provider.status === "ready" && provider.auth.status === "authenticated",
    );
    if (ready.length === 0) {
      deps.print("  T3 reports no ready, authenticated provider; authenticate one in T3 before starting");
      return { providers: server.providers };
    }
    deps.print("  ready T3 providers:");
    for (const provider of ready) {
      deps.print(`    ${provider.instanceId}: ${provider.models.map((model) => model.slug).join(", ")}`);
    }
    return { providers: server.providers, providerInstanceId: ready[0]!.instanceId };
  } catch (error) {
    deps.print(`  could not list T3 providers: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * The model to offer for the selected provider: T3's default for that provider when T3 listed it, otherwise the
 * template's model only when the template pairs it with the same provider. Undefined means the operator must choose.
 */
export function defaultModelForProvider(
  providerInstanceId: string,
  discovery: ProviderDiscovery | undefined,
  template: { readonly defaultProviderInstanceId: string; readonly defaultModel: string },
): string | undefined {
  if (discovery !== undefined) {
    const provider = discovery.providers.find((candidate) => candidate.instanceId === providerInstanceId);
    return (provider?.models.find((candidate) => candidate.isDefault === true) ?? provider?.models[0])?.slug;
  }
  return providerInstanceId === template.defaultProviderInstanceId ? template.defaultModel : undefined;
}

export async function runOnboard(options: OnboardOptions, deps: OnboardDependencies): Promise<OnboardResult> {
  const context: Context = { options, deps };
  const { print, prompter } = deps;
  const template = agentTagConfigSchema.parse(deps.template);
  const templateProfile = template.profiles[0]!;

  print("Agent Tag onboarding");
  print("");
  print("Agent Tag runs coding agents through T3 as your OS user, with access to the repositories you configure.");
  print("Only allow Slack users you would trust with a shell on this machine.");
  if (options.interactive) {
    if (!options.acceptRisk && !(await prompter.confirm("Continue with trusted same-user execution?", false))) {
      throw new Error("onboarding cancelled");
    }
  } else if (!options.acceptRisk) {
    throw new Error("pass --accept-risk to acknowledge trusted same-user execution in non-interactive mode");
  }

  // 1. Directory layout.
  print("");
  print("Step 1/6: data directory");
  const home = await resolveValue(context, {
    flag: "dir",
    value: options.home,
    question: "Agent Tag directory (config, data, secrets)",
    defaultValue: defaultAgentTagHome(deps.env, deps.homeDirectory),
    parse: (raw) => resolve(deps.cwd, raw),
  });
  const paths = onboardPaths(home, options.configPath === undefined ? undefined : resolve(deps.cwd, options.configPath));
  if ((await exists(paths.configPath)) && !options.force) {
    const overwrite = options.interactive && (await prompter.confirm(`  ${paths.configPath} exists. Overwrite it?`, false));
    if (!overwrite) throw new Error(`${paths.configPath} already exists; pass --force to overwrite it`);
  }
  // The chosen directory may be shared (for example $HOME); only the data and secret directories are forced to 0700.
  if (!(await exists(paths.home))) await ensurePrivateDirectory(paths.home);
  for (const directory of [paths.dataDir, paths.secretsDir]) await ensurePrivateDirectory(directory);
  await mkdir(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  print(`  using ${paths.home} (data: ${paths.dataDir}, secrets: ${paths.secretsDir})`);

  // 2. Slack app.
  print("");
  print("Step 2/6: Slack app");
  print("  Create the app from this manifest (Socket Mode, least-privilege scopes):");
  print(`    ${slackManifestUrl(deps.manifest)}`);
  print("  Manifest:");
  for (const line of JSON.stringify(deps.manifest, null, 2).split("\n")) print(`    ${line}`);
  print("  Then: install it to your workspace, copy the xoxb- bot token (OAuth & Permissions), and create an");
  print("  app-level token with only connections:write (Basic Information > App-Level Tokens).");
  const appToken = await provisionSlackSecret(context, {
    label: "Slack app-level token",
    path: paths.appTokenFile,
    prefix: "xapp-",
    envName: SLACK_APP_TOKEN_ENV,
  });
  const botToken = await provisionSlackSecret(context, {
    label: "Slack bot token",
    path: paths.botTokenFile,
    prefix: "xoxb-",
    envName: SLACK_BOT_TOKEN_ENV,
  });
  const detectedWorkspace = options.skipSlackCheck ? undefined : await slackWorkspace(context, botToken.secret);
  const workspaceId = await resolveValue(context, {
    flag: "workspace-id",
    value: options.workspaceId,
    question: "Slack workspace ID (starts with T)",
    ...(detectedWorkspace === undefined ? {} : { defaultValue: detectedWorkspace }),
    parse: (raw) => {
      const id = raw.trim();
      if (!SLACK_ID.test(id) || !id.startsWith("T")) throw new Error("workspace ID must look like T0123ABCD");
      if (detectedWorkspace !== undefined && id !== detectedWorkspace) {
        throw new Error(`the bot token belongs to ${detectedWorkspace}, not ${id}`);
      }
      return id;
    },
  });

  // 3. T3.
  print("");
  print("Step 3/6: T3 Code");
  const t3BaseDir = resolve(deps.cwd, options.t3BaseDir ?? defaultT3BaseDir(deps.env, deps.homeDirectory));
  const detectedT3 = await detectT3Runtime(t3BaseDir);
  if (detectedT3 !== undefined) print(`  detected a running T3 server at ${detectedT3} (${t3BaseDir})`);
  const t3BaseUrl = await resolveValue(context, {
    flag: "t3-url",
    value: options.t3BaseUrl,
    question: "T3 base URL (loopback only)",
    ...(detectedT3 !== undefined
      ? { defaultValue: detectedT3 }
      : options.interactive
        ? { defaultValue: template.t3.baseUrl }
        : {}),
    parse: (raw) => {
      if (!isLoopbackUrl(raw.trim())) throw new Error("T3 must use a loopback http(s) URL such as http://127.0.0.1:3773");
      return new URL(raw.trim()).origin;
    },
  });
  const t3 = await probeT3(context, t3BaseUrl);
  if (!t3.usable && (options.t3AdminTokenFile !== undefined || options.t3IssueToken)) {
    throw new Error(`cannot enroll a T3 token: ${t3.problem}`);
  }
  const t3Token = t3.usable
    ? await provisionT3Token(context, {
      baseUrl: t3BaseUrl,
      baseDir: t3BaseDir,
      path: paths.t3TokenFile,
      baseDirMismatch: t3BaseDirMismatch({ baseUrl: t3BaseUrl, baseDir: t3BaseDir, detected: detectedT3 }),
    })
    : (await exists(paths.t3TokenFile))
      ? "kept"
      : "missing";
  if (!t3.usable) {
    print(
      t3.reachable
        ? "  skipping T3 token and provider setup: run the T3 version pinned in t3.lock.json, then `bun run enroll:t3` and `agent-tag doctor`"
        : "  skipping T3 token and provider setup: start T3, then mint a token with `bun run enroll:t3` and run `agent-tag doctor`",
    );
  }

  // 4. Repositories and provider.
  print("");
  print("Step 4/6: repositories and provider");
  const cwdIsRepository = await exists(join(deps.cwd, ".git"));
  const repositoryRoots = await resolveValue(context, {
    flag: "repo",
    value: options.repositoryRoots,
    question: "Repository root(s) the agent may work in (comma separated)",
    ...(options.interactive && cwdIsRepository ? { defaultValue: deps.cwd } : {}),
    parse: (raw) => parsePathList(raw, deps.cwd),
  });
  for (const root of repositoryRoots) {
    const metadata = await stat(root).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) throw new Error(`repository root ${root} is not a directory`);
    if (!(await exists(join(root, ".git")))) print(`  warning: ${root} is not a git checkout; T3 worktrees need git`);
  }
  const baseBranch = await resolveValue(context, {
    flag: "base-branch",
    value: options.baseBranch,
    question: "Base branch",
    defaultValue: templateProfile.baseBranch,
    parse: (raw) => {
      if (raw.trim().length === 0) throw new Error("base branch is required");
      return raw.trim();
    },
  });
  const discovered =
    !t3.usable || t3Token === "missing" ? undefined : await discoverProviders(context, { baseUrl: t3BaseUrl, tokenFile: paths.t3TokenFile });
  const providerInstanceId = await resolveValue(context, {
    flag: "provider",
    value: options.providerInstanceId,
    question: "T3 provider instance",
    defaultValue: discovered?.providerInstanceId ?? templateProfile.defaultProviderInstanceId,
    parse: (raw) => {
      if (!PROVIDER_ID.test(raw.trim())) throw new Error("provider instance IDs look like codex or claudeAgent");
      return raw.trim();
    },
  });
  const defaultModel = defaultModelForProvider(providerInstanceId, discovered, templateProfile);
  if (defaultModel === undefined && options.model === undefined) {
    const reason =
      discovered === undefined
        ? `T3 did not list providers and the template's model belongs to ${templateProfile.defaultProviderInstanceId}`
        : `T3 reports no default model for ${providerInstanceId}`;
    if (!options.interactive) throw new Error(`missing --model: ${reason}; pass the model for ${providerInstanceId}`);
    print(`  ${reason}; enter the model to use with ${providerInstanceId}`);
  }
  const model = await resolveValue(context, {
    flag: "model",
    value: options.model,
    question: `Model for ${providerInstanceId}`,
    ...(defaultModel === undefined ? {} : { defaultValue: defaultModel }),
    parse: (raw) => {
      if (raw.trim().length === 0) throw new Error("model is required");
      return raw.trim();
    },
  });
  const runtimeMode = await resolveValue(context, {
    flag: "runtime-mode",
    value: options.runtimeMode,
    question: `Runtime mode (${RUNTIME_MODES.join(" | ")})`,
    defaultValue: "approval-required",
    parse: (raw): RuntimeMode => {
      const mode = RUNTIME_MODES.find((candidate) => candidate === raw.trim());
      if (mode === undefined) throw new Error(`runtime mode must be one of ${RUNTIME_MODES.join(", ")}`);
      return mode;
    },
  });
  const profileId = await resolveValue(context, {
    flag: "profile",
    value: options.profileId,
    question: "Profile name",
    defaultValue: "default",
    parse: (raw) => {
      if (!PROFILE_ID.test(raw.trim())) throw new Error("profile names use lowercase letters, digits, and dashes");
      return raw.trim();
    },
  });

  // 5. Access.
  print("");
  print("Step 5/6: access");
  print("  Find IDs in Slack: a user's profile > More > Copy member ID; a channel's details > About (bottom).");
  const allowedUserIds = await resolveValue(context, {
    flag: "users",
    value: options.allowedUserIds,
    question: "Slack user IDs allowed to direct Agent Tag (comma separated, U…)",
    parse: (raw) => parseSlackIdList(raw, "users"),
  });
  const allowedChannelIds = await resolveValue(context, {
    flag: "channels",
    value: options.allowedChannelIds,
    question: "Channel IDs Agent Tag answers in (comma separated, C… or G…)",
    parse: (raw) => {
      const ids = parseSlackIdList(raw, "channels");
      const dm = ids.find((id) => id.startsWith("D"));
      if (dm !== undefined) {
        throw new Error(`${dm} is a DM; add DM routes by hand (see docs/operations.md, "DM routes")`);
      }
      return ids;
    },
  });
  const maxConcurrentTasks = await resolveValue(context, {
    flag: "max-concurrent-tasks",
    value: options.maxConcurrentTasks,
    question: "Maximum concurrent tasks",
    defaultValue: String(template.limits.maxConcurrentTasks),
    parse: (raw) => {
      const value = Number(raw.trim());
      if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error("must be an integer from 1 to 32");
      return value;
    },
  });

  // 6. Write config and optionally install the service.
  print("");
  print("Step 6/6: write config");
  const built = buildOnboardConfig(deps.template, {
    paths,
    t3BaseUrl,
    workspaceId,
    allowedUserIds,
    allowedChannelIds,
    profileId,
    repositoryRoots,
    baseBranch,
    providerInstanceId,
    model,
    runtimeMode,
    maxConcurrentTasks,
  });
  await writePrivateFileAtomically(paths.configPath, built.json);
  print(`  wrote ${paths.configPath} (mode 0600)`);

  const secrets = { slackAppToken: appToken.outcome, slackBotToken: botToken.outcome, t3Token };
  let service: ServiceStatusReport | undefined;
  if (deps.installService === undefined) {
    print("  no supported service manager on this platform; run `agent-tag run CONFIG` in the foreground");
  } else {
    const install = options.installService ??
      (options.interactive &&
        (await prompter.confirm("  Install and start the background service now?", t3.usable && t3Token !== "missing")));
    if (install && !t3.usable) {
      // The installer's doctor preflight would fail the same check; say so instead of attempting it.
      print(`  not installing the service: ${t3.problem}`);
      print(`  once T3 is fixed: \`agent-tag doctor ${paths.configPath}\`, then \`agent-tag service install ${paths.configPath}\``);
      if (!options.interactive) throw new Error(`service not installed: ${t3.problem}`);
    } else if (install) {
      try {
        service = await deps.installService(paths.configPath);
        print(`  ${service.manager} service installed${service.running ? " and running" : ""} (${service.unitPath})`);
        for (const hint of service.hints) print(`  note: ${hint}`);
      } catch (error) {
        print(`  service install failed: ${errorMessage(error)}`);
        print(`  fix the reported problem with \`agent-tag doctor ${paths.configPath} --fix\`, then \`agent-tag service install ${paths.configPath}\``);
        if (!options.interactive) throw error;
      }
    }
  }

  print("");
  print("Next steps:");
  print("  1. Invite the bot to each allowed channel: /invite @Agent Tag");
  print(`  2. Check everything: agent-tag doctor ${paths.configPath}`);
  if (service === undefined) print(`  3. Start it: agent-tag service install ${paths.configPath}  (or: agent-tag run ${paths.configPath})`);
  else print("  3. Mention the bot in an allowed channel.");
  return { configPath: paths.configPath, config: built.config, secrets, ...(service === undefined ? {} : { service }) };
}
