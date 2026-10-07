import { currentBuildInfo, formatBuildInfo, type BuildInfo } from "./version.ts";
import {
  formatUpdateResult,
  parseUpdateArguments,
  releaseBaseUrlFromEnv,
  runUpdate,
  type UpdateDependencies,
} from "./update.ts";

export const HELP_TEXT = `agent-tag: a self-hosted Slack coworker that delegates work to T3 Code agents.

Usage:
  agent-tag onboard [--yes --accept-risk ...]
                                       Set up the Slack app, T3 token, config, and service
  agent-tag doctor [CONFIG] [--fix] [--json]
                                       Check SQLite, T3, providers, Slack, and the service;
                                       --fix repairs permissions and a stale or stopped service
  agent-tag service install|upgrade|uninstall|status|restart [CONFIG]
                                       Manage the per-user service (launchd on macOS, systemd on Linux)
  agent-tag service logs [--lines N] [--follow]
                                       Show the service logs
  agent-tag run CONFIG                 Start the Slack service in the foreground
  agent-tag status CONFIG              Print operational status from the local store
  agent-tag audit CONFIG               Export audit records as JSON lines
  agent-tag backup CONFIG DESTINATION  Write a consistent SQLite backup
  agent-tag restore BACKUP NEW_DATA_DIR
  agent-tag schedule-add CONFIG TASK ACTOR PROFILE SPEC_FILE
  agent-tag schedule-list CONFIG TASK ACTOR PROFILE
  agent-tag schedule-cancel CONFIG TASK ACTOR PROFILE SCHEDULE_ID
  agent-tag version [--json]           Print the version, platform, and install kind
  agent-tag update [--check] [--version X]
                                       Download, verify, and replace this release binary
  agent-tag help                       Show this help

For doctor and service, CONFIG defaults to $AGENT_TAG_CONFIG, then agent-tag.json in $AGENT_TAG_HOME
(default ~/.agent-tag), where onboard writes it.

Docs: https://github.com/Dhruv2mars/agent-tag#readme
`;

export interface DistributionIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface DistributionContext {
  readonly build: BuildInfo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly fetch: UpdateDependencies["fetch"];
  readonly io: DistributionIo;
}

const DISTRIBUTION_COMMANDS = new Set(["help", "--help", "-h", "version", "--version", "-v", "update"]);

export function isDistributionCommand(command: string | undefined): boolean {
  return command === undefined || DISTRIBUTION_COMMANDS.has(command);
}

/** Runs help/version/update. Returns the process exit code. */
export async function runDistributionCommand(
  argv: readonly string[],
  context: DistributionContext,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined) {
      context.io.stderr(HELP_TEXT);
      return 1;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      context.io.stdout(HELP_TEXT);
      return 0;
    }
    if (command === "version" || command === "--version" || command === "-v") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) throw new Error("usage: agent-tag version [--json]");
      context.io.stdout(
        rest[0] === "--json"
          ? `${JSON.stringify({
              version: context.build.version,
              target: context.build.target ?? null,
              commit: context.build.commit ?? null,
              installKind: context.build.installKind,
            })}\n`
          : `${formatBuildInfo(context.build)}\n`,
      );
      return 0;
    }
    if (command === "update") {
      const options = parseUpdateArguments(rest);
      const result = await runUpdate(options, {
        build: context.build,
        execPath: context.execPath,
        releaseBaseUrl: releaseBaseUrlFromEnv(context.env),
        fetch: context.fetch,
        log: (line) => context.io.stderr(`agent-tag: ${line}\n`),
      });
      context.io.stdout(`${formatUpdateResult(result)}\n`);
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    context.io.stderr(`agent-tag: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function processDistributionContext(): DistributionContext {
  return {
    build: currentBuildInfo(),
    env: process.env,
    execPath: process.execPath,
    fetch: (input, init) => fetch(input, init),
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  };
}
