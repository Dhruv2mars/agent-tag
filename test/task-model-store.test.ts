import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_MIGRATIONS } from "../src/store/migrations.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";

const firstAt = "2026-09-21T00:00:00.000Z";
const setAt = "2026-09-21T00:01:00.000Z";
const secondSetAt = "2026-09-21T00:02:00.000Z";
const revertAt = "2026-09-21T00:03:00.000Z";

const selectionA = { instanceId: "codex-main", model: "gpt-5.5" };
const selectionB = { instanceId: "claude-main", model: "claude-opus-5-5" };
const selectionC = { instanceId: "codex-main", model: "gpt-6.1-sol" };

function slackEvent(overrides: Partial<SlackEventInput> = {}): SlackEventInput {
  return {
    deliveryId: "delivery-1",
    eventKey: "C1:1000.0001",
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.0001",
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text: "Investigate the failure",
    receivedAt: firstAt,
    sourceOrderKey: "1000.0001",
    ...overrides,
  };
}

interface TaskFixture {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly taskId: string;
  readonly threadId: string;
}

async function withTask(run: (fixture: TaskFixture) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-task-model-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    const receipt = store.ingestSlackEvent(slackEvent());
    const threadId = "t3-thread-1";
    store.bindT3Task({ taskId: receipt.taskId, projectId: "t3-project-1", threadId, now: firstAt });
    await run({ store, path, taskId: receipt.taskId, threadId });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-task-model-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function withDirectDatabase<T>(path: string, read: (database: Database) => T): T {
  const database = new Database(path);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function modelAuditRows(store: AgentTagStore, action: string, taskId: string) {
  return store
    .listAuditRecords({ limit: 10_000 })
    .filter((record) => record.action === action && record.target === taskId);
}

describe("per-task model selection store", () => {
  test("a new task has no desired or applied model selection", async () => {
    await withTask(({ store, taskId }) => {
      const execution = store.getTaskExecution(taskId);
      expect(execution.desiredModelSelection).toBeNull();
      expect(execution.appliedModelSelection).toBeNull();
    });
  });

  test("setTaskModelSelection stores the desired selection, selector columns, and one audit row", async () => {
    await withTask(({ store, path, taskId }) => {
      store.setTaskModelSelection({ taskId, selection: selectionA, selectedBy: "U1", now: setAt });

      expect(store.getTaskExecution(taskId).desiredModelSelection).toEqual(selectionA);
      expect(store.getTaskExecution(taskId).appliedModelSelection).toBeNull();

      const columns = withDirectDatabase(path, (database) =>
        database
          .query<{ model_selected_by: string | null; model_selected_at: string | null }, [string]>(
            "SELECT model_selected_by, model_selected_at FROM tasks WHERE task_id = ?",
          )
          .get(taskId),
      );
      expect(columns).toEqual({ model_selected_by: "U1", model_selected_at: setAt });

      const rows = modelAuditRows(store, "task.model.selected", taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe("accepted");
      expect(rows[0]?.metadata).toEqual({ instanceId: selectionA.instanceId, model: selectionA.model });
    });
  });

  test("a second setTaskModelSelection audits the previous choice in metadata", async () => {
    await withTask(({ store, taskId }) => {
      store.setTaskModelSelection({ taskId, selection: selectionA, selectedBy: "U1", now: setAt });
      store.setTaskModelSelection({ taskId, selection: selectionC, selectedBy: "U2", now: secondSetAt });

      expect(store.getTaskExecution(taskId).desiredModelSelection).toEqual(selectionC);

      const rows = modelAuditRows(store, "task.model.selected", taskId);
      expect(rows).toHaveLength(2);
      const second = rows[1];
      expect(second?.actorId).toBe("U2");
      expect(second?.metadata).toEqual({
        instanceId: selectionC.instanceId,
        model: selectionC.model,
        previousInstanceId: selectionA.instanceId,
        previousModel: selectionA.model,
      });
      expect(Object.keys(second?.metadata ?? {}).sort()).toEqual([
        "instanceId",
        "model",
        "previousInstanceId",
        "previousModel",
      ]);
    });
  });

  test("recordAppliedModelSelection sets the applied selection for the matching thread", async () => {
    await withTask(({ store, taskId, threadId }) => {
      const written = store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt });

      expect(written).toBe(true);
      expect(store.getTaskExecution(taskId).appliedModelSelection).toEqual(selectionA);
    });
  });

  test("recordAppliedModelSelection leaves the task alone when the thread id differs", async () => {
    await withTask(({ store, taskId }) => {
      const written = store.recordAppliedModelSelection({
        taskId,
        threadId: "t3-thread-other",
        selection: selectionA,
        now: setAt,
      });

      expect(written).toBe(false);
      expect(store.getTaskExecution(taskId).appliedModelSelection).toBeNull();
    });
  });

  test("recordAppliedModelSelection returns false when the identical selection is re-recorded", async () => {
    await withTask(({ store, taskId, threadId }) => {
      expect(store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt })).toBe(true);
      expect(store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: secondSetAt })).toBe(
        false,
      );
      expect(store.getTaskExecution(taskId).appliedModelSelection).toEqual(selectionA);
    });
  });

  test("revoked revert drops the desired selection and audits the dropped one", async () => {
    await withTask(({ store, taskId, threadId }) => {
      store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt });
      store.setTaskModelSelection({ taskId, selection: selectionB, selectedBy: "U1", now: secondSetAt });

      const dropped = store.revertDesiredModelSelection({
        taskId,
        reason: "revoked",
        code: "model-not-allowed",
        correlationId: "corr-revoked",
        now: revertAt,
      });

      expect(dropped).toEqual({ previous: selectionB, next: null });
      expect(store.getTaskExecution(taskId).desiredModelSelection).toBeNull();

      const rows = modelAuditRows(store, "task.model.reverted", taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe("revoked");
      expect(rows[0]?.metadata).toEqual({
        instanceId: null,
        model: null,
        previousInstanceId: selectionB.instanceId,
        previousModel: selectionB.model,
        code: "model-not-allowed",
      });
    });
  });

  test("refused revert makes the desired selection the applied one, and a repeat is a no-op", async () => {
    await withTask(({ store, taskId, threadId }) => {
      store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt });
      store.setTaskModelSelection({ taskId, selection: selectionB, selectedBy: "U1", now: secondSetAt });

      const dropped = store.revertDesiredModelSelection({
        taskId,
        reason: "refused",
        code: "switch-refused",
        correlationId: "corr-refused",
        now: revertAt,
      });

      expect(dropped).toEqual({ previous: selectionB, next: selectionA });
      const afterFirst = store.getTaskExecution(taskId);
      expect(afterFirst.desiredModelSelection).toEqual(selectionA);
      expect(afterFirst.appliedModelSelection).toEqual(selectionA);
      expect(modelAuditRows(store, "task.model.reverted", taskId)).toHaveLength(1);

      const repeat = store.revertDesiredModelSelection({
        taskId,
        reason: "refused",
        code: "switch-refused",
        correlationId: "corr-refused-again",
        now: "2026-09-21T00:04:00.000Z",
      });

      expect(repeat).toBeNull();
      expect(store.getTaskExecution(taskId).desiredModelSelection).toEqual(selectionA);
      expect(modelAuditRows(store, "task.model.reverted", taskId)).toHaveLength(1);
    });
  });

  test("reverting a task with no desired selection returns null and writes no audit", async () => {
    await withTask(({ store, taskId }) => {
      const dropped = store.revertDesiredModelSelection({
        taskId,
        reason: "revoked",
        code: "model-not-allowed",
        correlationId: "corr-none",
        now: revertAt,
      });

      expect(dropped).toBeNull();
      expect(store.getTaskExecution(taskId).desiredModelSelection).toBeNull();
      expect(modelAuditRows(store, "task.model.reverted", taskId)).toHaveLength(0);
    });
  });

  test("a T3 rejection keeps the default unset, records the rejected target, and audits once", async () => {
    await withTask(({ store, taskId, threadId }) => {
      store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt });
      const input = {
        taskId,
        threadId,
        rejected: selectionB,
        code: "T3ModelSwitchRejected",
        correlationId: "corr-reject",
        now: revertAt,
      };

      expect(store.recordModelRejection({ ...input, threadId: "other-thread" })).toBe(false);
      expect(store.recordModelRejection(input)).toBe(true);
      const task = store.getTaskExecution(taskId);
      expect(task.desiredModelSelection).toBeNull();
      expect(task.rejectedModelSelection).toEqual(selectionB);
      expect(store.recordModelRejection(input)).toBe(false);
      expect(modelAuditRows(store, "task.model.reverted", taskId)).toHaveLength(1);

      // A new applied selection clears the rejection, which was relative to the old one.
      store.recordAppliedModelSelection({ taskId, threadId, selection: selectionB, now: "2026-09-21T00:05:00.000Z" });
      expect(store.getTaskExecution(taskId).rejectedModelSelection).toBeNull();
    });
  });

  test("a T3 rejection of a desired selection reverts it to the applied one", async () => {
    await withTask(({ store, taskId, threadId }) => {
      store.recordAppliedModelSelection({ taskId, threadId, selection: selectionA, now: setAt });
      store.setTaskModelSelection({ taskId, selection: selectionB, selectedBy: "U1", now: secondSetAt });
      expect(store.recordModelRejection({
        taskId,
        threadId,
        rejected: selectionB,
        code: "T3ModelSwitchRejected",
        correlationId: "corr-reject",
        now: revertAt,
      })).toBe(true);
      expect(store.getTaskExecution(taskId).desiredModelSelection).toEqual(selectionA);
    });
  });

  test("invalid JSON and wrong-shape JSON in the selection columns read as null without throwing", async () => {
    await withTask(({ store, path, taskId }) => {
      withDirectDatabase(path, (database) => {
        database.query("UPDATE tasks SET model_selection_json = ? WHERE task_id = ?").run("not json", taskId);
        database
          .query("UPDATE tasks SET t3_model_selection_json = ? WHERE task_id = ?")
          .run(JSON.stringify({ instanceId: 3, model: "gpt-5.5" }), taskId);
      });

      let execution: ReturnType<AgentTagStore["getTaskExecution"]> | undefined;
      expect(() => {
        execution = store.getTaskExecution(taskId);
      }).not.toThrow();
      expect(execution?.desiredModelSelection).toBeNull();
      expect(execution?.appliedModelSelection).toBeNull();

      withDirectDatabase(path, (database) => {
        database
          .query("UPDATE tasks SET model_selection_json = ?, t3_model_selection_json = ? WHERE task_id = ?")
          .run(JSON.stringify({ instanceId: "codex-main" }), JSON.stringify(["codex-main", "gpt-5.5"]), taskId);
      });
      expect(() => {
        execution = store.getTaskExecution(taskId);
      }).not.toThrow();
      expect(execution?.desiredModelSelection).toBeNull();
      expect(execution?.appliedModelSelection).toBeNull();
    });
  });

  test("a fresh store has the model selection columns and migration 18 recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-task-model-"));
    const path = join(directory, "agent-tag.sqlite");
    const store = await AgentTagStore.open(path);
    try {
      expect(STORE_MIGRATIONS.some((migration) => migration.version === 18)).toBe(true);
      const columns = withDirectDatabase(path, (database) =>
        database
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')")
          .all()
          .map((column) => column.name),
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          "model_selection_json",
          "model_selected_by",
          "model_selected_at",
          "t3_model_selection_json",
        ]),
      );
      const version = withDirectDatabase(path, (database) =>
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations WHERE version = 18")
          .get(),
      );
      expect(version).toEqual({ version: 18 });
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-task-model-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
