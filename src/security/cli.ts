import { join, resolve } from "node:path";

import { loadConfig } from "../config.ts";
import { pruneDatabaseFile, retentionCutoffs, retentionEnabled } from "../store/retention.ts";
import { AgentTagStore } from "../store/store.ts";
import { formatSecurityReport } from "./audit.ts";
import { runSecurityAudit } from "./audit-run.ts";

export const SECURITY_CLI_USAGE =
  "agent-tag security audit CONFIG [--json] [--offline] [--log-dir DIR] | agent-tag prune CONFIG [--dry-run]";

/** Parses `--flag`, `--option VALUE`, and `--option=VALUE`. Unknown options and missing values throw. */
export function parseCliArguments(
  argv: ReadonlyArray<string>,
  allowedFlags: ReadonlyArray<string>,
  valueOptions: ReadonlyArray<string> = [],
): {
  readonly positionals: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
} {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (valueOptions.includes(name)) {
      const value = separator === -1 ? argv[(index += 1)] : argument.slice(separator + 1);
      if (value === undefined || value === "" || (separator === -1 && value.startsWith("--"))) {
        throw new Error(`option ${name} needs a value; usage: ${SECURITY_CLI_USAGE}`);
      }
      values.set(name, value);
    } else if (separator === -1 && allowedFlags.includes(argument)) {
      flags.add(argument);
    } else {
      throw new Error(`unknown option ${argument}; usage: ${SECURITY_CLI_USAGE}`);
    }
  }
  return { positionals, flags, values };
}

/** Handles `security audit` and `prune`. `argv` starts at the command name. Returns the process exit code. */
export async function runSecurityCli(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "security") {
    const { positionals, flags, values } = parseCliArguments(rest, ["--json", "--offline"], ["--log-dir"]);
    const [subcommand, configPath] = positionals;
    if (subcommand !== "audit" || configPath === undefined || positionals.length !== 2) {
      throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
    }
    const logDirectory = values.get("--log-dir");
    const report = await runSecurityAudit({
      configPath: resolve(configPath),
      offline: flags.has("--offline"),
      ...(logDirectory === undefined ? {} : { logDirectory: resolve(logDirectory) }),
    });
    console.log(flags.has("--json") ? JSON.stringify(report, null, 2) : formatSecurityReport(report));
    return report.result === "fail" ? 1 : 0;
  }
  if (command === "prune") {
    const { positionals, flags } = parseCliArguments(rest, ["--dry-run"]);
    const [configPath] = positionals;
    if (configPath === undefined || positionals.length !== 1) throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
    const config = await loadConfig(resolve(configPath));
    const databasePath = join(config.dataDir, "agent-tag.sqlite");
    const dryRun = flags.has("--dry-run");
    const now = new Date().toISOString();
    const retentionConfigured = retentionEnabled(config.retention);
    if (dryRun) {
      // A preview must not create, migrate, or chmod anything; a store that does not exist has nothing to prune.
      if (!(await Bun.file(databasePath).exists())) {
        const cutoffs = retentionCutoffs(config.retention, now);
        const empty = { dryRun, cutoffs, auditDeleted: 0, outboxRedacted: 0, eventsRedacted: 0, operationsRedacted: 0,
          schedulesRedacted: 0, notesRedacted: 0, notesDeleted: 0 };
        console.log(JSON.stringify({ retentionConfigured, storeExists: false, ...empty }, null, 2));
        return 0;
      }
    } else {
      // Opening through the store applies migrations and enforces the private data directory first.
      (await AgentTagStore.open(databasePath)).close();
    }
    const result = pruneDatabaseFile(databasePath, { policy: config.retention, now, dryRun });
    console.log(JSON.stringify({ retentionConfigured, ...result }, null, 2));
    return 0;
  }
  throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
}
