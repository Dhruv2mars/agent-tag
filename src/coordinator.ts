import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore, ClaimedOperation, SlackOutboxPayload } from "./store/store.ts";
import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  pendingT3Approvals,
  pendingT3UserInputs,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
  type T3PendingApproval,
  type T3PendingUserInput,
  type T3ThreadSnapshot,
} from "./t3/gateway.ts";

export interface T3CoordinatorGateway {
  readonly dispatch: (command: T3Command) => Promise<T3DispatchResult>;
  readonly fetchThread: (threadId: string) => Promise<T3ThreadSnapshot>;
}

export type CoordinatorOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "completed"; readonly operationId: string; readonly outboxId: string }
  | { readonly kind: "cancelled"; readonly operationId: string; readonly outboxId: string }
  | {
      readonly kind: "waiting-interaction";
      readonly operationId: string;
      readonly threadId: string;
      readonly approvalCount: number;
      readonly questionCount: number;
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

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function approvalMessage(interactionId: string, approval: T3PendingApproval): SlackOutboxPayload {
  const detail = approval.detail === undefined ? "The agent requested permission." : escapeSlackText(approval.detail);
  return {
    text: `Approval required: ${approval.requestKind}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Approval required* · ${approval.requestKind}\n${detail}` } },
      {
        type: "actions",
        block_id: `agent-tag:${interactionId}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "agent-tag.approval.accept",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            action_id: "agent-tag.approval.decline",
            value: interactionId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel request" },
            action_id: "agent-tag.approval.cancel",
            value: interactionId,
          },
        ],
      },
    ],
  };
}

function questionMessage(interactionId: string, request: T3PendingUserInput): SlackOutboxPayload {
  const first = request.questions[0];
  if (first === undefined) throw new Error("T3 user-input request has no questions");
  type SlackBlock = NonNullable<SlackOutboxPayload["blocks"]>[number];
  type SlackActionsBlock = Extract<SlackBlock, { readonly type: "actions" }>;
  const elements: SlackActionsBlock["elements"] = first.options.slice(0, 5).map((option) => ({
    type: "button",
    text: { type: "plain_text", text: option.label },
    action_id: "agent-tag.user-input.answer",
    value: JSON.stringify({ interactionId, questionId: first.id, answer: option.label }),
  }));
  const blocks: NonNullable<SlackOutboxPayload["blocks"]> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeSlackText(first.header)}*\n${escapeSlackText(first.question)}` },
    },
  ];
  if (elements.length > 0) blocks.push({ type: "actions", elements });
  if (request.dismissible) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss" },
          action_id: "agent-tag.user-input.dismiss",
          value: interactionId,
        },
      ],
    });
  }
  return {
    text: `Question from the agent: ${first.question}`,
    blocks,
  };
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
    this.#store.enqueueOutbox({
      taskId: operation.taskId,
      correlationId: operation.operationId,
      conversationId: operation.payload.conversationId,
      threadTs: operation.payload.threadTs,
      clientMessageId: `${operation.operationId}:started`,
      payload: {
        text: "Agent Tag is working on this request.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Agent Tag is working on this request." },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                style: "danger",
                action_id: "agent-tag.turn.cancel",
                value: operation.taskId,
                confirm: {
                  title: { type: "plain_text", text: "Cancel this task?" },
                  text: { type: "mrkdwn", text: "The active T3 turn will be interrupted." },
                  confirm: { type: "plain_text", text: "Cancel task" },
                  deny: { type: "plain_text", text: "Keep running" },
                  style: "danger",
                },
              },
            ],
          },
        ],
      },
      createdAt: this.#now().toISOString(),
    });

    const startedAt = this.#now().getTime();
    let renewAt = startedAt + Math.floor(this.#leaseMs / 2);
    while (this.#now().getTime() - startedAt <= this.#maxWaitMs) {
      const snapshot = await this.#t3.fetchThread(task.threadId);
      const approvals = pendingT3Approvals(snapshot);
      const userInputs = pendingT3UserInputs(snapshot);
      if (approvals.length > 0 || userInputs.length > 0) {
        const interactionNow = this.#now();
        for (const approval of approvals) {
          this.#store.recordPendingInteraction({
            taskId: operation.taskId,
            operationId: operation.operationId,
            threadId: task.threadId,
            requestId: approval.requestId,
            kind: "approval",
            prompt: approval,
            conversationId: operation.payload.conversationId,
            threadTs: operation.payload.threadTs,
            message: (interactionId) => approvalMessage(interactionId, approval),
            now: interactionNow.toISOString(),
          });
        }
        for (const userInput of userInputs) {
          this.#store.recordPendingInteraction({
            taskId: operation.taskId,
            operationId: operation.operationId,
            threadId: task.threadId,
            requestId: userInput.requestId,
            kind: "user-input",
            prompt: userInput,
            conversationId: operation.payload.conversationId,
            threadTs: operation.payload.threadTs,
            message: (interactionId) => questionMessage(interactionId, userInput),
            now: interactionNow.toISOString(),
          });
        }
        this.#store.deferOperation({
          operationId: operation.operationId,
          workerId: this.#workerId,
          blockedUntil: new Date(interactionNow.getTime() + 86_400_000).toISOString(),
          now: interactionNow.toISOString(),
        });
        return {
          kind: "waiting-interaction",
          operationId: operation.operationId,
          threadId: task.threadId,
          approvalCount: approvals.length,
          questionCount: userInputs.length,
        };
      }
      const latestTurn = snapshot.thread.latestTurn;
      if (latestTurn?.state === "error") throw new Error("T3 turn entered the error state");
      if (latestTurn?.state === "interrupted") {
        const outboxId = this.#store.cancelOperationWithOutbox({
          operationId: operation.operationId,
          taskId: operation.taskId,
          workerId: this.#workerId,
          conversationId: operation.payload.conversationId,
          threadTs: operation.payload.threadTs,
          now: this.#now().toISOString(),
        });
        return { kind: "cancelled", operationId: operation.operationId, outboxId };
      }
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
