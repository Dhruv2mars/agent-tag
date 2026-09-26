import { resolve } from "node:path";

import { loadConfig } from "./config.ts";
import { createAgentTagService, diagnoseAgentTag } from "./service.ts";
import { AgentTagSchedules } from "./scheduler.ts";
import { AgentTagStore } from "./store/store.ts";

function usage(): never {
  throw new Error(
    "usage: agent-tag <run|doctor|audit|backup> CONFIG [ARG] | agent-tag restore BACKUP NEW_DATA_DIR | agent-tag schedule-<add|list|cancel> CONFIG TASK ACTOR PROFILE [SPEC_OR_ID]",
  );
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveSignal();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

const command = process.argv[2];
const configArgument = process.argv[3];
if (configArgument === undefined) usage();

if (command === "restore") {
  const destinationDirectory = process.argv[4];
  if (destinationDirectory === undefined) usage();
  await AgentTagStore.restoreBackup({
    backupPath: resolve(configArgument),
    destinationPath: resolve(destinationDirectory, "agent-tag.sqlite"),
  });
} else {
  if (
    command !== "run" &&
    command !== "doctor" &&
    command !== "audit" &&
    command !== "backup" &&
    command !== "schedule-add" &&
    command !== "schedule-list" &&
    command !== "schedule-cancel"
  ) usage();
  const config = await loadConfig(resolve(configArgument));
  if (command === "doctor") {
    console.log(JSON.stringify(await diagnoseAgentTag(config), null, 2));
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
    await waitForShutdownSignal();
    await service.stop();
  }
}
