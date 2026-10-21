import { describe, expect, test } from "bun:test";

import * as replies from "../src/commands/replies.ts";
import { TaskRestartWorker } from "../src/restart-worker.ts";
import type { T3Command } from "../src/t3/gateway.ts";
import { type CommandHarness, makeConfig, message, THREAD, withCommandHarness } from "./fixtures/command-harness.ts";

const config = makeConfig({ commands: { restartTimeoutSeconds: 30 } });

function worker(h: CommandHarness, dispatched: T3Command[] = [], fail?: (command: T3Command) => unknown) {
  return new TaskRestartWorker({
    store: h.store,
    config: () => config,
    dispatch: async (command) => {
      dispatched.push(command);
      const error = fail?.(command);
      if (error !== undefined) throw error;
      return { sequence: 1 };
    },
    now: () => new Date(h.clock.now),
  });
}

function task(h: CommandHarness) {
  return h.db
    .query(
      `SELECT task_id, session_generation, t3_thread_id, t3_thread_started_at, restart_requested_at, restart_requested_by
       FROM tasks`,
    )
    .get() as {
    task_id: string;
    session_generation: number;
    t3_thread_id: string;
    t3_thread_started_at: string | null;
    restart_requested_at: string | null;
    restart_requested_by: string | null;
  };
}

function retired(h: CommandHarness) {
  return h.db
    .query(
      `SELECT generation, t3_thread_id, branch, reason, thread_created, session_stop_command_id, session_stopped_at,
              last_error_code, next_attempt_at FROM task_retired_t3_threads ORDER BY generation`,
    )
    .all() as Record<string, unknown>[];
}

/** Binds THREAD with one turn sent to and started in T3, still running. */
async function runningTurn(h: CommandHarness) {
  await h.send(message(THREAD, "<@U0BOT> investigate"));
  const turn = h.claim();
  if (turn === null) throw new Error("no operation");
  h.startTurn(turn);
  return turn;
}

const ready = (rereads: boolean, forced = false) => replies.restartReadyReply({ actorUserId: "U1", rereads, forced }).text;

describe("!restart", () => {
  test("an idle thread rotates now: new thread id, generation 2, retired row and the confirmation", async () => {
    await withCommandHarness(config, async (h) => {
      const turn = await runningTurn(h);
      h.store.completeOperationWithOutbox({
        operationId: turn.operationId,
        taskId: turn.taskId,
        workerId: "w",
        resultSequence: 1,
        conversationId: "C1",
        threadTs: THREAD,
        text: "done",
        now: h.iso(),
      });
      const before = task(h);
      expect(before.t3_thread_started_at).not.toBeNull();

      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      const after = task(h);
      expect(after).toMatchObject({ session_generation: 2, t3_thread_started_at: null, restart_requested_at: null });
      expect(after.t3_thread_id).not.toBe(before.t3_thread_id);
      expect(after.t3_thread_id).toStartWith("agent-tag-thread-");
      expect(retired(h)).toEqual([
        expect.objectContaining({
          generation: 1,
          t3_thread_id: before.t3_thread_id,
          branch: `agent-tag/${before.task_id}`,
          reason: "restart",
          thread_created: 1,
          session_stop_command_id: `${before.task_id}:g1:session.stop`,
          session_stopped_at: null,
        }),
      ]);
      expect(h.outboxTexts()).toEqual(["done", ready(true)]);
      expect(h.sent).toEqual([]);
      expect(h.auditActions()).toEqual(expect.arrayContaining(["task.restart.requested", "task.session.rotated"]));
      expect(h.store.getTaskExecution(before.task_id)).toMatchObject({ sessionGeneration: 2, threadStarted: false });
    });
  });

  test("a busy thread stops the turn, holds new requests until the worker rotates, then runs them on the new thread", async () => {
    await withCommandHarness(config, async (h) => {
      const turn = await runningTurn(h);
      const oldThread = task(h).t3_thread_id;
      await h.send(message("1000.000004", "<@U0BOT> after the restart"));
      await h.send(message("1000.000003", "<@U0BOT> !restart", { user: "U2" }));
      expect(task(h)).toMatchObject({ restart_requested_by: "U2", t3_thread_id: oldThread, session_generation: 1 });
      expect(h.outboxTexts()).toEqual([replies.restartingReply("U2").text]);
      expect(h.db.query("SELECT state, response_actor_id FROM interactions WHERE kind = 'cancel'").get()).toEqual({
        state: "response-pending",
        response_actor_id: "U2",
      });

      // Still running: the worker waits.
      expect(await worker(h).processNext()).toEqual({ kind: "idle" });
      await h.send(message("1000.000005", "<@U0BOT> !status"));
      expect(h.sent.at(-1)?.text).toContain("I'm restarting this thread's session.");
      await h.send(message("1000.000006", "<@U0BOT> !restart"));
      expect(h.sent.at(-1)?.text).toBe(replies.RESTART_PENDING.text);

      // T3 reports the turn interrupted; the claim gate still holds the queued request.
      h.store.cancelOperationWithOutbox({
        operationId: turn.operationId,
        taskId: turn.taskId,
        workerId: "w",
        conversationId: "C1",
        threadTs: THREAD,
        now: h.iso(),
      });
      expect(h.claim()).toBeNull();

      h.clock.now += 1_000;
      expect(await worker(h).processNext()).toMatchObject({ kind: "progressed", rotated: 1 });
      const rotated = task(h);
      expect(rotated).toMatchObject({ session_generation: 2, restart_requested_at: null, t3_thread_started_at: null });
      expect(rotated.t3_thread_id).not.toBe(oldThread);
      expect(h.outboxTexts()).toContain(replies.restartReadyReply({ actorUserId: "U2", rereads: true, forced: false }).text);

      const next = h.claim();
      expect(next?.payload.text).toContain("after the restart");
      expect(h.store.getTaskExecution(rotated.task_id)).toMatchObject({ threadId: rotated.t3_thread_id, sessionGeneration: 2 });
    });
  });

  test("past restartTimeoutSeconds the worker rotates anyway and warns; the old turn cannot mark the new thread", async () => {
    await withCommandHarness(config, async (h) => {
      const turn = await runningTurn(h);
      const oldThread = task(h).t3_thread_id;
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      h.clock.now += 29_000;
      expect(await worker(h).processNext()).toEqual({ kind: "idle" });
      h.store.renewOperationLease({ operationId: turn.operationId, workerId: "w", now: h.iso(), leaseMs: 60_000 });
      h.clock.now += 2_000;
      expect(await worker(h).processNext()).toMatchObject({ kind: "progressed", rotated: 1 });
      expect(h.outboxTexts().at(-1)).toBe(ready(true, true));
      expect(h.auditActions()).toContain("task.session.rotated");
      // The turn kept its live lease and still runs on the retired thread.
      expect(h.operations()[0]?.status).toBe("inflight");
      h.store.markT3ThreadStarted({ taskId: turn.taskId, threadId: oldThread, now: h.iso() });
      expect(task(h).t3_thread_started_at).toBeNull();
    });
  });

  test("a turn whose worker died (lease lapsed) is ended by the rotation", async () => {
    await withCommandHarness(config, async (h) => {
      const turn = await runningTurn(h);
      h.store.openStatusMessage({
        operationId: turn.operationId,
        taskId: turn.taskId,
        conversationId: "C1",
        threadTs: THREAD,
        message: () => ({ text: "Working" }),
        now: h.iso(),
      });
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      h.clock.now += 61_000;
      expect(await worker(h).processNext()).toMatchObject({ kind: "progressed", rotated: 1 });
      expect(h.outboxTexts().at(-1)).toBe(ready(true));
      expect(h.operations()[0]).toMatchObject({ status: "failed", last_error_code: "user-cancelled" });
      expect(h.db.query("SELECT state, actor_user_id FROM status_messages").get()).toEqual({ state: "stopped", actor_user_id: "U1" });
    });
  });

  test("queued requests before the command are dropped and an open approval of the retired thread is closed", async () => {
    await withCommandHarness(config, async (h) => {
      const turn = await runningTurn(h);
      h.store.recordPendingInteraction({
        taskId: turn.taskId,
        operationId: turn.operationId,
        threadId: task(h).t3_thread_id,
        requestId: "approval-1",
        kind: "approval",
        prompt: { summary: "run tests" },
        conversationId: "C1",
        threadTs: THREAD,
        message: () => ({ text: "Approve?" }),
        now: h.iso(),
      });
      h.store.completeOperationWithOutbox({
        operationId: turn.operationId,
        taskId: turn.taskId,
        workerId: "w",
        resultSequence: 1,
        conversationId: "C1",
        threadTs: THREAD,
        text: "done",
        now: h.iso(),
      });
      await h.send(message("1000.000002", "<@U0BOT> queued"));
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      expect(task(h).session_generation).toBe(2);
      expect(h.operations()[1]).toMatchObject({ status: "failed", last_error_code: "user-cancelled" });
      expect(h.db.query("SELECT state, last_error_code FROM interactions WHERE kind = 'approval'").get()).toEqual({
        state: "failed",
        last_error_code: "session-restarted",
      });
    });
  });

  test("top level, an unbound thread and a closed task answer only-you", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message("2000.000001", "<@U0BOT> !restart", { topLevel: true }));
      await h.send({
        type: "event_callback",
        event_id: "Ev-unbound",
        team_id: "T1",
        event: { type: "app_mention", user: "U1", channel: "C1", ts: "3000.000002", thread_ts: "3000.000001", text: "<@U0BOT> !restart" },
      });
      await h.send(message(THREAD, "<@U0BOT> investigate"));
      await h.send(message("1000.000002", "<@U0BOT> !stop"));
      for (let row = h.store.claimNextOutbox({ workerId: "o", now: h.iso(), leaseMs: 10_000 }); row !== null;
        row = h.store.claimNextOutbox({ workerId: "o", now: h.iso(), leaseMs: 10_000 })) {
        h.store.markOutboxDelivered({ outboxId: row.outboxId, workerId: "o", slackMessageTs: "1000.999999", now: h.iso() });
      }
      // The ack reaction is not under test; the close guard waits on it.
      h.db.query("DELETE FROM slack_reactions").run();
      expect(h.store.closeTask({ taskId: task(h).task_id, reason: "admin", actorId: "test", now: h.iso() })).toMatchObject({
        kind: "closed",
      });
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      expect(h.sent.map((reply) => reply.text)).toEqual([
        replies.RESTART_TOP_LEVEL.text,
        replies.RESTART_UNBOUND.text,
        replies.RESTART_CLOSED.text,
      ]);
    });
  });
});

describe("retired session stop", () => {
  test("stops each retired thread's session once, with its stable command id", async () => {
    await withCommandHarness(config, async (h) => {
      await runningTurn(h);
      const { task_id: taskId, t3_thread_id: oldThread } = task(h);
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      h.clock.now += 61_000;
      const dispatched: T3Command[] = [];
      expect(await worker(h, dispatched).processNext()).toMatchObject({ rotated: 1, sessionsStopped: 1 });
      expect(dispatched).toEqual([
        { type: "thread.session.stop", commandId: `${taskId}:g1:session.stop`, threadId: oldThread, createdAt: h.iso() },
      ]);
      expect(retired(h)[0]?.session_stopped_at).toBe(h.iso());
      h.clock.now += 1_000;
      expect(await worker(h, dispatched).processNext()).toEqual({ kind: "idle" });
      expect(dispatched).toHaveLength(1);
      expect(h.auditActions()).toContain("task.session.stopped");
    });
  });

  test("backs off on a transient failure and records a rejection as final", async () => {
    await withCommandHarness(config, async (h) => {
      await runningTurn(h);
      await h.send(message("1000.000003", "<@U0BOT> !restart"));
      h.clock.now += 61_000;
      const dispatched: T3Command[] = [];
      await worker(h, dispatched, () => new Error("socket closed")).processNext();
      expect(retired(h)[0]).toMatchObject({
        session_stopped_at: null,
        last_error_code: "Error",
        next_attempt_at: new Date(h.clock.now + 30_000).toISOString(),
      });
      h.clock.now += 10_000;
      await worker(h, dispatched).processNext();
      expect(dispatched).toHaveLength(1);
      h.clock.now += 21_000;
      await worker(h, dispatched, () => ({
        _tag: "OrchestrationDispatchCommandError",
        message: "Orchestration command invariant failed (thread.session.stop): thread does not exist",
      })).processNext();
      expect(dispatched).toHaveLength(2);
      expect(retired(h)[0]).toMatchObject({ session_stopped_at: h.iso(), last_error_code: "T3CommandRejected" });
    });
  });
});
