// `agent-tag tasks list|close` (PR-N1): DB-only, so it works while the service or T3 is down.
import { resolve } from "node:path";

import { parseArguments } from "./cli-args.ts";
import { resolveConfigPath } from "./cli-commands.ts";
import { loadConfig } from "./config.ts";
import { AgentTagStore, type TaskSummary } from "./store/store.ts";

export const TASKS_USAGE =
  "usage: agent-tag tasks list [CONFIG] [--state active|closed] [--limit N] [--json] | agent-tag tasks close TASK_ID [CONFIG]";

export interface TasksCommandOptions {
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

export async function runTasksCommand(argv: readonly string[], options: TasksCommandOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const args = parseArguments(argv, { booleans: ["json"], values: ["state", "limit"] });
  const [action, ...rest] = args.positionals;
  if (action === "list") {
    const state = args.values.get("state");
    if (state !== undefined && state !== "active" && state !== "closed") throw new Error(`--state must be active or closed\n${TASKS_USAGE}`);
    const limit = Number(args.values.get("limit") ?? "100");
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer\n${TASKS_USAGE}`);
    if (rest.length > 1) throw new Error(TASKS_USAGE);
    const tasks = await withStore(rest[0], (store) => store.listTasks({ ...(state === undefined ? {} : { state }), limit }));
    if (args.flags.has("json")) write(JSON.stringify(tasks, null, 2));
    else for (const line of formatTasks(tasks)) write(line);
    return 0;
  }
  if (action === "close") {
    const [taskId, configPath, ...extra] = rest;
    if (taskId === undefined || extra.length > 0 || args.values.size > 0 || args.flags.size > 0) throw new Error(TASKS_USAGE);
    const result = await withStore(configPath, (store) =>
      store.requestTaskClose({ taskId, reason: "admin", actorId: "cli", now: now().toISOString() }));
    if (result.kind === "closed") {
      write(`closed ${taskId} (generation ${result.generation}); the next reply in its thread starts a new session`);
      return 0;
    }
    if (result.kind === "requested") {
      write(`close requested for ${taskId}; it closes once its in-flight work settles`);
      return 0;
    }
    write(`no active task ${taskId}`);
    return 1;
  }
  throw new Error(TASKS_USAGE);
}

async function withStore<T>(configArgument: string | undefined, run: (store: AgentTagStore) => T): Promise<T> {
  const config = await loadConfig(resolveConfigPath(configArgument));
  const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
  try {
    return run(store);
  } finally {
    store.close();
  }
}

export function formatTasks(tasks: readonly TaskSummary[]): readonly string[] {
  if (tasks.length === 0) return ["no tasks"];
  return [
    "TASK                                  STATE   GEN  LAST ACTIVITY             THREAD                    CLOSE",
    ...tasks.map((task) =>
      [
        task.taskId.padEnd(37),
        task.state.padEnd(7),
        String(task.generation).padEnd(4),
        task.lastActivityAt.padEnd(25),
        `${task.conversationId}/${task.threadTs}`.padEnd(25),
        task.state === "closed"
          ? (task.closeReason ?? "-")
          : (task.closeRequestedAt === null ? "-" : `requested (${task.closeReason ?? "admin"})`),
      ].join(" ")),
  ];
}
