// `agent-tag memory-list|add|edit|forget` (PR-K3): the operator's view of memory. Opens the store
// directly (WAL-safe beside the running service), bypasses Slack visibility, audits as `operator`.
import { userInfo } from "node:os";
import { resolve } from "node:path";

import { parseArguments } from "./cli-args.ts";
import { loadConfig } from "./config.ts";
import { AgentTagMemory, MEMORY_SCOPE_NAMES, type MemoryRefMutationResult, type MemoryScopeName, type OperatorContext } from "./memory.ts";
import { AgentTagStore, type MemoryRecord } from "./store/store.ts";

export const MEMORY_COMMANDS = ["memory-list", "memory-add", "memory-edit", "memory-forget"] as const;
export type MemoryCommand = (typeof MEMORY_COMMANDS)[number];

export const MEMORY_USAGE = [
  "usage: agent-tag memory-list CONFIG [--conversation ID] [--scope channel|workspace|dm|operator|task] [--json]",
  "agent-tag memory-add CONFIG --scope channel|workspace|operator --content TEXT [--conversation ID] [--profile ID]",
  "agent-tag memory-edit CONFIG MEMORY_ID --content TEXT",
  "agent-tag memory-forget CONFIG MEMORY_ID",
  "agent-tag memory-forget CONFIG --conversation ID --all [--yes]",
].join(" | ");

const LABELS: Readonly<Record<MemoryRecord["scope"], MemoryScopeName>> = {
  channel: "channel",
  shared: "workspace",
  private: "dm",
  profile: "operator",
  task: "task",
};

export interface MemoryCommandOptions {
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
  /** The audit actor; defaults to the local account name. */
  readonly operatorId?: string;
}

function isScopeName(value: string): value is MemoryScopeName {
  return Object.hasOwn(MEMORY_SCOPE_NAMES, value);
}

export async function runMemoryCommand(
  command: MemoryCommand,
  argv: readonly string[],
  options: MemoryCommandOptions = {},
): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const now = (options.now ?? (() => new Date()))().toISOString();
  const args = parseArguments(argv, { booleans: ["json", "all", "yes"], values: ["conversation", "scope", "content", "profile"] });
  const [configPath, ...positionals] = args.positionals;
  const fail = (problem: string): never => {
    throw new Error(`${problem}\n${MEMORY_USAGE}`);
  };
  const allowOnly = (values: readonly string[], flags: readonly string[], positionalCount: number) => {
    const extra = [...args.values.keys()].find((name) => !values.includes(name)) ?? [...args.flags].find((name) => !flags.includes(name));
    if (extra !== undefined) fail(`--${extra} does not apply to ${command}`);
    if (positionals.length !== positionalCount) fail(`${command} takes ${positionalCount === 0 ? "no" : positionalCount} argument${positionalCount === 1 ? "" : "s"} after CONFIG`);
  };
  if (configPath === undefined) fail(`${command} requires CONFIG`);
  const config = await loadConfig(resolve(configPath!));
  const store = await AgentTagStore.open(resolve(config.dataDir, "agent-tag.sqlite"));
  try {
    const memory = new AgentTagMemory({ config, store });
    const context: OperatorContext = { workspaceId: config.slack.workspaceId, operatorId: options.operatorId ?? operatorName() };
    const conversationId = args.values.get("conversation");
    const content = args.values.get("content");

    if (command === "memory-list") {
      allowOnly(["conversation", "scope"], ["json"], 0);
      const scope = args.values.get("scope");
      if (scope !== undefined && !isScopeName(scope)) fail("--scope must be channel, workspace, dm, operator or task");
      const notes = memory.operatorList({
        context,
        ...(scope === undefined ? {} : { scope: scope as MemoryScopeName }),
        ...(conversationId === undefined ? {} : { conversationId }),
        now,
      });
      if (args.flags.has("json")) {
        write(JSON.stringify(notes.map((note) => ({ ref: note.memoryId.slice(0, 8), store: LABELS[note.scope], ...note })), null, 2));
      } else {
        for (const line of formatMemory(notes)) write(line);
      }
      return 0;
    }

    if (command === "memory-add") {
      allowOnly(["conversation", "scope", "content", "profile"], [], 0);
      const scope = args.values.get("scope");
      if (scope !== "channel" && scope !== "workspace" && scope !== "operator") fail("--scope must be channel, workspace or operator");
      if (content === undefined) fail("memory-add requires --content");
      const profileId = args.values.get("profile");
      const result = memory.operatorCreate({
        context,
        scope: scope as "channel" | "workspace" | "operator",
        content: content!,
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(profileId === undefined ? {} : { profileId }),
        now,
      });
      if (result.kind === "denied") {
        write(`refused: ${result.reason}`);
        return 1;
      }
      const ref = result.memory.memoryId.slice(0, 8);
      write(result.kind === "duplicate" ? `already saved as ${ref} (${where(result.memory)})` : `saved ${ref} (${where(result.memory)}, expires ${result.memory.expiresAt.slice(0, 10)})`);
      return 0;
    }

    if (command === "memory-edit") {
      allowOnly(["content"], [], 1);
      if (content === undefined) fail("memory-edit requires --content");
      return report(memory.operatorEdit({ context, ref: positionals[0]!, content: content!, now }), (note) => `updated ${note.memoryId.slice(0, 8)} (version ${note.version})`, write);
    }

    if (args.flags.has("all")) {
      allowOnly(["conversation"], ["all", "yes"], 0);
      if (conversationId === undefined) fail("--all requires --conversation");
      if (!args.flags.has("yes")) {
        const count = memory.operatorList({ context, conversationId: conversationId!, now }).length;
        write(`would forget ${count} note${count === 1 ? "" : "s"} stored for ${conversationId}; rerun with --yes`);
        return count === 0 ? 0 : 1;
      }
      const forgotten = memory.operatorForgetConversation({ context, conversationId: conversationId!, now });
      write(`forgot ${forgotten.length} note${forgotten.length === 1 ? "" : "s"} stored for ${conversationId}`);
      return 0;
    }
    allowOnly([], [], 1);
    return report(memory.operatorForget({ context, ref: positionals[0]!, now }), (note) => `forgot ${note.memoryId.slice(0, 8)}`, write);
  } finally {
    store.close();
  }
}

function report(result: MemoryRefMutationResult, done: (memory: MemoryRecord) => string, write: (line: string) => void): number {
  switch (result.kind) {
    case "accepted":
      write(done(result.memory));
      return 0;
    case "not-found":
      write("no active note with that ID");
      return 1;
    case "ambiguous":
      write(`ambiguous ID; matches ${result.candidates.join(", ")}`);
      return 1;
    case "denied":
      write(`refused: ${result.reason}`);
      return 1;
  }
}

function operatorName(): string {
  try {
    return userInfo().username || "operator";
  } catch {
    return "operator";
  }
}

/** Where a note is stored, as the operator would name it. */
function where(note: MemoryRecord): string {
  switch (note.scope) {
    case "channel":
      return `channel ${note.conversationId}`;
    case "shared":
      return "workspace";
    case "private":
      return `dm ${note.profileId}/${note.ownerUserId}`;
    case "profile":
      return `operator ${note.profileId}`;
    case "task":
      return `task ${note.taskId}`;
  }
}

export function formatMemory(notes: readonly MemoryRecord[]): readonly string[] {
  if (notes.length === 0) return ["no notes"];
  return [
    "REF      STORE      WHERE                          AUTHOR          UPDATED     EXPIRES     CONTENT",
    ...notes.map((note) =>
      [
        note.memoryId.slice(0, 8),
        LABELS[note.scope].padEnd(10),
        (where(note).replace(/^\S+ ?/, "") || "-").padEnd(30),
        (note.updatedBy ?? note.createdBy).padEnd(15),
        note.updatedAt.slice(0, 10).padEnd(11),
        note.expiresAt.slice(0, 10).padEnd(11),
        oneLine(note.content),
      ].join(" ")),
  ];
}

function oneLine(content: string): string {
  const flat = content.replace(/\s+/g, " ");
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
