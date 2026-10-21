import type { AgentTagConfig } from "../config.ts";
import type { TaskExecutionBinding } from "../store/store.ts";
import { type AccessDenialReason, type AccessPurpose, isAllowlisted, isSteeringAllowed, resolveRoute } from "./access.ts";

export class ExecutionAuthorityDenied extends Error {
  /** The access predicate's reason, when the actor (not the task binding) was denied. */
  readonly reason: AccessDenialReason | "task-route-denied";

  constructor(reason: AccessDenialReason | "task-route-denied" = "task-route-denied") {
    super("Current configuration no longer authorizes this task or actor");
    this.name = "ExecutionAuthorityDenied";
    this.reason = reason;
  }
}

export function requireTaskAuthority(input: {
  readonly config: AgentTagConfig;
  readonly task: TaskExecutionBinding;
}): AgentTagConfig["profiles"][number] {
  const { config, task } = input;
  const profile = config.profiles.find((candidate) => candidate.id === task.profileId);
  // An auto-routed DM has no configured route; it is rebuilt from the task's recorded owner.
  const route = resolveRoute(config, task.conversationId, task.ownerUserId);
  const configured = config.routes.some((candidate) => candidate.conversationId === task.conversationId);
  if (
    task.workspaceId !== config.slack.workspaceId ||
    (configured && !config.access.allowedChannelIds.includes(task.conversationId)) ||
    profile === undefined ||
    route === undefined ||
    route.profileId !== task.profileId ||
    route.conversationType !== task.conversationType ||
    !profile.repositoryRoots.includes(task.repositoryRoot) ||
    (route.repositoryRoot ?? profile.repositoryRoots[0]) !== task.repositoryRoot ||
    (route.conversationType === "dm" &&
      (config.access.directMessages.mode === "off" ||
        route.ownerUserId !== task.ownerUserId ||
        !isAllowlisted(config, route.ownerUserId) ||
        !profile.memory.privateDm))
  ) {
    throw new ExecutionAuthorityDenied();
  }
  return profile;
}

/**
 * Re-checks, at execution time, that the actor may still act on the task (the same predicate as ingress,
 * so a removed user or one who left the channel is revoked), then that the task's binding still holds.
 */
export function requireExecutionAuthority(input: {
  readonly config: AgentTagConfig;
  readonly task: TaskExecutionBinding;
  readonly actorUserId: string;
  /** Defaults to `execute`. Interaction responses re-check as `approve` / `answer`. */
  readonly purpose?: AccessPurpose;
}): AgentTagConfig["profiles"][number] {
  const decision = isSteeringAllowed({
    config: input.config,
    workspaceId: input.task.workspaceId,
    conversationId: input.task.conversationId,
    userId: input.actorUserId,
    purpose: input.purpose ?? "execute",
    dmOwnerUserId: input.task.ownerUserId,
  });
  if (!decision.allowed) throw new ExecutionAuthorityDenied(decision.reason);
  if (input.task.conversationType === "dm" && input.actorUserId !== input.task.ownerUserId) {
    throw new ExecutionAuthorityDenied("dm-owner-denied");
  }
  return requireTaskAuthority(input);
}
