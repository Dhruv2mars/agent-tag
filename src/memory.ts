import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore, MemoryRecord } from "./store/store.ts";

export interface MemoryContext {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly taskId?: string;
  readonly conversationType: "channel" | "dm";
}

export type MemoryMutationResult =
  | { readonly kind: "accepted"; readonly memory: MemoryRecord }
  | { readonly kind: "denied"; readonly reason: string };

export class AgentTagMemory {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;

  constructor(input: { readonly config: AgentTagConfig; readonly store: AgentTagStore }) {
    this.#config = input.config;
    this.#store = input.store;
  }

  create(input: {
    readonly context: MemoryContext;
    readonly scope: "shared" | "profile" | "task" | "private";
    readonly content: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly now: string;
  }): MemoryMutationResult {
    const authorized = this.#authorizeContext(input.context);
    if (authorized.kind === "denied") {
      return this.#deny(input.context, input.sourceId, authorized.reason, input.now);
    }
    if (input.scope === "shared" && !authorized.profile.memory.shared) {
      return this.#deny(input.context, input.sourceId, "shared-memory-disabled", input.now);
    }
    if (input.scope === "private") {
      if (input.context.conversationType !== "dm") {
        return this.#deny(input.context, input.sourceId, "private-memory-requires-dm", input.now);
      }
      if (!authorized.profile.memory.privateDm) {
        return this.#deny(input.context, input.sourceId, "private-memory-disabled", input.now);
      }
    }
    if (input.scope === "task" && input.context.taskId === undefined) {
      return this.#deny(input.context, input.sourceId, "task-required", input.now);
    }
    const expiresAt = new Date(
      new Date(input.now).getTime() + authorized.profile.memory.retentionDays * 86_400_000,
    ).toISOString();
    const memory = this.#store.createMemory({
      workspaceId: input.context.workspaceId,
      scope: input.scope,
      ...(input.scope === "profile" || input.scope === "private"
        ? { profileId: input.context.profileId }
        : {}),
      ...(input.scope === "task" && input.context.taskId !== undefined
        ? { taskId: input.context.taskId }
        : {}),
      ...(input.scope === "private" ? { ownerUserId: input.context.actorUserId } : {}),
      content: input.content,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      actorUserId: input.context.actorUserId,
      expiresAt,
      now: input.now,
    });
    return { kind: "accepted", memory };
  }

  list(input: { readonly context: MemoryContext; readonly now: string; readonly limit?: number }): ReadonlyArray<MemoryRecord> {
    const authorized = this.#authorizeContext(input.context);
    if (authorized.kind === "denied") return [];
    return this.#store.listMemory({
      workspaceId: input.context.workspaceId,
      profileId: input.context.profileId,
      ...(input.context.taskId === undefined ? {} : { taskId: input.context.taskId }),
      ownerUserId: input.context.actorUserId,
      includeShared: authorized.profile.memory.shared,
      includePrivate:
        input.context.conversationType === "dm" && authorized.profile.memory.privateDm,
      now: input.now,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  edit(input: {
    readonly context: MemoryContext;
    readonly memoryId: string;
    readonly content: string;
    readonly now: string;
  }): MemoryMutationResult {
    const memory = this.#store.getMemory(input.memoryId);
    if (memory === null || !this.#canAccess(input.context, memory)) {
      return this.#deny(input.context, input.memoryId, "memory-denied", input.now);
    }
    return {
      kind: "accepted",
      memory: this.#store.updateMemory({
        memoryId: input.memoryId,
        actorUserId: input.context.actorUserId,
        content: input.content,
        now: input.now,
      }),
    };
  }

  forget(input: {
    readonly context: MemoryContext;
    readonly memoryId: string;
    readonly now: string;
  }): { readonly kind: "accepted" | "denied"; readonly reason?: string } {
    const memory = this.#store.getMemory(input.memoryId);
    if (memory === null || !this.#canAccess(input.context, memory)) {
      return this.#deny(input.context, input.memoryId, "memory-denied", input.now);
    }
    this.#store.forgetMemory({
      memoryId: input.memoryId,
      actorUserId: input.context.actorUserId,
      now: input.now,
    });
    return { kind: "accepted" };
  }

  #authorizeContext(context: MemoryContext):
    | { readonly kind: "accepted"; readonly profile: AgentTagConfig["profiles"][number] }
    | { readonly kind: "denied"; readonly reason: string } {
    if (context.workspaceId !== this.#config.slack.workspaceId) {
      return { kind: "denied", reason: "workspace-denied" };
    }
    if (!this.#config.access.allowedUserIds.includes(context.actorUserId)) {
      return { kind: "denied", reason: "user-denied" };
    }
    const profile = this.#config.profiles.find((candidate) => candidate.id === context.profileId);
    if (profile === undefined) return { kind: "denied", reason: "profile-denied" };
    if (
      context.taskId !== undefined &&
      !this.#store.taskBelongsToContext({
        taskId: context.taskId,
        workspaceId: context.workspaceId,
        profileId: context.profileId,
      })
    ) {
      return { kind: "denied", reason: "task-denied" };
    }
    return { kind: "accepted", profile };
  }

  #canAccess(context: MemoryContext, memory: MemoryRecord): boolean {
    const authorized = this.#authorizeContext(context);
    if (authorized.kind === "denied" || memory.workspaceId !== context.workspaceId) return false;
    switch (memory.scope) {
      case "shared":
        return authorized.profile.memory.shared;
      case "profile":
        return memory.profileId === context.profileId;
      case "task":
        return context.taskId !== undefined && memory.taskId === context.taskId;
      case "private":
        return (
          context.conversationType === "dm" &&
          authorized.profile.memory.privateDm &&
          memory.profileId === context.profileId &&
          memory.ownerUserId === context.actorUserId
        );
    }
  }

  #deny(
    context: MemoryContext,
    sourceId: string,
    reason: string,
    now: string,
  ): { readonly kind: "denied"; readonly reason: string } {
    this.#store.recordMemoryDenial({
      actorUserId: context.actorUserId,
      sourceId,
      reason,
      workspaceId: context.workspaceId,
      now,
    });
    return { kind: "denied", reason };
  }
}
