import { join, resolve } from "node:path";

import { loadConfig } from "../config.ts";
import { pruneDatabaseFile, retentionEnabled } from "../store/retention.ts";
import { AgentTagStore } from "../store/store.ts";
import { formatSecurityReport } from "./audit.ts";
import { runSecurityAudit } from "./audit-run.ts";

export const SECURITY_CLI_USAGE =
  "agent-tag security audit CONFIG [--json] [--offline] | agent-tag prune CONFIG [--dry-run]";

export function parseCliArguments(
  argv: ReadonlyArray<string>,
  allowedFlags: ReadonlyArray<string>,
): { readonly positionals: ReadonlyArray<string>; readonly flags: ReadonlySet<string> } {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const argument of argv) {
    if (argument.startsWith("--")) {
      if (!allowedFlags.includes(argument)) throw new Error(`unknown option ${argument}; usage: ${SECURITY_CLI_USAGE}`);
      flags.add(argument);
    } else {
      positionals.push(argument);
    }
  }
  return { positionals, flags };
}

/** Handles `security audit` and `prune`. `argv` starts at the command name. Returns the process exit code. */
export async function runSecurityCli(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "security") {
    const { positionals, flags } = parseCliArguments(rest, ["--json", "--offline"]);
    const [subcommand, configPath] = positionals;
    if (subcommand !== "audit" || configPath === undefined || positionals.length !== 2) {
      throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
    }
    const report = await runSecurityAudit({ configPath: resolve(configPath), offline: flags.has("--offline") });
    console.log(flags.has("--json") ? JSON.stringify(report, null, 2) : formatSecurityReport(report));
    return report.result === "fail" ? 1 : 0;
  }
  if (command === "prune") {
    const { positionals, flags } = parseCliArguments(rest, ["--dry-run"]);
    const [configPath] = positionals;
    if (configPath === undefined || positionals.length !== 1) throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
    const config = await loadConfig(resolve(configPath));
    const databasePath = join(config.dataDir, "agent-tag.sqlite");
    // Opening through the store applies migrations and enforces the private data directory first.
    (await AgentTagStore.open(databasePath)).close();
    const result = pruneDatabaseFile(databasePath, {
      policy: config.retention,
      now: new Date().toISOString(),
      dryRun: flags.has("--dry-run"),
    });
    console.log(JSON.stringify({ retentionConfigured: retentionEnabled(config.retention), ...result }, null, 2));
    return 0;
  }
  throw new Error(`usage: ${SECURITY_CLI_USAGE}`);
}
