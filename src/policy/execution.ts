import type { AgentTagConfig } from "../config.ts";
import type { TaskExecutionBinding } from "../store/store.ts";

export class ExecutionAuthorityDenied extends Error {
  constructor() {
    super("Current configuration no longer authorizes this task or actor");
    this.name = "ExecutionAuthorityDenied";
  }
}

export function requireExecutionAuthority(input: {
  readonly config: AgentTagConfig;
  readonly task: TaskExecutionBinding;
  readonly actorUserId: string;
}): AgentTagConfig["profiles"][number] {
  const { config, task, actorUserId } = input;
  const profile = config.profiles.find((candidate) => candidate.id === task.profileId);
  const route = config.routes.find((candidate) => candidate.conversationId === task.conversationId);
  if (
    task.workspaceId !== config.slack.workspaceId ||
    !config.access.allowedUserIds.includes(actorUserId) ||
    !config.access.allowedChannelIds.includes(task.conversationId) ||
    profile === undefined ||
    route === undefined ||
    route.profileId !== task.profileId ||
    route.conversationType !== task.conversationType ||
    !profile.repositoryRoots.includes(task.repositoryRoot) ||
    (route.repositoryRoot ?? profile.repositoryRoots[0]) !== task.repositoryRoot ||
    (route.conversationType === "dm" &&
      (route.ownerUserId !== task.ownerUserId || actorUserId !== task.ownerUserId || !profile.memory.privateDm))
  ) {
    throw new ExecutionAuthorityDenied();
  }
  return profile;
}
