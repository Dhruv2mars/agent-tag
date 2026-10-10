// Command authority (PR-H §3.5). The router has already enforced what messaging the bot needs
// (workspace, channel, user allowlist, route, DM owner); this adds the command policy on top.
import type { AgentTagConfig, AgentTagProfile } from "../config.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "../policy/execution.ts";
import type { AgentTagStore, TaskExecutionBinding } from "../store/store.ts";
import type { CommandContext } from "./context.ts";
import type { AgentCommandName } from "./parse.ts";

export type CommandDenialReason = "command-disabled" | "admin-required" | "task-authority";

export type CommandAuthorization =
  | { readonly kind: "allowed"; readonly profile: AgentTagProfile; readonly task: TaskExecutionBinding | null }
  | { readonly kind: "denied"; readonly reason: CommandDenialReason };

export function isCommandDisabled(config: AgentTagConfig, command: AgentCommandName): boolean {
  return (config.commands.disabled as ReadonlyArray<AgentCommandName>).includes(command);
}

export function isCommandAdminOnly(config: AgentTagConfig, command: AgentCommandName): boolean {
  return (config.commands.adminOnly as ReadonlyArray<AgentCommandName>).includes(command);
}

export function authorizeCommand(input: {
  readonly config: AgentTagConfig;
  readonly store: Pick<AgentTagStore, "getTaskExecution">;
  readonly ctx: CommandContext;
  readonly command: AgentCommandName;
}): CommandAuthorization {
  const { config, ctx, command } = input;
  if (isCommandDisabled(config, command)) return { kind: "denied", reason: "command-disabled" };
  if (isCommandAdminOnly(config, command) && !config.access.adminUserIds.includes(ctx.actorUserId)) {
    return { kind: "denied", reason: "admin-required" };
  }
  if (ctx.binding !== null) {
    // The check turns, schedules and the outbox use, so a route change or user removal applies at once.
    try {
      const task = input.store.getTaskExecution(ctx.binding.taskId);
      const profile = requireExecutionAuthority({ config, task, actorUserId: ctx.actorUserId });
      return { kind: "allowed", profile, task };
    } catch (error) {
      if (error instanceof ExecutionAuthorityDenied) return { kind: "denied", reason: "task-authority" };
      throw error;
    }
  }
  const profile = config.profiles.find((candidate) => candidate.id === ctx.profileId);
  if (profile === undefined) throw new Error(`validated route references missing profile ${ctx.profileId}`);
  return { kind: "allowed", profile, task: null };
}
