// Memory phrases from Slack (PR-K §3.6): remember, list, forget, update. The router detects the
// phrase; this runs it without a T3 turn. Ledger claim, thread task, memory change, replies and the
// settled ledger row commit together (store runThreadCommand), so a redelivery never doubles a note
// or a reply. Never throws for user errors.
import type { AgentTagConfig } from "../config.ts";
import { AgentTagMemory, type ConversationVisibility, type MemoryContext, type MemoryRefMutationResult } from "../memory.ts";
import { ExecutionAuthorityDenied, requireExecutionAuthority } from "../policy/execution.ts";
import type { ServiceLogger } from "../service.ts";
import type { ThreadCommandResult } from "../store/commands.ts";
import type { AgentTagStore, MemoryRecord, SlackOutboxPayload } from "../store/store.ts";
import type { MemoryCommand } from "./memory-grammar.ts";
import * as copy from "./memory-replies.ts";
import { slackErrorCode } from "./users.ts";

export interface MemoryRequest {
  readonly deliveryId: string;
  /** "<channel>:<ts>" of the request message. */
  readonly eventKey: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly conversationType: "channel" | "dm";
  /** The thread the request belongs to (the message's own ts at top level). Replies go here. */
  readonly threadTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly receivedAt: string;
}

export interface MemoryIngress {
  readonly kind: "memory";
  readonly command: MemoryCommand;
  readonly request: MemoryRequest;
}

export type MemoryCommandOutcome =
  | { readonly kind: "duplicate" }
  | { readonly kind: "executed"; readonly outcome: ThreadCommandResult["outcome"]; readonly reason: string | null };

/** Only-you notes for authority denials and failures, where a thread reply may not be allowed. */
export interface MemoryEphemeralSender {
  ephemeral(input: {
    readonly channel: string;
    readonly user: string;
    readonly threadTs?: string;
    readonly payload: SlackOutboxPayload;
  }): Promise<void>;
}

export interface SlackMemoryCommandsOptions {
  /** A getter, so a config reload applies without rewiring. */
  readonly config: () => AgentTagConfig;
  readonly store: AgentTagStore;
  readonly replies: MemoryEphemeralSender;
  /** Channel visibility for workspace notes; absent means unknown, so workspace writes are refused. */
  readonly visibility?: { resolve(input: { readonly conversationId: string; readonly conversationType: "channel" | "dm" }): Promise<ConversationVisibility> };
  /** Author display names for the list; absent or failed lookups show the user ID. */
  readonly users?: { label(userId: string, signal?: AbortSignal): Promise<{ readonly label: string }> };
  readonly logger?: ServiceLogger;
  readonly now?: () => Date;
}

const LABEL_LOOKUP_MS = 3_000;
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const COMMAND_KIND = {
  remember: "memory-remember",
  list: "memory-list",
  forget: "memory-forget",
  "forget-match": "memory-forget",
  edit: "memory-edit",
} as const satisfies Record<MemoryCommand["kind"], string>;

interface Executed extends ThreadCommandResult {
  /** Set when the actor lost authority: nothing changed and the reply goes only to them. */
  readonly ephemeral?: SlackOutboxPayload;
}

export class SlackMemoryCommands {
  readonly #config: () => AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #replies: MemoryEphemeralSender;
  readonly #visibility: SlackMemoryCommandsOptions["visibility"];
  readonly #users: SlackMemoryCommandsOptions["users"];
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;

  constructor(options: SlackMemoryCommandsOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#replies = options.replies;
    this.#visibility = options.visibility;
    this.#users = options.users;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  async handle(ingress: MemoryIngress): Promise<MemoryCommandOutcome> {
    const { command, request: req } = ingress;
    const config = this.#config();
    const memory = new AgentTagMemory({ config, store: this.#store });
    const visibility = await this.#resolveVisibility(req);
    const context: MemoryContext = {
      workspaceId: req.workspaceId,
      actorUserId: req.actorUserId,
      profileId: req.profileId,
      conversationId: req.conversationId,
      conversationType: req.conversationType,
      visibility,
    };
    // Author names are the only I/O, fetched before the transaction; a note added meanwhile shows its ID.
    const labels = command.kind === "list"
      ? await this.#labels(memory.listForConversation({ context, now: req.receivedAt }))
      : new Map<string, string>();
    try {
      const receipt = this.#store.runThreadCommand(
        {
          deliveryId: req.deliveryId,
          eventKey: req.eventKey,
          workspaceId: req.workspaceId,
          conversationId: req.conversationId,
          conversationType: req.conversationType,
          threadTs: req.threadTs,
          actorUserId: req.actorUserId,
          profileId: req.profileId,
          repositoryRoot: req.repositoryRoot,
          commandKind: COMMAND_KIND[command.kind],
          now: req.receivedAt,
        },
        (taskId): Executed => {
          try {
            requireExecutionAuthority({ config, task: this.#store.getTaskExecution(taskId), actorUserId: req.actorUserId });
          } catch (error) {
            if (!(error instanceof ExecutionAuthorityDenied)) throw error;
            return { outcome: "denied", reason: "execution-denied", replies: [], ephemeral: copy.MEMORY_COMMAND_DENIED };
          }
          return this.#execute(config, memory, context, command, req, labels);
        },
      );
      if (receipt.kind === "duplicate") return { kind: "duplicate" };
      if (receipt.result.ephemeral !== undefined) await this.#ephemeral(req, receipt.result.ephemeral);
      return { kind: "executed", outcome: receipt.result.outcome, reason: receipt.result.reason };
    } catch (error) {
      // Everything rolled back; Bolt already acked the event, so the user retries by sending it again.
      this.#log("memory.command.failed", command.kind, error instanceof Error ? error.name : "unknown");
      await this.#ephemeral(req, copy.MEMORY_COMMAND_FAILED);
      return { kind: "executed", outcome: "failed", reason: "internal-error" };
    }
  }

  #execute(
    config: AgentTagConfig,
    memory: AgentTagMemory,
    context: MemoryContext,
    command: MemoryCommand,
    req: MemoryRequest,
    labels: ReadonlyMap<string, string>,
  ): Executed {
    const now = req.receivedAt;
    const profile = config.profiles.find((candidate) => candidate.id === req.profileId);
    if (profile === undefined) throw new Error(`validated route references missing profile ${req.profileId}`);
    const limits = profile.memory;
    const refused = (reason: string, target: "here" | "workspace" | "edit"): Executed => ({
      outcome: "rejected",
      reason,
      replies: [copy.deniedReply({ reason, target, conversationType: req.conversationType, limits })],
    });
    switch (command.kind) {
      case "remember": {
        const result = memory.remember({
          context,
          target: command.target,
          content: command.content,
          sourceType: "slack-message",
          sourceId: req.eventKey,
          now,
        });
        if (result.kind === "denied") return refused(result.reason, command.target);
        if (result.kind === "duplicate") {
          return { outcome: "rejected", reason: "duplicate", memoryId: result.memory.memoryId, replies: [copy.duplicateReply(result.memory)] };
        }
        return {
          outcome: "succeeded",
          reason: null,
          memoryId: result.memory.memoryId,
          replies: [copy.savedReply({ memory: result.memory, conversationType: req.conversationType })],
        };
      }
      case "list": {
        const groups = memory.listForConversation({ context, now });
        return {
          outcome: "succeeded",
          reason: null,
          replies: copy.listReplies({
            groups,
            conversationType: req.conversationType,
            workspaceWritable: req.conversationType === "channel" && context.visibility === "public",
            labels,
          }),
        };
      }
      case "forget":
        return this.#refResult(memory.forgetRef({ context, ref: command.ref, now }), command.ref, copy.forgottenReply, refused);
      case "edit":
        return this.#refResult(
          memory.editRef({ context, ref: command.ref, content: command.content, now }),
          command.ref,
          copy.updatedReply,
          refused,
        );
      case "forget-match": {
        const groups = memory.listForConversation({ context, now });
        const needle = command.match.toLowerCase();
        const candidates = [...groups.channel, ...groups.dm, ...groups.workspace].filter(
          (record) => record.content.toLowerCase().includes(needle) && memory.canWrite(context, record),
        );
        const [only] = candidates;
        if (only === undefined) return { outcome: "rejected", reason: "no-match", replies: [copy.noMatchReply(command.match)] };
        if (candidates.length > 1) {
          return { outcome: "rejected", reason: "ambiguous", replies: [copy.matchCandidatesReply(command.match, candidates)] };
        }
        return this.#refResult(memory.forgetRef({ context, ref: only.memoryId, now }), only.memoryId, copy.forgottenReply, refused);
      }
    }
  }

  #refResult(
    result: MemoryRefMutationResult,
    ref: string,
    success: (memory: MemoryRecord) => SlackOutboxPayload,
    refused: (reason: string, target: "edit") => Executed,
  ): Executed {
    switch (result.kind) {
      case "accepted":
        return { outcome: "succeeded", reason: null, memoryId: result.memory.memoryId, replies: [success(result.memory)] };
      case "not-found":
        return { outcome: "rejected", reason: "memory-not-found", replies: [copy.notFoundReply(ref)] };
      case "ambiguous":
        return { outcome: "rejected", reason: "ambiguous-ref", replies: [copy.ambiguousReply(ref, result.candidates)] };
      case "denied":
        return refused(result.reason, "edit");
    }
  }

  async #resolveVisibility(req: MemoryRequest): Promise<ConversationVisibility> {
    if (req.conversationType === "dm") return "dm";
    if (this.#visibility === undefined) return "unknown";
    return this.#visibility.resolve({ conversationId: req.conversationId, conversationType: req.conversationType });
  }

  async #labels(groups: ReturnType<AgentTagMemory["listForConversation"]>): Promise<Map<string, string>> {
    const users = this.#users;
    if (users === undefined) return new Map();
    const ids = new Set(
      [...groups.channel, ...groups.dm, ...groups.workspace, ...groups.operator]
        .map((record) => record.updatedBy ?? record.createdBy)
        // Notes from the operator CLI name a local account, not a Slack user; it renders as is.
        .filter((userId) => SLACK_USER_ID.test(userId)),
    );
    const signal = AbortSignal.timeout(LABEL_LOOKUP_MS);
    const entries = await Promise.all(
      [...ids].map(async (userId) => {
        try {
          return [userId, (await users.label(userId, signal)).label] as const;
        } catch {
          return [userId, userId] as const;
        }
      }),
    );
    return new Map(entries);
  }

  async #ephemeral(req: MemoryRequest, payload: SlackOutboxPayload): Promise<void> {
    try {
      await this.#replies.ephemeral({ channel: req.conversationId, user: req.actorUserId, threadTs: req.threadTs, payload });
    } catch (error) {
      this.#log("memory.command.reply.failed", undefined, slackErrorCode(error));
    }
  }

  /** No event key or note text in logs. */
  #log(event: string, kind: string | undefined, errorCode: string): void {
    this.#logger?.({
      level: "warn",
      event,
      at: this.#now().toISOString(),
      ...(kind === undefined ? {} : { outcome: kind }),
      errorCode,
    });
  }
}
