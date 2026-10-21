import { describe, expect, test } from "bun:test";

import * as replies from "../src/commands/replies.ts";
import { makeConfig, message, THREAD, withCommandHarness } from "./fixtures/command-harness.ts";

const config = makeConfig();

describe("!stop", () => {
  test("a started turn is interrupted through the Stop button's path and its status reads Stopped by", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message(THREAD, "<@U0BOT> investigate"));
      const turn = h.claim();
      if (turn === null) throw new Error("no operation");
      h.startTurn(turn);
      h.store.openStatusMessage({
        operationId: turn.operationId,
        taskId: turn.taskId,
        conversationId: "C1",
        threadTs: THREAD,
        message: () => ({ text: "Working" }),
        now: h.iso(),
      });

      await h.send(message("1000.000005", "<@U0BOT> !stop", { user: "U2" }));
      expect(h.sent).toEqual([]);
      const cancel = h.db
        .query("SELECT kind, state, source_action_id, response_actor_id FROM interactions WHERE operation_id = ?")
        .get(turn.operationId);
      expect(cancel).toEqual({
        kind: "cancel",
        state: "response-pending",
        source_action_id: "command:C1:1000.000005",
        response_actor_id: "U2",
      });
      expect(h.db.query("SELECT state, actor_user_id FROM status_messages").get()).toEqual({ state: "stopping", actor_user_id: "U2" });
      expect(h.db.query("SELECT command_kind, outcome FROM slack_command_events").get()).toEqual({
        command_kind: "stop",
        outcome: "succeeded",
      });
      expect(h.auditActions()).toContain("task.stop.requested");
      // T3 reports the turn interrupted: the coordinator settles it like a Stop click.
      h.store.cancelOperationWithOutbox({
        operationId: turn.operationId,
        taskId: turn.taskId,
        workerId: "w",
        conversationId: "C1",
        threadTs: THREAD,
        now: h.iso(),
      });
      expect(h.operations()[0]).toMatchObject({ status: "failed", last_error_code: "user-cancelled" });
      expect(h.db.query("SELECT state, actor_user_id FROM status_messages").get()).toEqual({ state: "stopped", actor_user_id: "U2" });
      // The status message is the whole notice: no "Stopped" line and no command reply.
      expect(h.outboxTexts().filter((text) => text.includes("Stopped"))).toEqual([]);
    });
  });

  test("queued requests sent before the command are dropped with one summary; later ones are kept", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message(THREAD, "<@U0BOT> first"));
      await h.send(message("1000.000002", "<@U0BOT> second"));
      // Sent after the !stop (a higher ts) but ingested before it ran: a new request, not dropped.
      await h.send(message("1000.000004", "<@U0BOT> after"));
      await h.send(message("1000.000003", "<@U0BOT> !stop"));
      expect(h.operations()).toEqual([
        { status: "failed", last_error_code: "user-cancelled", source_order_key: THREAD },
        { status: "failed", last_error_code: "user-cancelled", source_order_key: "1000.000002" },
        { status: "pending", last_error_code: null, source_order_key: "1000.000004" },
      ]);
      expect(h.outboxTexts()).toEqual([":octagonal_sign: Stopped by <@U1>. Dropped 2 queued requests."]);
      expect(h.sent).toEqual([]);
      expect(h.db.query("SELECT COUNT(*) AS count FROM interactions").get()).toEqual({ count: 0 });
    });
  });

  test("a started turn plus queued requests: the turn is interrupted and the drop is noted once", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message(THREAD, "<@U0BOT> first"));
      const turn = h.claim();
      if (turn === null) throw new Error("no operation");
      h.startTurn(turn);
      await h.send(message("1000.000002", "<@U0BOT> second"));
      await h.send(message("1000.000003", "<@U0BOT> !stop"));
      expect(h.operations().map((row) => row.status)).toEqual(["inflight", "failed"]);
      expect(h.db.query("SELECT state FROM interactions WHERE kind = 'cancel'").get()).toEqual({ state: "response-pending" });
      expect(h.outboxTexts()).toEqual(["Also dropped 1 queued request (stopped by <@U1>)."]);
    });
  });

  test("nothing running, top level and an unbound thread answer only-you", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message(THREAD, "<@U0BOT> first"));
      await h.send(message("1000.000002", "<@U0BOT> !stop"));
      await h.send(message("1000.000003", "<@U0BOT> !stop"));
      await h.send(message("2000.000001", "<@U0BOT> !stop", { topLevel: true }));
      await h.send({
        type: "event_callback",
        event_id: "Ev-unbound",
        team_id: "T1",
        event: { type: "app_mention", user: "U1", channel: "C1", ts: "3000.000002", thread_ts: "3000.000001", text: "<@U0BOT> !stop" },
      });
      expect(h.sent.map((reply) => [reply.kind, reply.text])).toEqual([
        ["ephemeral", replies.STOP_NOTHING.text],
        ["ephemeral", replies.STOP_TOP_LEVEL.text],
        ["ephemeral", replies.STOP_NOTHING.text],
      ]);
      expect(
        h.db.query("SELECT outcome, reason FROM slack_command_events ORDER BY received_at, event_key").all(),
      ).toEqual([
        { outcome: "succeeded", reason: null },
        { outcome: "rejected", reason: "nothing-running" },
        { outcome: "rejected", reason: "top-level" },
        { outcome: "rejected", reason: "unbound-thread" },
      ]);
    });
  });

  test("a redelivered !stop runs once", async () => {
    await withCommandHarness(config, async (h) => {
      await h.send(message(THREAD, "<@U0BOT> first"));
      const stop = message("1000.000002", "<@U0BOT> !stop");
      await h.send(stop);
      await h.send(stop);
      expect(h.outboxTexts()).toHaveLength(1);
      expect(h.auditActions().filter((action) => action === "task.stop.requested")).toHaveLength(1);
    });
  });
});
