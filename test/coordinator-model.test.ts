import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, classifyT3TurnFailure, type CoordinatorProviderCatalog } from "../src/coordinator.ts";
import { AgentTagStore } from "../src/store/store.ts";
import {
  type T3Command,
  type T3ModelSelection,
  type T3ServerInfo,
  t3ServerConfigSchema,
  type T3ThreadSnapshot,
} from "../src/t3/gateway.ts";

// Real 0.0.45 `server.getConfig` shape: codex and codex-work share the codex driver with different
// resume groups, claudeAgent is another driver, grok requires a new thread for any model change.
const fixtureCatalog: T3ServerInfo = t3ServerConfigSchema.parse(
  await Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json(),
);
const example: unknown = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

const SOL = { instanceId: "codex", model: "gpt-5.6-sol" } as const;
const MINI = { instanceId: "codex", model: "gpt-5.6-mini" } as const;
const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as const;
const SONNET = { instanceId: "claudeAgent", model: "claude-sonnet-5" } as const;

const ALLOWED = [
  { ...SOL, label: "Sol", aliases: ["sol"] },
  { ...MINI, label: "GPT Mini", aliases: ["mini"] },
  { ...OPUS, label: "Opus 5.5", aliases: ["opus"] },
  { ...SONNET, label: "Sonnet", aliases: ["sonnet"] },
];

function configWith(profile: Record<string, unknown> = {}, route: Record<string, unknown> = {}): AgentTagConfig {
  const input = structuredClone(example) as Record<string, any>;
  Object.assign(input.profiles[0], { defaultProviderInstanceId: "codex", defaultModel: "gpt-5.6-sol" }, profile);
  Object.assign(input.routes[0], route);
  return agentTagConfigSchema.parse(input);
}

const baseConfig = configWith({ allowedModels: ALLOWED });
const NOW = "2026-10-09T00:00:00.000Z";

/** A fake T3 thread: projects `thread.meta.update` and bootstrap selections like 0.0.45 does. */
class FakeT3 {
  readonly commands: T3Command[] = [];
  threadModel: T3ModelSelection | null = null;
  lastMessageId = "none";
  /** When set, the next turn start is refused asynchronously with this detail. */
  rejectNextTurn: string | null = null;
  #rejectedMessageId: string | null = null;
  #rejectedDetail = "";
  /** Fail the next `thread.turn.start` dispatch with a transport error. */
  failNextTurnDispatch = false;
  /** Fail the next `fetchThread` with a transport error (after a turn T3 accepted). */
  failNextFetch = false;

  readonly gateway = {
    dispatch: async (command: T3Command) => {
      this.commands.push(command);
      if (command.type === "thread.meta.update") {
        this.threadModel = command.modelSelection;
      }
      if (command.type === "thread.turn.start") {
        if (this.failNextTurnDispatch) {
          this.failNextTurnDispatch = false;
          throw new Error("socket closed");
        }
        this.lastMessageId = command.message.messageId;
        if (command.bootstrap?.createThread !== undefined) this.threadModel = command.bootstrap.createThread.modelSelection;
        if (this.rejectNextTurn !== null) {
          this.#rejectedMessageId = command.message.messageId;
          this.#rejectedDetail = this.rejectNextTurn;
          this.rejectNextTurn = null;
        }
      }
      return { sequence: this.commands.length };
    },
    fetchThread: async (threadId: string): Promise<T3ThreadSnapshot> => {
      if (this.failNextFetch) {
        this.failNextFetch = false;
        throw new Error("socket closed");
      }
      return this.snapshot(threadId);
    },
  };

  turnStarts(): Array<Extract<T3Command, { type: "thread.turn.start" }>> {
    return this.commands.filter((command): command is Extract<T3Command, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start"
    );
  }

  metaUpdates(): Array<Extract<T3Command, { type: "thread.meta.update" }>> {
    return this.commands.filter((command): command is Extract<T3Command, { type: "thread.meta.update" }> =>
      command.type === "thread.meta.update"
    );
  }

  snapshot(threadId: string): T3ThreadSnapshot {
    const rejected = this.#rejectedMessageId !== null && this.#rejectedMessageId === this.lastMessageId;
    return {
      snapshotSequence: this.commands.length,
      thread: {
        id: threadId,
        projectId: "project-1",
        title: "Fixture",
        modelSelection: this.threadModel ?? SOL,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: rejected ? null : {
          turnId: `turn-${this.lastMessageId}`,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: `assistant-${this.lastMessageId}`,
        },
        messages: [
          { id: this.lastMessageId, role: "user", text: "request", turnId: null, streaming: false, createdAt: NOW, updatedAt: NOW },
          ...(rejected ? [] : [{
            id: `assistant-${this.lastMessageId}`,
            role: "assistant" as const,
            text: "done",
            turnId: `turn-${this.lastMessageId}`,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          }]),
        ],
        activities: rejected
          ? [{
            id: "activity-failed",
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { detail: this.#rejectedDetail, requestId: this.lastMessageId },
            turnId: null,
            createdAt: NOW,
          }]
          : [],
        session: {
          threadId,
          status: rejected ? "error" : "ready",
          providerName: "codex",
          providerInstanceId: (this.threadModel ?? SOL).instanceId,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: rejected ? this.#rejectedDetail : null,
          updatedAt: NOW,
        },
      },
    };
  }
}

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function harness(config: AgentTagConfig = baseConfig, catalog: T3ServerInfo | null = fixtureCatalog) {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-coordinator-model-"));
  directories.push(directory);
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  const database = new Database(join(directory, "agent-tag.sqlite"));
  databases.push(database, store);
  const t3 = new FakeT3();
  let clock = new Date(NOW).getTime();
  const refreshes: number[] = [];
  const providerCatalog: CoordinatorProviderCatalog = {
    current: () => catalog,
    refresh: async () => {
      refreshes.push(clock);
      return catalog !== null;
    },
  };
  const coordinatorFor = (current: AgentTagConfig) =>
    new AgentTagCoordinator({
      config: current,
      store,
      t3: t3.gateway,
      catalog: providerCatalog,
      workerId: "worker-model",
      now: () => new Date(clock),
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
  let coordinator = coordinatorFor(config);
  let sequence = 0;
  const route = config.routes[0]!;
  const send = (text = "request") => {
    sequence += 1;
    const ts = `1000.00000${sequence}`;
    return store.ingestSlackEvent({
      deliveryId: `delivery-${sequence}`,
      eventKey: `${route.conversationId}:${ts}`,
      workspaceId: config.slack.workspaceId,
      conversationId: route.conversationId,
      threadTs: "1000.000001",
      actorUserId: config.access.allowedUserIds[0]!,
      conversationType: "channel",
      profileId: route.profileId,
      repositoryRoot: route.repositoryRoot!,
      text,
      receivedAt: new Date(clock).toISOString(),
      sourceOrderKey: ts,
      messageTs: ts,
    });
  };
  const outboxTexts = () =>
    database
      .query<{ payload_json: string }, []>("SELECT payload_json FROM slack_outbox ORDER BY rowid")
      .all()
      .map((row) => (JSON.parse(row.payload_json) as { text: string }).text);
  const audits = (action: string) =>
    database
      .query<{ result: string; metadata_json: string }, [string]>(
        "SELECT result, metadata_json FROM audit_log WHERE action = ? ORDER BY rowid",
      )
      .all(action)
      .map((row) => ({ result: row.result, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }));
  return {
    store,
    database,
    t3,
    refreshes,
    send,
    outboxTexts,
    audits,
    process: () => coordinator.processNext(),
    reconfigure: (next: AgentTagConfig) => {
      coordinator = coordinatorFor(next);
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    choose: (taskId: string, selection: T3ModelSelection | null) =>
      store.setTaskModelSelection({ taskId, selection, selectedBy: "U0EXAMPLE", now: new Date(clock).toISOString() }),
  };
}

describe("per-task model selection (P2b)", () => {
  test("4a: a desired model chosen before the first turn bootstraps the thread with it", async () => {
    const h = await harness();
    const receipt = h.send("fix X");
    h.choose(receipt.taskId, SONNET);
    expect(await h.process()).toMatchObject({ kind: "completed" });

    const [turn] = h.t3.turnStarts();
    expect(turn?.modelSelection).toEqual(SONNET);
    expect(turn?.bootstrap?.createThread?.modelSelection).toEqual(SONNET);
    expect(h.t3.metaUpdates()).toEqual([]);
    // The shared project keeps the profile default.
    expect(h.t3.commands.find((command) => command.type === "project.create")).toMatchObject({ defaultModelSelection: SOL });
    expect(h.store.getTaskExecution(receipt.taskId).appliedModelSelection).toEqual(SONNET);
  });

  test("4b: a same-driver switch on a started thread dispatches thread.meta.update, then the turn carries it", async () => {
    const h = await harness();
    const first = h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(SOL);

    h.choose(first.taskId, MINI);
    const second = h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });

    const switchIndex = h.t3.commands.findIndex((command) => command.type === "thread.meta.update");
    const turnIndex = h.t3.commands.findLastIndex((command) => command.type === "thread.turn.start");
    expect(switchIndex).toBeGreaterThan(-1);
    expect(switchIndex).toBeLessThan(turnIndex);
    expect(h.t3.metaUpdates()).toEqual([{
      type: "thread.meta.update",
      commandId: `${second.operationId}:model`,
      threadId: h.store.getTaskExecution(first.taskId).threadId,
      modelSelection: MINI,
    }]);
    const turn = h.t3.turnStarts().at(-1)!;
    expect(turn.modelSelection).toEqual(MINI);
    expect(turn.bootstrap).toBeUndefined();
    expect(h.t3.threadModel).toEqual(MINI);
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(MINI);
    expect(h.audits("task.model.reverted")).toEqual([]);
  });

  test("4c: a cross-driver switch on a started codex thread is refused; it stays on codex with a reply", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.choose(first.taskId, OPUS);
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.metaUpdates()).toEqual([]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
    const notice = h.outboxTexts().find((text) => text.includes("can't move it"));
    expect(notice).toContain("This thread already started on *Sol*");
    expect(notice).toContain("*Opus 5.5*");
    expect(notice).toContain("cross-provider-started");
    const task = h.store.getTaskExecution(first.taskId);
    expect(task.desiredModelSelection).toEqual(SOL);
    expect(task.appliedModelSelection).toEqual(SOL);
    expect(h.audits("task.model.reverted")).toEqual([{
      result: "refused",
      metadata: { ...SOL, previousInstanceId: OPUS.instanceId, previousModel: OPUS.model, code: "cross-provider-started" },
    }]);
  });

  test("4d: a model outside the allowlist is refused with the allowed list, and the turn uses the default", async () => {
    const h = await harness();
    const receipt = h.send();
    h.choose(receipt.taskId, { instanceId: "codex-work", model: "gpt-5.6-sol" });
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.turnStarts()[0]!.modelSelection).toEqual(SOL);
    const notice = h.outboxTexts().find((text) => text.includes("no longer allowed"));
    expect(notice).toBe(
      "*gpt-5.6-sol* is no longer allowed here, so this thread uses *Sol*. Allowed: *Sol*, *GPT Mini*, *Opus 5.5*, *Sonnet*.",
    );
    expect(h.store.getTaskExecution(receipt.taskId).desiredModelSelection).toBeNull();
    expect(h.audits("task.model.reverted")).toMatchObject([{ result: "revoked", metadata: { code: "not-allowed" } }]);
  });

  test("5: a revoked same-driver choice falls back to the default in place, audited", async () => {
    const h = await harness();
    const first = h.send();
    h.choose(first.taskId, MINI);
    await h.process();
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(MINI);

    h.reconfigure(configWith({ allowedModels: ALLOWED.filter((entry) => entry.model !== MINI.model) }));
    const second = h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.metaUpdates()).toEqual([expect.objectContaining({ commandId: `${second.operationId}:model`, modelSelection: SOL })]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
    const task = h.store.getTaskExecution(first.taskId);
    expect(task.desiredModelSelection).toBeNull();
    expect(task.appliedModelSelection).toEqual(SOL);
    expect(h.audits("task.model.reverted")).toMatchObject([{
      result: "revoked",
      metadata: { instanceId: null, model: null, previousInstanceId: "codex", previousModel: MINI.model },
    }]);
  });

  test("5: a revoked cross-driver choice stays on the applied model (sticky), audited", async () => {
    const h = await harness();
    const first = h.send();
    h.choose(first.taskId, OPUS);
    await h.process();
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(OPUS);

    h.reconfigure(configWith({ allowedModels: ALLOWED.filter((entry) => entry.model !== OPUS.model) }));
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.metaUpdates()).toEqual([]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(OPUS);
    expect(h.outboxTexts().some((text) => text.includes("can't move a started thread to another provider"))).toBe(true);
    expect(h.store.getTaskExecution(first.taskId).desiredModelSelection).toBeNull();
    expect(h.audits("task.model.reverted")).toMatchObject([{ result: "revoked" }]);

    // The next turn stays sticky without another revert or notice.
    const notices = h.outboxTexts().length;
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(OPUS);
    expect(h.audits("task.model.reverted")).toHaveLength(1);
    expect(h.outboxTexts().filter((text) => text.includes("allowed")).length).toBe(1);
    expect(h.outboxTexts().length).toBeGreaterThan(notices);
  });

  test("latent bug: a profile default moved to another driver keeps started threads on what T3 accepted", async () => {
    const h = await harness();
    h.send();
    await h.process();

    h.reconfigure(configWith({ defaultProviderInstanceId: "claudeAgent", defaultModel: OPUS.model, allowedModels: ALLOWED }));
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.metaUpdates()).toEqual([]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
  });

  test("a profile default moved within the driver follows in place on started threads", async () => {
    const h = await harness();
    h.send();
    await h.process();
    h.reconfigure(configWith({ defaultModel: MINI.model, allowedModels: ALLOWED }));
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.metaUpdates().map((command) => command.modelSelection)).toEqual([MINI]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(MINI);
  });

  test("a default change T3 cannot follow (resume state differs) stays on applied with no notice", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.reconfigure(configWith({ defaultProviderInstanceId: "codex-work", allowedModels: ALLOWED }));
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.metaUpdates()).toEqual([]);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
    expect(h.outboxTexts().some((text) => text.includes("can't move"))).toBe(false);
    expect(h.store.getTaskExecution(first.taskId).desiredModelSelection).toBeNull();
  });

  test("a task started before selections were recorded backfills applied from the T3 snapshot", async () => {
    const h = await harness();
    const first = h.send();
    h.choose(first.taskId, MINI);
    await h.process();
    h.database.query("UPDATE tasks SET t3_model_selection_json = NULL, model_selection_json = NULL").run();
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toBeNull();

    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    // The snapshot said MINI; the default SOL is the same driver, so the thread moves back in place.
    expect(h.t3.metaUpdates().map((command) => command.modelSelection)).toEqual([SOL]);
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(SOL);
  });

  test("6: T3 refusing the switch fails as T3ModelSwitchRejected and reverts the desired model", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.choose(first.taskId, MINI);
    h.t3.rejectNextTurn =
      "Thread 'thread-1' cannot switch from instance 'codex' to 'codex' because their provider resume state is incompatible.";
    const second = h.send();
    expect(await h.process()).toMatchObject({ kind: "failed", errorCode: "T3ModelSwitchRejected" });

    const task = h.store.getTaskExecution(first.taskId);
    expect(task.desiredModelSelection).toEqual(SOL);
    expect(task.appliedModelSelection).toEqual(SOL);
    // The projected selection is moved back so the snapshot keeps naming the model in use.
    expect(h.t3.metaUpdates().map((command) => [command.commandId, command.modelSelection])).toEqual([
      [`${second.operationId}:model`, MINI],
      [`${second.operationId}:model-restore`, SOL],
    ]);
    expect(h.t3.threadModel).toEqual(SOL);
    expect(h.outboxTexts().at(-1)).toBe(
      "T3 refused to move this thread to the requested model; it stays on *Sol*. Start a new thread to use a different provider.",
    );
    expect(h.audits("task.model.reverted")).toMatchObject([{ result: "t3-rejected", metadata: { code: "T3ModelSwitchRejected" } }]);
  });

  test("6: T3 refusing a default change pins the accepted model so later turns stop retrying it", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.reconfigure(configWith({ defaultModel: MINI.model, allowedModels: ALLOWED }));
    h.t3.rejectNextTurn =
      "Thread 'thread-1' cannot switch from instance 'codex' to 'codex' because their provider resume state is incompatible.";
    h.send();
    expect(await h.process()).toMatchObject({ kind: "failed", errorCode: "T3ModelSwitchRejected" });

    const task = h.store.getTaskExecution(first.taskId);
    expect(task.desiredModelSelection).toEqual(SOL);
    expect(task.appliedModelSelection).toEqual(SOL);
    expect(h.audits("task.model.reverted")).toEqual([{
      result: "t3-rejected",
      metadata: { ...SOL, code: "T3ModelSwitchRejected" },
    }]);

    const updates = h.t3.metaUpdates().length;
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.metaUpdates()).toHaveLength(updates);
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
    expect(h.audits("task.model.reverted")).toHaveLength(1);
  });

  test("a replay keeps the model frozen for the operation even if the choice changed in between", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.choose(first.taskId, MINI);
    const second = h.send();
    // T3 accepts the switch and the turn, then the snapshot read fails.
    h.t3.failNextFetch = true;
    expect(await h.process()).toMatchObject({ kind: "retry-scheduled" });
    h.choose(first.taskId, null);
    h.advance(60_000);
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.turnStarts().map((command) => command.modelSelection)).toEqual([SOL, MINI, MINI]);
    expect(h.t3.metaUpdates().map((command) => [command.commandId, command.modelSelection])).toEqual([
      [`${second.operationId}:model`, MINI],
      [`${second.operationId}:model`, MINI],
    ]);
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(MINI);
  });

  test("an unreadable stored selection is cleared and audited without its contents", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.database.query("UPDATE tasks SET model_selection_json = ?").run("{\"secret\":\"not a selection\"}");
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });

    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(SOL);
    const row = h.database
      .query<{ model_selection_json: string | null }, []>("SELECT model_selection_json FROM tasks")
      .get();
    expect(row?.model_selection_json).toBeNull();
    expect(h.store.getTaskExecution(first.taskId).invalidModelSelection).toBe(false);
    expect(h.audits("task.model.reverted")).toEqual([{ result: "invalid", metadata: { columns: "model_selection_json" } }]);
    expect(JSON.stringify(h.audits("task.model.reverted"))).not.toContain("secret");
  });

  test("an asynchronous turn-start failure for this message fails fast instead of stalling", async () => {
    const h = await harness();
    h.t3.rejectNextTurn = "Requested provider instance 'codex' is not configured in this build.";
    h.send();
    expect(await h.process()).toMatchObject({ kind: "failed", errorCode: "T3TurnError" });
  });

  test("thread.meta.update uses a stable commandId when the operation is replayed", async () => {
    const h = await harness();
    const first = h.send();
    await h.process();
    h.choose(first.taskId, MINI);
    const second = h.send();
    h.t3.failNextTurnDispatch = true;
    expect(await h.process()).toMatchObject({ kind: "retry-scheduled" });
    h.advance(60_000);
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.metaUpdates().map((command) => command.commandId)).toEqual([
      `${second.operationId}:model`,
      `${second.operationId}:model`,
    ]);
    expect(h.store.getTaskExecution(first.taskId).appliedModelSelection).toEqual(MINI);
  });

  test("without a catalog a started thread only changes model on the same instance", async () => {
    const h = await harness(baseConfig, null);
    const first = h.send();
    await h.process();
    h.choose(first.taskId, MINI);
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(MINI);
    // A stale catalog is refreshed before planning.
    expect(h.refreshes.length).toBe(1);

    h.choose(first.taskId, OPUS);
    h.send();
    expect(await h.process()).toMatchObject({ kind: "completed" });
    expect(h.t3.turnStarts().at(-1)!.modelSelection).toEqual(MINI);
    expect(h.store.getTaskExecution(first.taskId).desiredModelSelection).toEqual(MINI);
  });
});

describe("classifyT3TurnFailure model-switch rejections", () => {
  test.each([
    "Thread 't' cannot switch models after the conversation has started. Start a new thread to use 'grok-5'.",
    "Thread 't' is bound to driver 'codex' and cannot switch to 'claudeAgent'.",
    "Thread 't' cannot switch from instance 'codex' to 'codex-work' because their provider resume state is incompatible.",
  ])("%s", (detail) => {
    expect(classifyT3TurnFailure(detail, { currentModel: "Sol" })).toEqual({
      code: "T3ModelSwitchRejected",
      userMessage:
        "T3 refused to move this thread to the requested model; it stays on *Sol*. Start a new thread to use a different provider.",
    });
    expect(classifyT3TurnFailure(detail).userMessage).toContain("stays on its current model");
  });
});
