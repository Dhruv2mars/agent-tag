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

export const T3_USAGE = "usage: agent-tag t3 <install|status> [CONFIG] [--download-base-url URL]";

/**
 * `t3 install` downloads and verifies the pinned T3 runtime into `<dataDir>/t3/runtime`;
 * `t3 status` reports that install without touching the network or running T3.
 */
export async function runT3Command(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv, { booleans: [], values: ["download-base-url"] });
  const action = args.positionals[0];
  if ((action !== "install" && action !== "status") || args.positionals.length > 2) throw new Error(T3_USAGE);
  const baseUrlArgument = args.values.get("download-base-url");
  if (baseUrlArgument !== undefined && action !== "install") throw new Error("--download-base-url only applies to t3 install");
  const baseUrl = baseUrlArgument === undefined ? undefined : parseT3DownloadBaseUrl(baseUrlArgument);
  const config = await loadConfig(resolveConfigPath(args.positionals[1]));
  const runtimeDir = defaultT3RuntimeDir(config.dataDir);
  if (action === "install") {
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
  // Managed mode, the supervisor, and token fields arrive with the config union (PR-O O2/O3).
  const status = await inspectInstalledT3({ pin: PINNED_T3, runtimeDir });
  console.log(JSON.stringify({ mode: "external", ...status }, null, 2));
  return 0;
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
