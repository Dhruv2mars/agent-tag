// `agent-tag tasks list|close|cleanup` (PR-N). list, close and `cleanup --dry-run` are DB-only, so
// they work while the service or T3 is down; `cleanup --once` needs T3.
import { resolve } from "node:path";

import { parseArguments } from "./cli-args.ts";
import { resolveConfigPath } from "./cli-commands.ts";
import { type CleanupT3, CleanupWorker, plannedCleanupAction } from "./cleanup-worker.ts";
import { type AgentTagConfig, loadConfig } from "./config.ts";
import { createGitRunner, type GitRunner } from "./git/runner.ts";
import { SessionStopWorker } from "./restart-worker.ts";
import { AgentTagStore, type RetiredThread, type TaskSummary } from "./store/store.ts";
import { T3Connection } from "./t3/connection.ts";

export const TASKS_USAGE =
  "usage: agent-tag tasks list [CONFIG] [--state active|closed] [--limit N] [--json] | agent-tag tasks close TASK_ID [CONFIG]" +
  " | agent-tag tasks cleanup [CONFIG] --dry-run|--once";

export interface TasksCommandOptions {
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
  /** Test seams for `cleanup --once`; default to a T3Connection from the config and the git binary. */
  readonly t3?: (config: AgentTagConfig) => CleanupT3 & { close?: () => Promise<void> };
  readonly git?: GitRunner;
}

export async function runTasksCommand(argv: readonly string[], options: TasksCommandOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const args = parseArguments(argv, { booleans: ["json", "dry-run", "once"], values: ["state", "limit"] });
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
  if (action === "cleanup") {
    const dryRun = args.flags.has("dry-run");
    const once = args.flags.has("once");
    if (rest.length > 1 || args.values.size > 0 || dryRun === once || args.flags.has("json")) throw new Error(TASKS_USAGE);
    const config = await loadConfig(resolveConfigPath(rest[0]));
    const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
    try {
      if (dryRun) {
        const rows = store.listPendingRetiredThreads();
        if (rows.length === 0) write("no retired threads pending cleanup");
        for (const row of rows) write(`${rowLabel(row)}: ${plannedCleanupAction(row, config.lifecycle, now())}`);
        return 0;
      }
      return await cleanupOnce(config, store, options, write, now);
    } finally {
      store.close();
    }
  }
  throw new Error(TASKS_USAGE);
}

/** Stops every due session, then runs one cleanup pass over every due row, with no row limit. */
async function cleanupOnce(
  config: AgentTagConfig,
  store: AgentTagStore,
  options: TasksCommandOptions,
  write: (line: string) => void,
  now: () => Date,
): Promise<number> {
  const t3 = options.t3?.(config) ?? new T3Connection({ config: config.t3, now });
  try {
    const stops = new SessionStopWorker({ store, dispatch: (command) => t3.dispatch(command), now });
    while ((await stops.stopDue(now())) > 0) {
      // Each batch records its rows, so the next call lists only the rest.
    }
    const worker = new CleanupWorker({
      store,
      t3,
      git: options.git ?? createGitRunner(),
      policy: config.lifecycle,
      dataDir: config.dataDir,
      now,
    });
    const result = await worker.runPass({ limit: null });
    for (const row of result.rows) {
      const state = row.completedAt !== null ? "done" : row.retainUntil === null ? "will retry" : `kept until ${row.retainUntil}`;
      const error = row.lastErrorCode === null ? "" : ` (${row.lastErrorCode})`;
      write(`${rowLabel(row)}: worktree ${row.worktreeState}, branch ${row.branchState}, ${state}${error}`);
    }
    write(`cleanup: ${result.completed} done, ${result.deferred} waiting, ${result.claimed - result.completed - result.deferred} skipped`);
    return result.rows.some((row) => row.worktreeState === "failed" || row.branchState === "failed") ? 1 : 0;
  } finally {
    await t3.close?.();
  }
}

function rowLabel(row: RetiredThread): string {
  return `${row.taskId} g${row.generation} (${row.reason})`;
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
