import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore, ClaimedOperation } from "./store/store.ts";
import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  pendingT3Approvals,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
  type T3PendingApproval,
  type T3ThreadSnapshot,
} from "./t3/gateway.ts";

export interface T3CoordinatorGateway {
  readonly dispatch: (command: T3Command) => Promise<T3DispatchResult>;
  readonly fetchThread: (threadId: string) => Promise<T3ThreadSnapshot>;
}

export type CoordinatorOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "completed"; readonly operationId: string; readonly outboxId: string }
  | {
      readonly kind: "waiting-approval";
      readonly operationId: string;
      readonly threadId: string;
      readonly approvals: ReadonlyArray<T3PendingApproval>;
      readonly leaseExpiresAt: string;
    }
  | { readonly kind: "retry-scheduled"; readonly operationId: string; readonly errorCode: string };

export interface CoordinatorOptions {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly t3?: T3CoordinatorGateway;
  readonly workerId?: string;
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function defaultT3Gateway(config: T3ConnectionConfig): T3CoordinatorGateway {
  return {
    dispatch: (command) => dispatchT3Command({ config, command }),
    fetchThread: (threadId) => fetchT3ThreadSnapshot({ config, threadId }),
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "T3CoordinatorError";
}

export class AgentTagCoordinator {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;
  readonly #t3: T3CoordinatorGateway;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #pollMs: number;
  readonly #maxWaitMs: number;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CoordinatorOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#t3 = options.t3 ?? defaultT3Gateway(options.config.t3);
    this.#workerId = options.workerId ?? `t3-worker-${crypto.randomUUID()}`;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#pollMs = options.pollMs ?? 500;
    this.#maxWaitMs = options.maxWaitMs ?? 300_000;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async processNext(): Promise<CoordinatorOutcome> {
    const operation = this.#store.claimNextOperation({
      workerId: this.#workerId,
      now: this.#now().toISOString(),
      leaseMs: this.#leaseMs,
      maxConcurrentTasks: this.#config.limits.maxConcurrentTasks,
    });
    if (operation === null) return { kind: "idle" };

    try {
      return await this.#run(operation);
    } catch (error) {
      const code = errorCode(error);
      this.#store.failOperation({
        operationId: operation.operationId,
        workerId: this.#workerId,
        errorCode: code,
        retryable: true,
        now: this.#now().toISOString(),
      });
      return { kind: "retry-scheduled", operationId: operation.operationId, errorCode: code };
    }
  }

  async #run(operation: ClaimedOperation): Promise<CoordinatorOutcome> {
    const task = this.#store.getTaskExecution(operation.taskId);
    const profile = this.#config.profiles.find((candidate) => candidate.id === task.profileId);
    if (profile === undefined) throw new Error(`task references missing profile ${task.profileId}`);
    const modelSelection = {
      instanceId: profile.defaultProviderInstanceId,
      model: profile.defaultModel,
    };
    await this.#t3.dispatch({
      type: "project.create",
      commandId: `${task.taskId}:project.create`,
      projectId: task.projectId,
      title: `Agent Tag ${profile.id}`,
      workspaceRoot: task.repositoryRoot,
      defaultModelSelection: modelSelection,
      createdAt: task.createdAt,
    });

    const turn = await this.#t3.dispatch({
      type: "thread.turn.start",
      commandId: operation.commandId,
      threadId: task.threadId,
      message: {
        messageId: operation.messageId,
        role: "user",
        text: operation.payload.text,
        attachments: [],
      },
      modelSelection,
      titleSeed: `Slack ${operation.payload.conversationId}/${operation.payload.threadTs}`,
      runtimeMode: profile.runtimeMode,
      interactionMode: "default",
      ...(task.threadStarted
        ? {}
        : {
            bootstrap: {
              createThread: {
                projectId: task.projectId,
                title: `Slack ${operation.payload.conversationId}/${operation.payload.threadTs}`,
                modelSelection,
                runtimeMode: profile.runtimeMode,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: task.createdAt,
              },
              prepareWorktree: {
                projectCwd: task.repositoryRoot,
                baseBranch: profile.baseBranch,
                branch: `agent-tag/${task.taskId}`,
              },
              runSetupScript: false,
            },
          }),
      createdAt: this.#now().toISOString(),
    });
    this.#store.markT3ThreadStarted({ taskId: task.taskId, now: this.#now().toISOString() });

    const startedAt = this.#now().getTime();
    let renewAt = startedAt + Math.floor(this.#leaseMs / 2);
    while (this.#now().getTime() - startedAt <= this.#maxWaitMs) {
      const snapshot = await this.#t3.fetchThread(task.threadId);
      const approvals = pendingT3Approvals(snapshot);
      if (approvals.length > 0) {
        return {
          kind: "waiting-approval",
          operationId: operation.operationId,
          threadId: task.threadId,
          approvals,
          leaseExpiresAt: operation.leaseExpiresAt,
        };
      }
      const latestTurn = snapshot.thread.latestTurn;
      if (latestTurn?.state === "error") throw new Error("T3 turn entered the error state");
      if (latestTurn?.state === "completed") {
        const assistant = snapshot.thread.messages.find(
          (message) =>
            message.id === latestTurn.assistantMessageId &&
            message.role === "assistant" &&
            !message.streaming,
        );
        if (assistant === undefined) throw new Error("completed T3 turn has no final assistant message");
        const outboxId = this.#store.completeOperationWithOutbox({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          resultSequence: Math.max(turn.sequence, snapshot.snapshotSequence),
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          text: assistant.text,
          now: this.#now().toISOString(),
        });
        return { kind: "completed", operationId: operation.operationId, outboxId };
      }
      if (this.#now().getTime() >= renewAt) {
        this.#store.renewOperationLease({
          operationId: operation.operationId,
          workerId: this.#workerId,
          now: this.#now().toISOString(),
          leaseMs: this.#leaseMs,
        });
        renewAt = this.#now().getTime() + Math.floor(this.#leaseMs / 2);
      }
      await this.#sleep(this.#pollMs);
    }
    throw new Error("T3 turn did not settle before the coordinator deadline");
  }
}
