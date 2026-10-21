import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { LifecycleWorker } from "../src/lifecycle-worker.ts";
import { AgentTagSchedules, ScheduleWorker } from "../src/scheduler.ts";
import { AgentTagStore, type IngestReceipt, type SlackEventInput } from "../src/store/store.ts";
import { taskBranchName } from "../src/store/tasks.ts";

const startedAt = "2026-10-01T00:00:00.000Z";
const weekLater = "2026-10-08T00:00:01.000Z";
const policy = {
  closeIdleAfterHours: 168,
  sweepIntervalSeconds: 60,
  maxClosesPerSweep: 20,
  dirtyWorktreeRetentionDays: 14,
  deleteEmptyBranches: true,
  maxCleanupsPerSweep: 5,
} as const;

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
    receivedAt: startedAt,
    sourceOrderKey: "1000.0001",
    ...overrides,
  };
}

function reply(n: number, receivedAt: string, overrides: Partial<SlackEventInput> = {}): SlackEventInput {
  const ts = `1000.${String(n).padStart(4, "0")}`;
  return slackEvent({ deliveryId: `delivery-${n}`, eventKey: `C1:${ts}`, sourceOrderKey: ts, receivedAt, text: `reply ${n}`, ...overrides });
}

interface Fixture {
  readonly store: AgentTagStore;
  readonly database: Database;
}

async function withStore(run: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-lifecycle-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const database = new Database(path, { strict: true });
  try {
    await run({ store, database });
  } finally {
    database.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-lifecycle-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

/** Runs the queued turn to completion and delivers its reply, leaving the task quiet. */
function settleTurn(store: AgentTagStore, receipt: IngestReceipt, now: string, options: { started?: boolean } = {}): void {
  const claimed = store.claimNextOperation({ workerId: "w", now, leaseMs: 10_000, maxConcurrentTasks: 1 });
  if (claimed === null || claimed.operationId !== receipt.operationId) throw new Error("operation was not claimable");
  if (options.started ?? true) {
    store.markOperationTurnDispatched({ operationId: claimed.operationId, workerId: "w", now });
    store.markOperationTurnStarted({ operationId: claimed.operationId, workerId: "w", turnId: null, now });
    store.markT3ThreadStarted({ taskId: claimed.taskId, threadId: store.getTaskExecution(claimed.taskId).threadId, now });
  }
  store.completeOperationWithOutbox({
    operationId: claimed.operationId,
    taskId: claimed.taskId,
    workerId: "w",
    resultSequence: 1,
    conversationId: "C1",
    threadTs: "1000.0001",
    text: "done",
    now,
  });
  const outbox = store.claimNextOutbox({ workerId: "o", now, leaseMs: 10_000 });
  if (outbox === null) throw new Error("reply was not queued");
  store.markOutboxDelivered({ outboxId: outbox.outboxId, workerId: "o", slackMessageTs: "1000.9999", now });
}

function taskRow(database: Database, taskId: string) {
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT state, session_generation, t3_thread_id, t3_thread_started_at, closed_at, close_reason,
              close_requested_at, last_activity_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
}

function audits(store: AgentTagStore, action: string) {
  return store.listAuditRecords({ limit: 1_000 }).filter((record) => record.action === action);
}

function retiredRows(database: Database, taskId: string) {
  return database
    .query<Record<string, unknown>, [string]>(`SELECT * FROM task_retired_t3_threads WHERE task_id = ? ORDER BY generation`)
    .all(taskId);
}

describe("task lifecycle: close", () => {
  test("the worker closes a task idle past closeIdleAfterHours and records its retired thread", async () => {
    await withStore(async ({ store, database }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt);
      const before = store.getTaskExecution(receipt.taskId);

      const early = new LifecycleWorker({ store, policy, now: () => new Date("2026-10-07T23:59:00.000Z") });
      expect(await early.processNext()).toEqual({ kind: "idle" });
      expect(taskRow(database, receipt.taskId)?.state).toBe("active");

      const worker = new LifecycleWorker({ store, policy, now: () => new Date(weekLater) });
      expect(await worker.processNext()).toEqual({ kind: "tasks-closed", count: 1 });
      expect(taskRow(database, receipt.taskId)).toMatchObject({ state: "closed", closed_at: weekLater, close_reason: "idle" });
      expect(retiredRows(database, receipt.taskId)).toEqual([
        expect.objectContaining({
          generation: 1,
          t3_project_id: before.projectId,
          t3_thread_id: before.threadId,
          repository_root: "/srv/repos/example",
          branch: `agent-tag/${receipt.taskId}`,
          reason: "idle",
          retired_at: weekLater,
          thread_created: 1,
          session_stop_command_id: `${receipt.taskId}:g1:session.stop`,
          delete_command_id: `${receipt.taskId}:g1:thread.delete`,
          worktree_state: "unknown",
          branch_state: "unknown",
          completed_at: null,
        }),
      ]);
      expect(audits(store, "task.closed")).toEqual([
        expect.objectContaining({ actorId: "lifecycle-worker", target: receipt.taskId, metadata: { reason: "idle", generation: 1 } }),
      ]);
      // Throttled, then nothing left to close.
      expect(await worker.processNext()).toEqual({ kind: "idle" });
    });
  });

  test("a task whose thread never started retires an already completed row", async () => {
    await withStore(({ store, database }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt, { started: false });
      expect(store.closeTask({ taskId: receipt.taskId, reason: "admin", actorId: "test", now: weekLater })).toEqual({
        kind: "closed",
        reason: "admin",
        generation: 1,
      });
      expect(retiredRows(database, receipt.taskId)).toEqual([
        expect.objectContaining({ thread_created: 0, worktree_state: "none", branch_state: "deleted", completed_at: weekLater }),
      ]);
      expect(store.closeTask({ taskId: receipt.taskId, reason: "admin", actorId: "test", now: weekLater })).toEqual({
        kind: "not-active",
      });
    });
  });

  test("queued, running, or undelivered work blocks the close", async () => {
    const guards: ReadonlyArray<readonly [string, (fixture: Fixture, receipt: IngestReceipt) => void]> = [
      ["pending operation", ({ store }) => {
        store.ingestSlackEvent(reply(2, startedAt));
      }],
      ["inflight operation", ({ store }) => {
        store.ingestSlackEvent(reply(2, startedAt));
        store.claimNextOperation({ workerId: "w", now: startedAt, leaseMs: 10_000, maxConcurrentTasks: 1 });
      }],
      ["open interaction", ({ database }, receipt) => {
        database
          .query(
            `INSERT INTO interactions (interaction_id, task_id, operation_id, thread_id, request_id, kind, prompt_json,
               state, response_command_id, created_at, updated_at)
             SELECT 'i1', t.task_id, ?, t.t3_thread_id, 'r1', 'approval', '{}', 'pending', 'c1', ?, ?
             FROM tasks t WHERE t.task_id = ?`,
          )
          .run(receipt.operationId, startedAt, startedAt, receipt.taskId);
      }],
      ["undelivered reply", ({ database }) => {
        database.query(`UPDATE slack_outbox SET status = 'pending'`).run();
      }],
      ["pending reaction", ({ database }, receipt) => {
        database
          .query(
            `INSERT INTO slack_reactions (reaction_key, task_id, operation_id, conversation_id, message_ts, name, status,
               created_at, updated_at) VALUES ('k1', ?, ?, 'C1', '1000.0001', 'eyes', 'pending', ?, ?)`,
          )
          .run(receipt.taskId, receipt.operationId, startedAt, startedAt);
      }],
      ["pending PR job", ({ database }, receipt) => {
        database
          .query(
            `INSERT INTO pr_sync_jobs (job_id, task_id, operation_id, conversation_id, thread_ts, actor_user_id,
               github_repo, base_branch, status, created_at, updated_at)
             VALUES ('j1', ?, ?, 'C1', '1000.0001', 'U1', 'o/r', 'main', 'pending', ?, ?)`,
          )
          .run(receipt.taskId, receipt.operationId, startedAt, startedAt);
      }],
    ];
    for (const [name, block] of guards) {
      await withStore(async (fixture) => {
        const { store, database } = fixture;
        const receipt = store.ingestSlackEvent(slackEvent());
        settleTurn(store, receipt, startedAt);
        block(fixture, receipt);
        const worker = new LifecycleWorker({ store, policy, now: () => new Date(weekLater) });
        expect({ name, outcome: await worker.processNext() }).toEqual({ name, outcome: { kind: "idle" } });
        expect({ name, result: store.closeTask({ taskId: receipt.taskId, reason: "admin", actorId: "t", now: weekLater }) })
          .toEqual({ name, result: { kind: "busy" } });
        expect(taskRow(database, receipt.taskId)?.state).toBe("active");
        expect(retiredRows(database, receipt.taskId)).toEqual([]);
      });
    }
  });

  test("an event that lands after listing keeps the task open", async () => {
    await withStore(({ store, database }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt);
      const idleBefore = "2026-10-01T00:00:00.500Z";
      expect(store.listCloseCandidates({ idleBefore, limit: 10 })).toEqual([receipt.taskId]);
      // A reply arrives and its turn settles between the sweep's list and its close.
      const next = store.ingestSlackEvent(reply(2, "2026-10-01T00:00:01.000Z"));
      settleTurn(store, next, "2026-10-01T00:00:01.000Z");
      expect(store.closeTask({ taskId: receipt.taskId, reason: "idle", actorId: "w", now: weekLater, idleBefore })).toEqual({
        kind: "busy",
      });
      expect(taskRow(database, receipt.taskId)?.state).toBe("active");
    });
  });

  test("a requested close waits for in-flight work, then the worker closes it", async () => {
    await withStore(async ({ store, database }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      expect(store.requestTaskClose({ taskId: receipt.taskId, reason: "admin", actorId: "cli", now: startedAt })).toEqual({
        kind: "requested",
      });
      expect(taskRow(database, receipt.taskId)).toMatchObject({ state: "active", close_requested_at: startedAt, close_reason: "admin" });
      const worker = new LifecycleWorker({ store, policy, now: () => new Date(startedAt) });
      expect(await worker.processNext()).toEqual({ kind: "idle" });

      const later = "2026-10-01T00:05:00.000Z";
      settleTurn(store, receipt, later);
      const after = new LifecycleWorker({ store, policy, now: () => new Date(later) });
      expect(await after.processNext()).toEqual({ kind: "tasks-closed", count: 1 });
      expect(taskRow(database, receipt.taskId)).toMatchObject({ state: "closed", close_reason: "admin", close_requested_at: null });
      expect(audits(store, "task.close.requested")).toHaveLength(1);
      expect(audits(store, "task.closed")).toEqual([
        expect.objectContaining({ actorType: "operator", metadata: { reason: "admin", generation: 1 } }),
      ]);
      expect(store.requestTaskClose({ taskId: receipt.taskId, reason: "admin", actorId: "cli", now: later })).toEqual({
        kind: "not-active",
      });
    });
  });

  test("listTasks reports state, generation and close details", async () => {
    await withStore(({ store }) => {
      const first = store.ingestSlackEvent(slackEvent());
      settleTurn(store, first, startedAt);
      store.closeTask({ taskId: first.taskId, reason: "admin", actorId: "t", now: weekLater });
      const second = store.ingestSlackEvent(slackEvent({
        deliveryId: "delivery-other",
        eventKey: "C1:2000.0001",
        threadTs: "2000.0001",
        sourceOrderKey: "2000.0001",
        receivedAt: weekLater,
      }));
      expect(store.listTasks({ limit: 10 }).map((task) => [task.taskId, task.state])).toEqual([
        [second.taskId, "active"],
        [first.taskId, "closed"],
      ]);
      expect(store.listTasks({ state: "closed", limit: 10 })).toEqual([
        expect.objectContaining({ taskId: first.taskId, generation: 1, closeReason: "admin", closedAt: weekLater }),
      ]);
      expect(store.listTasks({ state: "active", limit: 1 })).toHaveLength(1);
    });
  });
});

describe("task lifecycle: reopen", () => {
  test("a reply in a closed thread reopens the same task as a new generation", async () => {
    await withStore(({ store, database }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt);
      const before = store.getTaskExecution(receipt.taskId);
      // Generation 1's PR was merged; its url moves to the retired row and the binding is dropped on reopen.
      database.query(
        `INSERT INTO task_pull_requests (task_id, github_repo, head_branch, base_branch, pr_number, pr_url, state, created_at, updated_at)
         VALUES (?, 'acme/example', ?, 'main', 7, 'https://github.com/acme/example/pull/7', 'merged', ?, ?)`,
      ).run(receipt.taskId, taskBranchName(receipt.taskId, 1), startedAt, startedAt);
      store.closeTask({ taskId: receipt.taskId, reason: "idle", actorId: "w", now: weekLater });
      expect(retiredRows(database, receipt.taskId)[0]?.pr_url).toBe("https://github.com/acme/example/pull/7");
      expect(store.findTaskForThread({ workspaceId: "T1", conversationId: "C1", threadTs: "1000.0001" })).toMatchObject({
        taskId: receipt.taskId,
        state: "closed",
      });
      // ensureTaskForThread (used by commands) reports the task without reopening it.
      expect(store.ensureTaskForThread({
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.0001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        now: weekLater,
      })).toBe(receipt.taskId);
      expect(taskRow(database, receipt.taskId)?.state).toBe("closed");

      const reopenedAt = "2026-10-09T00:00:00.000Z";
      const next = store.ingestSlackEvent(reply(2, reopenedAt));
      expect(next.taskId).toBe(receipt.taskId);
      const after = store.getTaskExecution(receipt.taskId);
      expect(after).toMatchObject({ state: "active", sessionGeneration: 2, threadStarted: false, projectId: before.projectId });
      expect(after.threadId).not.toBe(before.threadId);
      expect(store.getTaskPullRequest(receipt.taskId)).toBeNull();
      expect(taskRow(database, receipt.taskId)).toMatchObject({
        t3_thread_started_at: null,
        closed_at: null,
        close_reason: null,
        last_activity_at: reopenedAt,
      });
      expect(audits(store, "task.reopened")).toEqual([
        expect.objectContaining({ source: receipt.taskId, target: after.threadId, metadata: { generation: 2 } }),
      ]);
      expect(taskBranchName(receipt.taskId, after.sessionGeneration)).toBe(`agent-tag/${receipt.taskId}-g2`);

      // Generation 2 closes into its own retired row.
      settleTurn(store, next, reopenedAt);
      expect(store.closeTask({ taskId: receipt.taskId, reason: "admin", actorId: "t", now: reopenedAt })).toMatchObject({
        generation: 2,
      });
      expect(retiredRows(database, receipt.taskId).map((row) => [row.generation, row.branch, row.t3_thread_id])).toEqual([
        [1, `agent-tag/${receipt.taskId}`, before.threadId],
        [2, `agent-tag/${receipt.taskId}-g2`, after.threadId],
      ]);
    });
  });

  test("a closed task still refuses a reroute to another profile or repository", async () => {
    await withStore(({ store }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt);
      store.closeTask({ taskId: receipt.taskId, reason: "idle", actorId: "w", now: weekLater });
      expect(() => store.ingestSlackEvent(reply(2, weekLater, { repositoryRoot: "/srv/repos/other" }))).toThrow();
      expect(store.getTaskExecution(receipt.taskId)).toMatchObject({ state: "closed", sessionGeneration: 1 });
    });
  });

  test("a scheduled run on a closed task reopens it", async () => {
    const config = agentTagConfigSchema.parse({
      version: 1,
      dataDir: "/var/lib/agent-tag",
      t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
      slack: {
        workspaceId: "T1",
        appTokenFile: "/var/lib/agent-tag/slack-app-token",
        botTokenFile: "/var/lib/agent-tag/slack-bot-token",
      },
      access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
      profiles: [
        {
          id: "engineering",
          repositoryRoots: ["/srv/repos/example"],
          defaultProviderInstanceId: "codex",
          defaultModel: "gpt-5.6-sol",
          runtimeMode: "approval-required",
          isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
          externalWrites: { mode: "deny" },
          memory: { shared: true, privateDm: false, retentionDays: 30 },
        },
      ],
      routes: [{ conversationId: "C1", profileId: "engineering" }],
      limits: { maxConcurrentTasks: 1, maxActiveSchedules: 10 },
    });
    expect(config.lifecycle).toEqual(policy);
    await withStore(async ({ store }) => {
      const receipt = store.ingestSlackEvent(slackEvent());
      settleTurn(store, receipt, startedAt);
      const schedules = new AgentTagSchedules({ config, store });
      const created = schedules.create({
        context: { workspaceId: "T1", actorUserId: "U1", profileId: "engineering", taskId: receipt.taskId },
        spec: {
          kind: "agent",
          prompt: "run the weekly check",
          runAt: "2026-10-09T00:00:00.000Z",
          missedRunPolicy: "run-once",
          misfireGraceSeconds: 60,
          overlapPolicy: "skip",
        },
        now: startedAt,
      });
      if (created.kind !== "accepted") throw new Error(`schedule fixture denied: ${created.reason}`);
      store.closeTask({ taskId: receipt.taskId, reason: "idle", actorId: "w", now: weekLater });
      expect(store.listSchedules(receipt.taskId)).toHaveLength(1);
      // Schedules survive the close, and a closed thread can take a new one (a routine asked for there).
      expect(schedules.create({
        context: { workspaceId: "T1", actorUserId: "U1", profileId: "engineering", taskId: receipt.taskId },
        spec: {
          kind: "reminder",
          prompt: "later",
          runAt: "2026-10-10T00:00:00.000Z",
          missedRunPolicy: "run-once",
          misfireGraceSeconds: 60,
          overlapPolicy: "skip",
        },
        now: weekLater,
      })).toMatchObject({ kind: "accepted", schedule: { taskId: receipt.taskId } });
      expect(store.getTaskExecution(receipt.taskId)).toMatchObject({ state: "closed", sessionGeneration: 1 });

      const due = "2026-10-09T00:00:00.000Z";
      const worker = new ScheduleWorker({ config, store, workerId: "schedule-a", now: () => new Date(due) });
      expect(await worker.processNext()).toMatchObject({ kind: "dispatched" });
      expect(store.getTaskExecution(receipt.taskId)).toMatchObject({ state: "active", sessionGeneration: 2 });
      const scheduled = store.claimNextOperation({ workerId: "w", now: due, leaseMs: 10_000, maxConcurrentTasks: 1 });
      // The fresh T3 thread rereads the Slack thread up to the run, as a reopening reply would.
      expect(scheduled).toMatchObject({
        taskId: receipt.taskId,
        payload: { text: "run the weekly check", threadContext: { rootTs: "1000.0001", beforeTs: `${Date.parse(due) / 1_000}.000000` } },
      });
    });
  });
});
