import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseArguments } from "./cli-args.ts";
import { runCommand } from "./command.ts";
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

const repositoryRoot = resolve(import.meta.dir, "..");

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
      template: await Bun.file(join(repositoryRoot, "config", "agent-tag.example.json")).json(),
      manifest: await Bun.file(join(repositoryRoot, "config", "slack-manifest.example.json")).json(),
    });
  } finally {
    prompter.close();
  }
  return 0;
}
