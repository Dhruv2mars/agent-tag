import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Imported, not read from disk, so compiled release binaries embed them.
import configTemplate from "../config/agent-tag.example.json" with { type: "json" };
import slackManifest from "../config/slack-manifest.example.json" with { type: "json" };

import { parseArguments } from "./cli-args.ts";
import { runCommand } from "./command.ts";
import { loadConfig } from "./config.ts";
import { defaultDoctorDependencies, formatDoctorReport, runDoctor } from "./doctor.ts";
import { defaultAgentTagHome, type OnboardOptions, runOnboard } from "./onboard.ts";
import { createReadlinePrompter, nonInteractivePrompter } from "./prompt.ts";
import { isServiceAction, SERVICE_ACTIONS, serviceManagerFor } from "./service-manager.ts";
import {
  assertRestrictedOrchestrationSession,
  expectAdministrativeAccessDenied,
  inspectT3Session,
  mintRestrictedT3Token,
} from "./t3/auth.ts";
import { inspectT3 } from "./t3/gateway.ts";
import { defaultT3RuntimeDir, inspectInstalledT3, installPinnedT3, parseT3DownloadBaseUrl } from "./t3/install.ts";
import { PINNED_T3 } from "./t3/lock.ts";
import { inspectT3TokenStatus, T3_CREDENTIAL_STATE_FILE } from "./t3/credentials.ts";
import {
  type ExternalT3AdminFlags,
  inspectManagedT3Runtime,
  requireManagedT3,
  runManagedT3Pair,
  runManagedT3Serve,
  runT3Rotate,
} from "./t3/operator.ts";
import { fetchT3EnvironmentDescriptor, t3DescriptorProblem } from "./t3/protocol.ts";

/** CONFIG positional, else $AGENT_TAG_CONFIG, else the onboarding default `~/.agent-tag/agent-tag.json`. */
export function resolveConfigPath(
  positional: string | undefined,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  homeDirectory: string = homedir(),
): string {
  if (positional !== undefined) return resolve(positional);
  if (env.AGENT_TAG_CONFIG !== undefined) return resolve(env.AGENT_TAG_CONFIG);
  return join(defaultAgentTagHome(env, homeDirectory), "agent-tag.json");
}

export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv, { booleans: ["fix", "json"], values: [] });
  const configPath = resolveConfigPath(args.positionals[0]);
  const report = await runDoctor({
    configPath,
    fix: args.flags.has("fix"),
    dependencies: await defaultDoctorDependencies(serviceManagerFor()),
  });
  console.log(args.flags.has("json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

const SERVICE_USAGE = `usage: agent-tag service <${SERVICE_ACTIONS.join("|")}> [CONFIG] [--lines N] [--follow]`;

export async function runServiceCommand(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv, { booleans: ["follow"], values: ["lines"] });
  const action = args.positionals[0];
  if (!isServiceAction(action)) throw new Error(SERVICE_USAGE);
  const manager = serviceManagerFor();
  if (manager === undefined) {
    throw new Error(`no supported service manager on ${process.platform}; run \`agent-tag run CONFIG\` under your own supervisor`);
  }
  if (action === "logs") {
    const lines = Number(args.values.get("lines") ?? "200");
    if (!Number.isInteger(lines) || lines < 1) throw new Error("--lines must be a positive integer");
    const child = Bun.spawn(manager.logsCommand({ lines, follow: args.flags.has("follow") }), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exited;
  }
  const configPath = resolveConfigPath(args.positionals[1]);
  const status = action === "install"
    ? await manager.install(configPath)
    : action === "upgrade"
      ? await manager.upgrade(configPath)
      : action === "uninstall"
        ? await manager.uninstall()
        : action === "restart"
          ? await manager.restart()
          : await manager.status();
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

export const T3_USAGE =
  "usage: agent-tag t3 <install|status> [CONFIG] [--download-base-url URL] | agent-tag t3 serve [CONFIG] | agent-tag t3 pair [CONFIG] [--allow-non-tty] | agent-tag t3 rotate [CONFIG] [--admin-token-file F | --t3-base-dir D [--t3-bin B]]";

const T3_ACTIONS = new Set(["install", "status", "serve", "pair", "rotate"]);

/**
 * `t3 install` downloads and verifies the pinned T3 runtime (into `<dataDir>/t3/runtime`, or the
 * managed `t3.runtimeDir`); `t3 status` reports that install without touching the network or
 * running T3 (managed mode adds the running server's pid, protocol and version). `t3 serve` runs the
 * managed runtime in the foreground and `t3 pair` prints a pairing link for its web UI.
 */
export async function runT3Command(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv, {
    booleans: ["allow-non-tty"],
    values: ["download-base-url", "admin-token-file", "t3-base-dir", "t3-bin"],
  });
  const action = args.positionals[0];
  if (action === undefined || !T3_ACTIONS.has(action) || args.positionals.length > 2) throw new Error(T3_USAGE);
  const baseUrlArgument = args.values.get("download-base-url");
  if (baseUrlArgument !== undefined && action !== "install") throw new Error("--download-base-url only applies to t3 install");
  if (args.flags.has("allow-non-tty") && action !== "pair") throw new Error("--allow-non-tty only applies to t3 pair");
  const external = externalT3AdminFlags(args.values);
  if (external !== undefined && action !== "rotate") {
    throw new Error("--admin-token-file, --t3-base-dir and --t3-bin only apply to t3 rotate");
  }
  const baseUrlOverride = baseUrlArgument === undefined ? undefined : parseT3DownloadBaseUrl(baseUrlArgument);
  const config = await loadConfig(resolveConfigPath(args.positionals[1]));
  const t3 = config.t3;
  const managed = t3.mode === "managed" ? t3.managed : undefined;
  const runtimeDir = managed?.runtimeDir ?? defaultT3RuntimeDir(config.dataDir);
  if (action === "install") {
    const baseUrl = baseUrlOverride ?? managed?.downloadBaseUrl;
    const installed = await installPinnedT3({
      pin: PINNED_T3,
      runtimeDir,
      ...(baseUrl === undefined ? {} : { downloadBaseUrl: baseUrl }),
      log: (event, detail) => console.error(`agent-tag: ${event} ${detail}`),
    });
    console.log(JSON.stringify({
      version: installed.version,
      binary: installed.binary,
      sha256: installed.binarySha256,
      downloaded: installed.downloaded,
    }, null, 2));
    return 0;
  }
  if (action === "serve") {
    return runManagedT3Serve({
      t3: requireManagedT3(t3, "serve"),
      pin: PINNED_T3,
      // Logs go to stderr so stdout carries only the ready JSON.
      logger: (record) => console.error(JSON.stringify(record)),
      print: (line) => console.log(line),
    });
  }
  if (action === "pair") {
    return runManagedT3Pair({
      t3: requireManagedT3(t3, "pair"),
      pin: PINNED_T3,
      run: runCommand,
      stdoutIsTty: process.stdout.isTTY === true,
      allowNonTty: args.flags.has("allow-non-tty"),
      print: (line) => console.log(line),
    });
  }
  if (action === "rotate") {
    return runT3Rotate({
      t3,
      pin: PINNED_T3,
      run: runCommand,
      logger: (record) => console.error(JSON.stringify(record)),
      print: (line) => console.log(line),
      ...(external === undefined ? {} : { external }),
    });
  }
  const status = await inspectInstalledT3({ pin: PINNED_T3, runtimeDir });
  if (t3.mode === "external") {
    console.log(JSON.stringify({ mode: "external", ...status, token: await externalT3TokenStatus(t3) }, null, 2));
    return 0;
  }
  const runtime = await inspectManagedT3Runtime({ t3, pinnedVersion: PINNED_T3.version });
  // The token is only presented to our own runtime once it passed the version and protocol check.
  const token = runtime.running && runtime.problem === null
    ? await inspectT3TokenStatus({
        baseUrl: t3.baseUrl,
        tokenFile: t3.tokenFile,
        stateFile: join(t3.managed.runtimeDir, T3_CREDENTIAL_STATE_FILE),
      })
    : { expiresAt: null, daysRemaining: null, problem: "managed T3 is not running and ready" };
  console.log(JSON.stringify({
    mode: "managed",
    ...status,
    baseUrl: t3.baseUrl,
    homeDir: t3.managed.homeDir,
    pid: runtime.pid,
    protocol: runtime.protocol,
    runtime,
    token,
  }, null, 2));
  return 0;
}

/** `--admin-token-file F` or `--t3-base-dir D [--t3-bin B]` (onboard's flags), resolved for `t3 rotate`. */
export function externalT3AdminFlags(values: ReadonlyMap<string, string>): ExternalT3AdminFlags | undefined {
  const adminTokenFile = values.get("admin-token-file");
  const t3BaseDir = values.get("t3-base-dir");
  const t3Bin = values.get("t3-bin");
  if (adminTokenFile !== undefined) {
    if (t3BaseDir !== undefined || t3Bin !== undefined) throw new Error("pass --admin-token-file or --t3-base-dir/--t3-bin, not both");
    return { adminTokenFile: resolve(adminTokenFile) };
  }
  if (t3BaseDir !== undefined) return { t3BaseDir: resolve(t3BaseDir), t3Bin: t3Bin ?? "t3" };
  if (t3Bin !== undefined) throw new Error("--t3-bin needs --t3-base-dir");
  return undefined;
}

/** External `t3 status` token fields; the token is sent only to a server that passes the protocol check. */
async function externalT3TokenStatus(t3: { readonly baseUrl: string; readonly tokenFile: string }) {
  try {
    const descriptor = await fetchT3EnvironmentDescriptor({ baseUrl: t3.baseUrl, signal: AbortSignal.timeout(3_000) });
    const problem = t3DescriptorProblem(descriptor, {});
    if (problem !== undefined) return { expiresAt: null, daysRemaining: null, problem: problem.message };
  } catch (error) {
    return { expiresAt: null, daysRemaining: null, problem: `T3 not reachable on ${t3.baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return inspectT3TokenStatus({ baseUrl: t3.baseUrl, tokenFile: t3.tokenFile });
}

const ONBOARD_BOOLEANS = [
  "yes",
  "non-interactive",
  "accept-risk",
  "force",
  "skip-slack-check",
  "t3-issue-token",
  "install-service",
  "no-install-service",
] as const;
const ONBOARD_VALUES = [
  "dir",
  "config",
  "workspace-id",
  "t3-url",
  "t3-base-dir",
  "t3-bin",
  "t3-admin-token-file",
  "repo",
  "base-branch",
  "provider",
  "model",
  "runtime-mode",
  "profile",
  "users",
  "channels",
  "max-concurrent-tasks",
] as const;

/** Maps parsed CLI arguments onto wizard options; exported for tests. */
export function onboardOptionsFromArguments(argv: readonly string[], stdinIsTty: boolean): OnboardOptions {
  const args = parseArguments(argv, { booleans: ONBOARD_BOOLEANS, values: ONBOARD_VALUES });
  if (args.positionals.length > 0) throw new Error(`unexpected argument ${args.positionals[0]}`);
  if (args.flags.has("install-service") && args.flags.has("no-install-service")) {
    throw new Error("--install-service and --no-install-service are mutually exclusive");
  }
  const pick = (key: keyof OnboardOptions, name: (typeof ONBOARD_VALUES)[number]): Partial<OnboardOptions> => {
    const found = args.values.get(name);
    return found === undefined ? {} : ({ [key]: found } as Partial<OnboardOptions>);
  };
  const nonInteractive = args.flags.has("yes") || args.flags.has("non-interactive") || !stdinIsTty;
  return {
    interactive: !nonInteractive,
    acceptRisk: args.flags.has("accept-risk"),
    force: args.flags.has("force"),
    skipSlackCheck: args.flags.has("skip-slack-check"),
    t3IssueToken: args.flags.has("t3-issue-token"),
    ...(args.flags.has("install-service") ? { installService: true } : {}),
    ...(args.flags.has("no-install-service") ? { installService: false } : {}),
    ...pick("home", "dir"),
    ...pick("configPath", "config"),
    ...pick("workspaceId", "workspace-id"),
    ...pick("t3BaseUrl", "t3-url"),
    ...pick("t3BaseDir", "t3-base-dir"),
    ...pick("t3Bin", "t3-bin"),
    ...pick("t3AdminTokenFile", "t3-admin-token-file"),
    ...pick("repositoryRoots", "repo"),
    ...pick("baseBranch", "base-branch"),
    ...pick("providerInstanceId", "provider"),
    ...pick("model", "model"),
    ...pick("runtimeMode", "runtime-mode"),
    ...pick("profileId", "profile"),
    ...pick("allowedUserIds", "users"),
    ...pick("allowedChannelIds", "channels"),
    ...pick("maxConcurrentTasks", "max-concurrent-tasks"),
  };
}

export async function runOnboardCommand(argv: readonly string[]): Promise<number> {
  const options = onboardOptionsFromArguments(argv, process.stdin.isTTY === true);
  const prompter = options.interactive ? createReadlinePrompter() : nonInteractivePrompter();
  const manager = serviceManagerFor();
  try {
    await runOnboard(options, {
      prompter,
      print: (line) => console.log(line),
      env: Bun.env,
      homeDirectory: homedir(),
      cwd: process.cwd(),
      fetch: (url, init) => fetch(url, init),
      runCommand,
      enrollT3: async ({ baseUrl, administrativeToken }) => {
        const token = await mintRestrictedT3Token({ baseUrl, administrativeToken, label: "Agent Tag" });
        assertRestrictedOrchestrationSession(await inspectT3Session({ baseUrl, token }));
        await expectAdministrativeAccessDenied({ baseUrl, token });
        return token;
      },
      listT3Providers: (t3) => inspectT3(t3, AbortSignal.timeout(15_000)),
      installService: manager === undefined ? undefined : (configPath) => manager.install(configPath),
      template: configTemplate,
      manifest: slackManifest,
    });
  } finally {
    prompter.close();
  }
  return 0;
}
