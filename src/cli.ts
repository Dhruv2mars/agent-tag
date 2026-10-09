#!/usr/bin/env bun
import { resolve } from "node:path";

import { runDoctorCommand, runOnboardCommand, runServiceCommand, runT3Command } from "./cli-commands.ts";
import { loadConfig } from "./config.ts";
import { isDistributionCommand, processDistributionContext, runDistributionCommand } from "./distribution.ts";
import { runSecurityCli, SECURITY_CLI_USAGE } from "./security/cli.ts";
import { createAgentTagService } from "./service.ts";
import { AgentTagSchedules } from "./scheduler.ts";
import { AgentTagStore } from "./store/store.ts";
import { T3_FATAL_EXIT_CODE, waitForShutdownOrFatal } from "./t3/operator.ts";

// One leading "usage: agent-tag" line, continuation lines aligned under it.
const USAGE = [
  "usage: agent-tag onboard [--yes --accept-risk ...]",
  "       agent-tag doctor [CONFIG] [--fix] [--json]",
  "       agent-tag service <install|upgrade|uninstall|status|restart|logs> [CONFIG] [--lines N] [--follow]",
  "       agent-tag t3 <install|status> [CONFIG] [--download-base-url URL]",
  "       agent-tag t3 <serve|pair> [CONFIG] [--allow-non-tty]",
  "       agent-tag <run|status|audit|backup> CONFIG [ARG]",
  "       agent-tag restore BACKUP NEW_DATA_DIR",
  "       agent-tag schedule-<add|list|cancel> CONFIG TASK ACTOR PROFILE [SPEC_OR_ID]",
  "       agent-tag <version|update|help>",
  ...SECURITY_CLI_USAGE.split(" | ").map((line) => `       ${line}`),
].join("\n");

const KNOWN_COMMANDS = new Set([
  "onboard",
  "doctor",
  "service",
  "t3",
  "run",
  "status",
  "audit",
  "backup",
  "restore",
  "schedule-add",
  "schedule-list",
  "schedule-cancel",
]);

/** Prints a usage error without a stack trace and exits, like runDistributionCommand. */
function usage(problem?: string): never {
  process.stderr.write(`${problem === undefined ? "" : `agent-tag: ${problem}\n`}${USAGE}\nRun \`agent-tag help\` for details.\n`);
  process.exit(1);
}

const command = process.argv[2];
if (isDistributionCommand(command)) {
  process.exit(await runDistributionCommand(process.argv.slice(2), processDistributionContext()));
}
if (command === "security" || command === "prune") {
  let exitCode: number;
  try {
    exitCode = await runSecurityCli(process.argv.slice(2));
  } catch (error) {
    // Argument mistakes print usage like other commands; anything else keeps its stack trace.
    if (!(error instanceof Error && error.message.includes(SECURITY_CLI_USAGE))) throw error;
    usage(error.message.slice(0, error.message.indexOf("usage:")).replace(/[;:\s]+$/, "") || `invalid ${command} arguments`);
  }
  process.exit(exitCode);
}
if (command === undefined || !KNOWN_COMMANDS.has(command)) usage(`unknown command: ${String(command)}`);
const configArgument = process.argv[3];

const operatorCommands = new Map<string, (argv: readonly string[]) => Promise<number>>([
  ["onboard", runOnboardCommand],
  ["doctor", runDoctorCommand],
  ["service", runServiceCommand],
  ["t3", runT3Command],
]);
const operatorCommand = operatorCommands.get(command);

if (operatorCommand !== undefined) {
  try {
    process.exitCode = await operatorCommand(process.argv.slice(3));
  } catch (error) {
    console.error(`agent-tag ${command}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (configArgument === undefined) {
  usage(`${command} requires an argument`);
} else if (command === "restore") {
  const destinationDirectory = process.argv[4];
  if (destinationDirectory === undefined) usage();
  await AgentTagStore.restoreBackup({
    backupPath: resolve(configArgument),
    destinationPath: resolve(destinationDirectory, "agent-tag.sqlite"),
  });
} else {
  if (
    command !== "run" &&
    command !== "status" &&
    command !== "audit" &&
    command !== "backup" &&
    command !== "schedule-add" &&
    command !== "schedule-list" &&
    command !== "schedule-cancel"
  ) usage();
  const config = await loadConfig(resolve(configArgument));
  if (command === "status") {
    const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
    try {
      console.log(JSON.stringify(store.operationalStatus(new Date().toISOString()), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "audit") {
    const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
    try {
      let after: { readonly createdAt: string; readonly auditId: string } | undefined;
      while (true) {
        const records = store.listAuditRecords({ ...(after === undefined ? {} : { after }), limit: 1_000 });
        for (const record of records) console.log(JSON.stringify(record));
        const last = records.at(-1);
        if (last === undefined || records.length < 1_000) break;
        after = { createdAt: last.createdAt, auditId: last.auditId };
      }
    } finally {
      store.close();
    }
  } else if (command === "backup") {
    const destination = process.argv[4];
    if (destination === undefined) usage();
    const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
    try {
      await store.backupTo(resolve(destination));
    } finally {
      store.close();
    }
  } else if (command === "schedule-add" || command === "schedule-list" || command === "schedule-cancel") {
    const taskId = process.argv[4];
    const actorUserId = process.argv[5];
    const profileId = process.argv[6];
    if (taskId === undefined || actorUserId === undefined || profileId === undefined) usage();
    const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
    try {
      const schedules = new AgentTagSchedules({ config, store });
      const context = {
        workspaceId: config.slack.workspaceId,
        actorUserId,
        profileId,
        taskId,
      };
      if (command === "schedule-list") {
        console.log(JSON.stringify(schedules.list(context), null, 2));
      } else if (command === "schedule-add") {
        const specPath = process.argv[7];
        if (specPath === undefined) usage();
        const spec: unknown = await Bun.file(resolve(specPath)).json();
        console.log(
          JSON.stringify(
            schedules.create({ context, spec, now: new Date().toISOString() }),
            null,
            2,
          ),
        );
      } else {
        const scheduleId = process.argv[7];
        if (scheduleId === undefined) usage();
        console.log(
          JSON.stringify(
            schedules.cancel({ context, scheduleId, now: new Date().toISOString() }),
            null,
            2,
          ),
        );
      }
    } finally {
      store.close();
    }
  } else {
    const service = await createAgentTagService({ config });
    await service.start();
    // A managed T3 crash loop stops the service with EX_TEMPFAIL so launchd/systemd restart it.
    const reason = await waitForShutdownOrFatal((listener) => service.onFatal(listener));
    await service.stop();
    if (reason === "fatal") process.exit(T3_FATAL_EXIT_CODE);
  }
}
