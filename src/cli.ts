import { resolve } from "node:path";

import { loadConfig } from "./config.ts";
import { createAgentTagService, diagnoseAgentTag } from "./service.ts";

function usage(): never {
  throw new Error("usage: agent-tag <run|doctor> /absolute/path/to/config.json");
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
if ((command !== "run" && command !== "doctor") || configArgument === undefined) usage();

const config = await loadConfig(resolve(configArgument));
if (command === "doctor") {
  console.log(JSON.stringify(await diagnoseAgentTag(config), null, 2));
} else {
  const service = await createAgentTagService({ config });
  await service.start();
  await waitForShutdownSignal();
  await service.stop();
}
