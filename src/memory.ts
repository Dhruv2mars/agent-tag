import type { AgentTagConfig } from "./config.ts";
import { type AccessDecision, isAllowlisted, isSteeringAllowed } from "./policy/access.ts";
import { containsKnownSecret } from "./security/redact.ts";
import { normalizeMemoryRef, type MemoryAuditActor, type MemoryStoreKey } from "./store/memory.ts";
import type { AgentTagStore, MemoryRecord } from "./store/store.ts";

// Scope model (PR-K): channel notes → `channel` (keyed by conversation), workspace notes → `shared`,
// 1:1 DM notes → `private` (profile + owner), operator notes → `profile` (CLI only), task notes → `task`.

/** How a Slack conversation is visible; only `public` channels may write workspace notes. */
export type ConversationVisibility = "public" | "private" | "dm" | "unknown";

export interface MemoryContext {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly profileId: string;
  /** The Slack conversation; required for channel notes. */
  readonly conversationId?: string;
  /** Needed only to write workspace notes; absent means unknown, which fails closed. */
  readonly visibility?: ConversationVisibility;
  readonly taskId?: string;
  readonly conversationType: "channel" | "dm";
}

export type MemoryMutationResult =
  | { readonly kind: "accepted"; readonly memory: MemoryRecord }
  | { readonly kind: "denied"; readonly reason: string };

export type RememberResult =
  | { readonly kind: "accepted"; readonly memory: MemoryRecord }
  | { readonly kind: "duplicate"; readonly memory: MemoryRecord }
  | { readonly kind: "denied"; readonly reason: string };

export type ResolveRefResult =
  | { readonly kind: "found"; readonly memory: MemoryRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

export type MemoryRefMutationResult =
  | { readonly kind: "accepted"; readonly memory: MemoryRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "denied"; readonly reason: string };

/** Notes visible in one conversation, by user-facing store. Each group is newest first. */
export interface MemoryGroups {
  readonly channel: readonly MemoryRecord[];
  readonly dm: readonly MemoryRecord[];
  readonly operator: readonly MemoryRecord[];
  readonly task: readonly MemoryRecord[];
  readonly workspace: readonly MemoryRecord[];
}

type Profile = AgentTagConfig["profiles"][number];

/** User-facing store names, as Slack and the operator CLI say them, mapped to stored scopes. */
export const MEMORY_SCOPE_NAMES = {
  channel: "channel",
  workspace: "shared",
  dm: "private",
  operator: "profile",
  task: "task",
} as const satisfies Record<string, MemoryRecord["scope"]>;
export type MemoryScopeName = keyof typeof MEMORY_SCOPE_NAMES;

/** An operator (the `memory-*` CLI): bypasses Slack access and visibility, but not the workspace. */
export interface OperatorContext {
  readonly workspaceId: string;
  /** The local account running the CLI; recorded as author and audit actor. */
  readonly operatorId: string;
}

const OPERATOR_ACTOR: MemoryAuditActor = { type: "operator", authority: "operator-cli" };
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]+$/;

const EMPTY_GROUPS: MemoryGroups = { channel: [], dm: [], operator: [], task: [], workspace: [] };

/** Slack sends `<`, `>` and `&` as entities; `<@U…>` / `<#C…>` tokens are kept verbatim. */
function normalizeNoteContent(content: string): string {
  return content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

export class AgentTagMemory {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;

  constructor(input: { readonly config: AgentTagConfig; readonly store: AgentTagStore }) {
    this.#config = input.config;
    this.#store = input.store;
  }

  /**
   * A stable fingerprint of a visible note set (IDs and versions, not content: an edit bumps the
   * version), or null when there are no notes.
   */
  static digest(records: readonly MemoryRecord[]): string | null {
    if (records.length === 0) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(
      records
        .map((record) => `${record.memoryId}:${record.version}`)
        .sort()
        .join("\n"),
    );
    return hasher.digest("hex");
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
      expiresAt: this.#expiresAt(authorized.profile, input.now),
      now: input.now,
    });
    return { kind: "accepted", memory };
  }

  /**
   * Saves a note from a conversation. `here` is the channel's notes (or, in a DM, the owner's DM
   * notes); `workspace` is shared notes, writable only from a public channel.
   */
  remember(input: {
    readonly context: MemoryContext;
    readonly target: "here" | "workspace";
    readonly content: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly now: string;
  }): RememberResult {
    const { context } = input;
    const deny = (reason: string) => this.#deny(context, input.sourceId, reason, input.now);
    const authorized = this.#authorizeContext(context);
    if (authorized.kind === "denied") return deny(authorized.reason);
    const { profile } = authorized;
    let key: MemoryStoreKey;
    if (input.target === "workspace") {
      if (!profile.memory.shared) return deny("shared-memory-disabled");
      if (context.conversationType === "dm" || context.visibility !== "public") {
        return deny("workspace-write-requires-public-channel");
      }
      key = { workspaceId: context.workspaceId, scope: "shared" };
    } else if (context.conversationType === "dm") {
      if (!profile.memory.privateDm) return deny("private-memory-disabled");
      key = {
        workspaceId: context.workspaceId,
        scope: "private",
        profileId: context.profileId,
        ownerUserId: context.actorUserId,
      };
    } else {
      if (context.conversationId === undefined) return deny("conversation-required");
      key = { workspaceId: context.workspaceId, scope: "channel", conversationId: context.conversationId };
    }
    const content = normalizeNoteContent(input.content);
    const checked = this.#checkContent(profile, content);
    if (checked !== null) return deny(checked);
    const duplicate = this.#store.findDuplicateMemory({ ...key, content, now: input.now });
    if (duplicate !== null) return { kind: "duplicate", memory: duplicate };
    const cap = key.scope === "shared"
      ? profile.memory.maxWorkspaceEntries
      : profile.memory.maxEntriesPerConversation;
    if (this.#store.countActiveMemory({ ...key, now: input.now }) >= cap) return deny("memory-full");
    const memory = this.#store.createMemory({
      ...key,
      content,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      actorUserId: context.actorUserId,
      expiresAt: this.#expiresAt(profile, input.now),
      now: input.now,
    });
    return { kind: "accepted", memory };
  }

  list(input: { readonly context: MemoryContext; readonly now: string; readonly limit?: number }): ReadonlyArray<MemoryRecord> {
    const authorized = this.#authorizeContext(input.context);
    if (authorized.kind === "denied") return [];
    return this.#listVisible(input.context, authorized.profile, input.now, input.limit ?? 20);
  }

  /** Every note visible in the conversation, grouped by user-facing store. */
  listForConversation(input: { readonly context: MemoryContext; readonly now: string }): MemoryGroups {
    const authorized = this.#authorizeContext(input.context);
    if (authorized.kind === "denied") return EMPTY_GROUPS;
    const records = this.#listVisible(input.context, authorized.profile, input.now, 500);
    const pick = (scope: MemoryRecord["scope"]) => records.filter((record) => record.scope === scope);
    return {
      channel: pick("channel"),
      dm: pick("private"),
      operator: pick("profile"),
      task: pick("task"),
      workspace: pick("shared"),
    };
  }

  /**
   * Resolves a user-typed ref among the notes visible here. A note that exists but is not visible
   * is reported as not found, so a ref is never an existence oracle.
   */
  resolveRef(input: { readonly context: MemoryContext; readonly ref: string; readonly now: string }): ResolveRefResult {
    const authorized = this.#authorizeContext(input.context);
    const prefix = normalizeMemoryRef(input.ref);
    if (authorized.kind === "denied" || prefix === null) return { kind: "not-found" };
    const visible = this.#store
      .findMemoryByRef({ workspaceId: input.context.workspaceId, refPrefix: prefix, now: input.now })
      .filter((memory) => this.#canRead(input.context, authorized.profile, memory));
    const [only] = visible;
    if (only === undefined) return { kind: "not-found" };
    if (visible.length > 1) return { kind: "ambiguous", candidates: visible.map((memory) => memory.memoryId) };
    return { kind: "found", memory: only };
  }

  /** Whether a note listed here may be changed from this conversation (see #canWrite). */
  canWrite(context: MemoryContext, memory: MemoryRecord): boolean {
    const authorized = this.#authorizeContext(context);
    return authorized.kind === "accepted" && this.#canWrite(context, authorized.profile, memory);
  }

  forgetRef(input: { readonly context: MemoryContext; readonly ref: string; readonly now: string }): MemoryRefMutationResult {
    const target = this.#resolveWritable(input.context, input.ref, input.now);
    if (target.kind !== "found") return target;
    this.#store.forgetMemory({ memoryId: target.memory.memoryId, actorUserId: input.context.actorUserId, now: input.now });
    return { kind: "accepted", memory: target.memory };
  }

  editRef(input: {
    readonly context: MemoryContext;
    readonly ref: string;
    readonly content: string;
    readonly now: string;
  }): MemoryRefMutationResult {
    const target = this.#resolveWritable(input.context, input.ref, input.now);
    if (target.kind !== "found") return target;
    const content = normalizeNoteContent(input.content);
    const checked = this.#checkContent(target.profile, content);
    if (checked !== null) return this.#deny(input.context, input.ref, checked, input.now);
    return {
      kind: "accepted",
      memory: this.#store.updateMemory({
        memoryId: target.memory.memoryId,
        actorUserId: input.context.actorUserId,
        content,
        expiresAt: this.#expiresAt(target.profile, input.now),
        now: input.now,
      }),
    };
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

  /**
   * Notes stored for the operator view: every scope, no visibility filter. `conversationId` narrows to
   * that channel's notes, or, for a DM route, its owner's DM notes on that profile.
   */
  operatorList(input: {
    readonly context: OperatorContext;
    readonly scope?: MemoryScopeName;
    readonly conversationId?: string;
    readonly now: string;
  }): ReadonlyArray<MemoryRecord> {
    if (!this.#operatorWorkspace(input.context)) return [];
    const scope = input.scope === undefined ? undefined : MEMORY_SCOPE_NAMES[input.scope];
    let key: Omit<MemoryStoreKey, "workspaceId"> | null = scope === undefined ? null : { scope };
    if (input.conversationId !== undefined) {
      const stored = this.#conversationStore(input.conversationId);
      if (scope !== undefined && scope !== stored.scope) return [];
      key = stored;
    }
    return this.#store.listMemoryEntries({ workspaceId: input.context.workspaceId, ...key, now: input.now });
  }

  /**
   * Saves a note as the operator. Skips Slack visibility and the per-store caps; keeps the length,
   * secret and duplicate checks. Retention and length come from `profileId`, else the channel's
   * route, else the only profile.
   */
  operatorCreate(input: {
    readonly context: OperatorContext;
    readonly scope: "channel" | "workspace" | "operator";
    readonly content: string;
    readonly conversationId?: string;
    readonly profileId?: string;
    readonly now: string;
  }): RememberResult {
    const { context } = input;
    const deny = (reason: string) => this.#operatorDeny(context, "operator-cli", reason, input.now);
    if (!this.#operatorWorkspace(context)) return deny("workspace-denied");
    if (input.scope === "channel" && (input.conversationId === undefined || !SLACK_CHANNEL_ID.test(input.conversationId))) {
      return deny("channel-conversation-required");
    }
    if (input.scope !== "channel" && input.conversationId !== undefined) return deny("conversation-not-allowed");
    const profile = this.#operatorProfile(input.profileId, input.scope === "channel" ? input.conversationId : undefined);
    if (profile === null) return deny(input.profileId === undefined ? "profile-required" : "profile-denied");
    const key: MemoryStoreKey =
      input.scope === "channel"
        ? { workspaceId: context.workspaceId, scope: "channel", conversationId: input.conversationId! }
        : input.scope === "workspace"
          ? { workspaceId: context.workspaceId, scope: "shared" }
          : { workspaceId: context.workspaceId, scope: "profile", profileId: profile.id };
    const content = input.content.trim();
    const checked = this.#checkContent(profile, content);
    if (checked !== null) return deny(checked);
    const duplicate = this.#store.findDuplicateMemory({ ...key, content, now: input.now });
    if (duplicate !== null) return { kind: "duplicate", memory: duplicate };
    const memory = this.#store.createMemory({
      ...key,
      content,
      sourceType: "operator-cli",
      sourceId: "operator-cli",
      actorUserId: context.operatorId,
      actor: OPERATOR_ACTOR,
      expiresAt: this.#expiresAt(profile, input.now),
      now: input.now,
    });
    return { kind: "accepted", memory };
  }

  /** Replaces a note's text as the operator, keeping its expiry. `ref` is a memory ID or its prefix. */
  operatorEdit(input: {
    readonly context: OperatorContext;
    readonly ref: string;
    readonly content: string;
    readonly now: string;
  }): MemoryRefMutationResult {
    const target = this.#operatorResolve(input.context, input.ref, input.now);
    if (target.kind !== "found") return target;
    const content = input.content.trim();
    const profile = this.#operatorProfile(target.memory.profileId ?? undefined, target.memory.conversationId ?? undefined);
    const checked = this.#checkContent(profile, content);
    if (checked !== null) return this.#operatorDeny(input.context, target.memory.memoryId, checked, input.now);
    return {
      kind: "accepted",
      memory: this.#store.updateMemory({
        memoryId: target.memory.memoryId,
        actorUserId: input.context.operatorId,
        actor: OPERATOR_ACTOR,
        content,
        now: input.now,
      }),
    };
  }

  operatorForget(input: { readonly context: OperatorContext; readonly ref: string; readonly now: string }): MemoryRefMutationResult {
    const target = this.#operatorResolve(input.context, input.ref, input.now);
    if (target.kind !== "found") return target;
    this.#store.forgetMemory({
      memoryId: target.memory.memoryId,
      actorUserId: input.context.operatorId,
      actor: OPERATOR_ACTOR,
      now: input.now,
    });
    return { kind: "accepted", memory: target.memory };
  }

  /** Forgets every note stored for a conversation (see operatorList) in one transaction. */
  operatorForgetConversation(input: {
    readonly context: OperatorContext;
    readonly conversationId: string;
    readonly now: string;
  }): ReadonlyArray<MemoryRecord> {
    const notes = this.operatorList(input);
    if (notes.length > 0) {
      this.#store.forgetMemoryEntries({
        memoryIds: notes.map((memory) => memory.memoryId),
        actorUserId: input.context.operatorId,
        actor: OPERATOR_ACTOR,
        now: input.now,
      });
    }
    return notes;
  }

  #operatorWorkspace(context: OperatorContext): boolean {
    return context.workspaceId === this.#config.slack.workspaceId;
  }

  /** A DM route's notes are its owner's DM notes on its profile; any other conversation's are its channel notes. */
  #conversationStore(conversationId: string): Omit<MemoryStoreKey, "workspaceId"> {
    const route = this.#config.routes.find((candidate) => candidate.conversationId === conversationId);
    if (route?.conversationType === "dm") {
      return { scope: "private", profileId: route.profileId, ownerUserId: route.ownerUserId };
    }
    return { scope: "channel", conversationId };
  }

  #operatorProfile(profileId: string | undefined, conversationId: string | undefined): Profile | null {
    const id =
      profileId ??
      this.#config.routes.find((route) => route.conversationId === conversationId)?.profileId ??
      (this.#config.profiles.length === 1 ? this.#config.profiles[0]?.id : undefined);
    return this.#config.profiles.find((profile) => profile.id === id) ?? null;
  }

  #operatorResolve(context: OperatorContext, ref: string, now: string):
    | { readonly kind: "found"; readonly memory: MemoryRecord }
    | { readonly kind: "not-found" }
    | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
    | { readonly kind: "denied"; readonly reason: string } {
    const prefix = normalizeMemoryRef(ref);
    if (!this.#operatorWorkspace(context)) return this.#operatorDeny(context, prefix ?? "invalid-ref", "workspace-denied", now);
    if (prefix === null) return { kind: "not-found" };
    const matches = this.#store.findMemoryByRef({ workspaceId: context.workspaceId, refPrefix: prefix, now });
    const [only] = matches;
    if (only === undefined) return { kind: "not-found" };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((memory) => memory.memoryId) };
    return { kind: "found", memory: only };
  }

  #operatorDeny(context: OperatorContext, sourceId: string, reason: string, now: string): { readonly kind: "denied"; readonly reason: string } {
    this.#store.recordMemoryDenial({
      actorUserId: context.operatorId,
      sourceId,
      reason,
      workspaceId: context.workspaceId,
      actor: OPERATOR_ACTOR,
      now,
    });
    return { kind: "denied", reason };
  }

  #listVisible(context: MemoryContext, profile: Profile, now: string, limit: number): ReadonlyArray<MemoryRecord> {
    const inChannel = context.conversationType === "channel";
    return this.#store.listVisibleMemory({
      workspaceId: context.workspaceId,
      profileId: context.profileId,
      ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      ownerUserId: context.actorUserId,
      includeShared: profile.memory.shared && (inChannel || profile.memory.dmReadsWorkspace),
      includePrivate: !inChannel && profile.memory.privateDm,
      includeChannel: inChannel,
      now,
      limit,
    });
  }

  /** Resolves a ref and checks write access; every refusal is audited as `memory.denied` against the ref. */
  #resolveWritable(context: MemoryContext, ref: string, now: string):
    | { readonly kind: "found"; readonly memory: MemoryRecord; readonly profile: Profile }
    | { readonly kind: "not-found" }
    | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
    | { readonly kind: "denied"; readonly reason: string } {
    // Only a well-formed ref reaches the audit row, never arbitrary user text.
    const sourceId = normalizeMemoryRef(ref) ?? "invalid-ref";
    const authorized = this.#authorizeContext(context);
    if (authorized.kind === "denied") return this.#deny(context, sourceId, authorized.reason, now);
    const resolved = this.resolveRef({ context, ref, now });
    if (resolved.kind === "not-found") {
      this.#deny(context, sourceId, "memory-not-found", now);
      return resolved;
    }
    if (resolved.kind === "ambiguous") return resolved;
    if (!this.#canWrite(context, authorized.profile, resolved.memory)) {
      return this.#deny(context, sourceId, "memory-read-only", now);
    }
    return { kind: "found", memory: resolved.memory, profile: authorized.profile };
  }

  /** A denial reason for note content, or null when it may be stored. */
  #checkContent(profile: Profile | null, content: string): string | null {
    if (content === "") return "entry-empty";
    // Without a profile (an operator edit of a workspace note), the store's own limit applies.
    if (content.length > (profile?.memory.maxEntryChars ?? 2_000)) return "entry-too-long";
    if (containsKnownSecret(content)) return "secret-detected";
    return null;
  }

  #expiresAt(profile: Profile, now: string): string {
    return new Date(new Date(now).getTime() + profile.memory.retentionDays * 86_400_000).toISOString();
  }

  #authorizeContext(context: MemoryContext):
    | { readonly kind: "accepted"; readonly profile: Profile }
    | { readonly kind: "denied"; readonly reason: string } {
    if (context.workspaceId !== this.#config.slack.workspaceId) {
      return { kind: "denied", reason: "workspace-denied" };
    }
    const access = this.#accessDecision(context);
    if (!access.allowed) return { kind: "denied", reason: access.reason };
    const profile = this.#config.profiles.find((candidate) => candidate.id === context.profileId);
    if (profile === undefined) return { kind: "denied", reason: "profile-denied" };
    if (
      context.taskId !== undefined &&
      !this.#store.taskBelongsToContext({
        taskId: context.taskId,
        workspaceId: context.workspaceId,
        profileId: context.profileId,
        actorUserId: context.actorUserId,
      })
    ) {
      return { kind: "denied", reason: "task-denied" };
    }
    return { kind: "accepted", profile };
  }

  /**
   * Allowlisted users keep today's rule (any conversation the routers let through). Anyone else needs the
   * access predicate to allow them in the context's conversation (or its task's), so in `channel-members`
   * mode a channel member may use memory where they may steer.
   */
  #accessDecision(context: MemoryContext): AccessDecision {
    if (isAllowlisted(this.#config, context.actorUserId)) return { allowed: true, basis: "allowlist" };
    if (this.#config.access.mode === "allowlist") return { allowed: false, reason: "user-denied" };
    let conversationId = context.conversationId;
    let dmOwnerUserId: string | null = null;
    const task = context.taskId === undefined ? null : this.#store.findTaskConversation(context.taskId);
    if (task !== null) {
      conversationId ??= task.conversationId;
      dmOwnerUserId = task.ownerUserId;
    }
    if (conversationId === undefined) return { allowed: false, reason: "user-denied" };
    return isSteeringAllowed({
      config: this.#config,
      workspaceId: context.workspaceId,
      conversationId,
      userId: context.actorUserId,
      purpose: "memory",
      dmOwnerUserId,
    });
  }

  #canAccess(context: MemoryContext, memory: MemoryRecord): boolean {
    const authorized = this.#authorizeContext(context);
    return authorized.kind === "accepted" && this.#canRead(context, authorized.profile, memory);
  }

  #canRead(context: MemoryContext, profile: Profile, memory: MemoryRecord): boolean {
    if (memory.workspaceId !== context.workspaceId) return false;
    switch (memory.scope) {
      case "shared":
        return profile.memory.shared && (context.conversationType === "channel" || profile.memory.dmReadsWorkspace);
      case "profile":
        return memory.profileId === context.profileId;
      case "task":
        return context.taskId !== undefined && memory.taskId === context.taskId;
      case "private":
        return (
          context.conversationType === "dm" &&
          profile.memory.privateDm &&
          memory.profileId === context.profileId &&
          memory.ownerUserId === context.actorUserId
        );
      case "channel":
        return (
          context.conversationType === "channel" &&
          context.conversationId !== undefined &&
          memory.conversationId === context.conversationId
        );
    }
  }

  /** Conversation writes: workspace notes only from a public channel; operator and task notes never. */
  #canWrite(context: MemoryContext, profile: Profile, memory: MemoryRecord): boolean {
    if (!this.#canRead(context, profile, memory)) return false;
    switch (memory.scope) {
      case "shared":
        return context.conversationType === "channel" && context.visibility === "public";
      case "profile":
      case "task":
        return false;
      case "private":
      case "channel":
        return true;
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
