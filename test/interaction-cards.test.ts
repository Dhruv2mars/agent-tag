import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { InteractionWorker } from "../src/interaction-worker.ts";
import { SlackActionRouter } from "../src/slack/actions.ts";
import { handleBlockAction, refreshRenderers, type SlackRespond } from "../src/slack/bridge.ts";
import { approvalMessage, questionMessage } from "../src/slack/cards.ts";
import { deliverNextSlackOutbox } from "../src/slack/outbox.ts";
import { AgentTagStore, type SlackOutboxPayload } from "../src/store/store.ts";
import type { T3Command, T3PendingUserInput } from "../src/t3/gateway.ts";

const now = "2026-09-21T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(now) + seconds * 1_000).toISOString();
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 2, interactionExpirySeconds: 3_600 },
});

const question: T3PendingUserInput = {
  requestId: "question-1",
  questions: [
    { id: "q1", header: "Target", question: "Which one?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
    { id: "q2", header: "Env", question: "Where?", options: [{ label: "prod" }, { label: "staging" }], multiSelect: false },
  ],
  dismissible: false,
};

interface SlackCall {
  readonly method: "post" | "update";
  readonly message: SlackOutboxPayload & { readonly channel: string; readonly ts?: string; readonly thread_ts?: string };
}

interface Harness {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly router: SlackActionRouter;
  readonly seeded: { readonly taskId: string; readonly operationId: string; readonly threadId: string };
  /** Delivers every claimable outbox row through the real delivery path; returns the Slack calls made. */
  readonly drain: (at?: string) => Promise<SlackCall[]>;
  clock: string;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-cards-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    const receipt = store.ingestSlackEvent({
      deliveryId: crypto.randomUUID(),
      eventKey: `C1:${crypto.randomUUID()}`,
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
      text: "fixture",
      receivedAt: now,
      sourceOrderKey: "1000.000001",
    });
    const seeded = {
      taskId: receipt.taskId,
      operationId: receipt.operationId,
      threadId: store.getTaskExecution(receipt.taskId).threadId,
    };
    let posted = 0;
    const harness: Harness = {
      store,
      path,
      seeded,
      clock: now,
      router: new SlackActionRouter({ config, store, now: () => harness.clock }),
      drain: async (at) => {
        const calls: SlackCall[] = [];
        for (;;) {
          const outcome = await deliverNextSlackOutbox({
            config,
            store,
            workerId: "slack-a",
            now: () => at ?? harness.clock,
            refreshRenderers: refreshRenderers(store, config),
            postMessage: async (message) => {
              calls.push({ method: "post", message });
              posted += 1;
              return { ts: `2000.${String(posted).padStart(6, "0")}` };
            },
            updateMessage: async (message) => {
              calls.push({ method: "update", message: message as SlackCall["message"] });
              return { ok: true };
            },
          });
          if (outcome.kind === "idle") return calls;
        }
      },
    };
    await run(harness);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-cards-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function readRows<T>(path: string, sql: string, ...params: string[]): T[] {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database.query<T, string[]>(sql).all(...params);
  } finally {
    database.close();
  }
}

/** Claimable card edits of the interaction's prompt post. */
function pendingCardUpdates(path: string, interactionId: string) {
  return readRows<{ method: string; refresh_kind: string; correlation_id: string; target: string }>(
    path,
    `SELECT update_row.method, update_row.refresh_kind, update_row.correlation_id, target.client_message_id AS target
     FROM slack_outbox AS update_row JOIN slack_outbox AS target ON target.outbox_id = update_row.target_outbox_id
     WHERE update_row.status = 'pending' AND target.client_message_id = ?`,
    `${interactionId}:prompt`,
  );
}

function outboxCount(path: string): number {
  return readRows<{ count: number }>(path, "SELECT COUNT(*) AS count FROM slack_outbox")[0]?.count ?? 0;
}

function interactionRow(path: string, interactionId: string) {
  return readRows<Record<string, unknown>>(path, "SELECT * FROM interactions WHERE interaction_id = ?", interactionId)[0];
}

/** Records an approval and posts its card; returns the interaction id and the card's Slack ts. */
async function postedApproval(harness: Harness, requestId = "approval-1"): Promise<{ id: string; ts: string }> {
  const prompt = { requestId, requestKind: "command" as const, detail: "bun test", options: [] };
  const { interactionId } = harness.store.recordPendingInteraction({
    ...harness.seeded,
    requestId,
    kind: "approval",
    prompt,
    conversationId: "C1",
    threadTs: "1000.000001",
    message: (id) => approvalMessage(id, prompt),
    now: harness.clock,
  });
  expect((await harness.drain()).map((call) => call.method)).toEqual(["post"]);
  return { id: interactionId, ts: postedTs(harness, interactionId) };
}

/** The Slack ts the card's prompt post was delivered at. */
function postedTs(harness: Harness, interactionId: string): string {
  const row = readRows<{ slack_message_ts: string }>(
    harness.path,
    "SELECT slack_message_ts FROM slack_outbox WHERE client_message_id = ?",
    `${interactionId}:prompt`,
  )[0];
  if (row === undefined) throw new Error("prompt was not posted");
  return row.slack_message_ts;
}

function click(harness: Harness, interactionId: string, actionTs: string, actionId = "agent-tag.approval.accept", userId = "U1") {
  return {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: userId },
    channel: { id: "C1" },
    trigger_id: "trigger-1",
    message: { ts: "2000.000001", thread_ts: "1000.000001" },
    actions: [{ action_id: actionId, action_ts: actionTs, value: interactionId }],
  };
}

/** The one edit a transition must produce: chat.update of the card's ts, rendered from current state. */
async function expectOneCardEdit(harness: Harness, card: { id: string; ts: string }, at?: string): Promise<SlackCall["message"]> {
  expect(pendingCardUpdates(harness.path, card.id)).toEqual([
    { method: "update", refresh_kind: "interaction-card", correlation_id: card.id, target: `${card.id}:prompt` },
  ]);
  const updates = (await harness.drain(at)).filter((call) => call.method === "update");
  expect(updates).toHaveLength(1);
  const message = updates[0]?.message;
  if (message === undefined) throw new Error("no card edit");
  expect(message.channel).toBe("C1");
  expect(message.ts).toBe(card.ts);
  return message;
}

function hasActions(message: SlackOutboxPayload): boolean {
  return (message.blocks ?? []).some((block) => block.type === "actions");
}

function successfulWorker(harness: Harness, commands: T3Command[] = []) {
  return new InteractionWorker({
    config,
    store: harness.store,
    t3: {
      fetchThread: async () => {
        throw new Error("unexpected T3 thread fetch");
      },
      dispatch: async (command) => (commands.push(command), { sequence: 1 }),
    },
    workerId: "interaction-a",
    now: () => new Date(harness.clock),
  });
}

describe("interaction cards reflect clicks and outcomes (I2 Done 2)", () => {
  test("submit, then worker completion, each edit the card once at its own ts", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      expect(card.ts).toBe("2000.000001");

      expect(harness.router.ingest(click(harness, card.id, "2000.000002")).kind).toBe("accepted");
      const submitted = await expectOneCardEdit(harness, card);
      expect(hasActions(submitted)).toBe(false);
      expect(submitted.text).toContain("Allow once, chosen by <@U1>");
      expect(JSON.stringify(submitted.blocks)).toContain("*Approval required*");

      expect((await successfulWorker(harness).processNext()).kind).toBe("resolved");
      const resolved = await expectOneCardEdit(harness, card);
      expect(hasActions(resolved)).toBe(false);
      expect(resolved.text).toContain("Allowed once by <@U1>");
    });
  });

  test("a terminal worker failure shows on the card, with no separate thread notice", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      harness.router.ingest(click(harness, card.id, "2000.000002", "agent-tag.approval.decline"));
      await harness.drain();
      const worker = new InteractionWorker({
        config,
        store: harness.store,
        t3: {
          fetchThread: async () => {
            throw new Error("unexpected T3 thread fetch");
          },
          dispatch: async () => {
            throw { _tag: "OrchestrationDispatchCommandError", message: "Orchestration command invariant failed" };
          },
        },
        workerId: "interaction-a",
        now: () => new Date(harness.clock),
      });
      expect((await worker.processNext()).kind).toBe("failed");
      const failed = await expectOneCardEdit(harness, card);
      expect(hasActions(failed)).toBe(false);
      expect(failed.text).toContain("Not applied");
      expect(readRows(harness.path, "SELECT 1 FROM slack_outbox WHERE client_message_id = ?", `${card.id}:failed`)).toEqual([]);
    });
  });

  test("a partial answer edits the card instead of posting \"Answer recorded\"", async () => {
    await withHarness(async (harness) => {
      const { interactionId } = harness.store.recordPendingInteraction({
        ...harness.seeded,
        requestId: question.requestId,
        kind: "user-input",
        prompt: question,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (id) => questionMessage(id, question),
        now: harness.clock,
      });
      await harness.drain();
      const card = { id: interactionId, ts: postedTs(harness, interactionId) };
      const answer = (questionId: string, actionTs: string) =>
        harness.router.ingest({
          ...click(harness, interactionId, actionTs, "agent-tag.user-input.answer", "U2"),
          actions: [{
            action_id: "agent-tag.user-input.answer",
            action_ts: actionTs,
            value: JSON.stringify({ interactionId, questionId, optionIndex: 0 }),
          }],
        });

      expect(answer("q1", "2000.000002")).toMatchObject({ kind: "partial", answered: 1, total: 2 });
      const before = outboxCount(harness.path);
      const partial = await expectOneCardEdit(harness, card);
      // Only the edit: no new thread message.
      expect(outboxCount(harness.path)).toBe(before);
      const blocks = JSON.stringify(partial.blocks);
      expect(blocks).toContain("Answered by <@U2>: A");
      expect(blocks).not.toContain(`agent-tag:${interactionId}:q0`);
      expect(blocks).toContain(`agent-tag:${interactionId}:q1`);

      expect(answer("q2", "2000.000003").kind).toBe("accepted");
      const complete = await expectOneCardEdit(harness, card);
      expect(hasActions(complete)).toBe(false);
      expect(complete.text).toContain("Answered by <@U2>");
    });
  });

  test("expiry edits the card to say it expired", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      harness.clock = later(3_601);
      const claimed = harness.store.claimNextOperation({
        workerId: "coordinator-a",
        now: harness.clock,
        leaseMs: 600_000,
        maxConcurrentTasks: 2,
      });
      expect(claimed?.operationId).toBe(harness.seeded.operationId);
      const wait = harness.store.awaitOperationInteractions({
        operationId: harness.seeded.operationId,
        taskId: harness.seeded.taskId,
        workerId: "coordinator-a",
        threadId: harness.seeded.threadId,
        actorUserId: "U1",
        conversationId: "C1",
        threadTs: "1000.000001",
        requests: [{ requestId: "approval-1", kind: "approval" }],
        expirySeconds: 3_600,
        expiredText: "expired",
        turnActiveMs: 0,
        now: harness.clock,
      });
      expect(wait.kind).toBe("expired");
      const expired = await expectOneCardEdit(harness, card);
      expect(hasActions(expired)).toBe(false);
      expect(expired.text).toContain("Expired after 1 hour");
    });
  });

  test("a request T3 stops reporting is resolved elsewhere; answered and reported ones are untouched", async () => {
    await withHarness(async (harness) => {
      const elsewhere = await postedApproval(harness, "approval-1");
      const reported = await postedApproval(harness, "approval-2");
      const answered = await postedApproval(harness, "approval-3");
      harness.router.ingest(click(harness, answered.id, "2000.000009"));
      await harness.drain();

      const reconcile = () =>
        harness.store.reconcileThreadInteractions({
          threadId: harness.seeded.threadId,
          pending: [{ requestId: "approval-2", kind: "approval" }],
          now: harness.clock,
        });
      expect(reconcile()).toBe(1);
      const card = await expectOneCardEdit(harness, elsewhere);
      expect(hasActions(card)).toBe(false);
      expect(card.text).toContain("Resolved outside Slack");
      expect(interactionRow(harness.path, elsewhere.id)).toMatchObject({ state: "resolved", last_error_code: "resolved-elsewhere" });
      expect(interactionRow(harness.path, reported.id)).toMatchObject({ state: "pending" });
      expect(interactionRow(harness.path, answered.id)).toMatchObject({ state: "response-pending" });
      expect(harness.store.listAuditRecords({ limit: 100 }).filter((record) => record.action === "interaction.resolved-elsewhere"))
        .toHaveLength(1);

      // Idempotent: nothing left to close, nothing enqueued.
      const before = outboxCount(harness.path);
      expect(reconcile()).toBe(0);
      expect(outboxCount(harness.path)).toBe(before);
      // A request of the same id but another kind does not keep an approval open.
      expect(
        harness.store.reconcileThreadInteractions({
          threadId: harness.seeded.threadId,
          pending: [{ requestId: "approval-2", kind: "user-input" }],
          now: harness.clock,
        }),
      ).toBe(1);
    });
  });

  test("a refresh rendered after a newer state change shows the newest state", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      harness.router.ingest(click(harness, card.id, "2000.000002"));
      // Completed before the submit's refresh was delivered: the coalesced edit renders "resolved".
      expect((await successfulWorker(harness).processNext()).kind).toBe("resolved");
      const message = await expectOneCardEdit(harness, card);
      expect(message.text).toContain("Allowed once by <@U1>");
    });
  });
});

describe("a second click on a handled request (I2 Done 3)", () => {
  test("changes nothing, sends no T3 command, enqueues nothing, and answers with one ephemeral", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      harness.router.ingest(click(harness, card.id, "2000.000002"));
      const commands: T3Command[] = [];
      const worker = successfulWorker(harness, commands);
      expect((await worker.processNext()).kind).toBe("resolved");
      await harness.drain();

      const row = interactionRow(harness.path, card.id);
      const outboxBefore = outboxCount(harness.path);
      const responses: Parameters<SlackRespond>[0][] = [];
      const result = await handleBlockAction(
        {
          actions: harness.router,
          openView: async () => {
            throw new Error("unexpected modal");
          },
          respond: async (message) => {
            responses.push(message);
          },
        },
        click(harness, card.id, "2000.000003", "agent-tag.approval.decline", "U2"),
      );

      expect(result).toMatchObject({ kind: "duplicate" });
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ response_type: "ephemeral", replace_original: false });
      expect(responses[0]?.text).toStartWith("Already handled.");
      expect(responses[0]?.text).toContain("Allowed once by <@U1>");
      expect(interactionRow(harness.path, card.id)).toEqual(row);
      expect(outboxCount(harness.path)).toBe(outboxBefore);
      expect((await worker.processNext()).kind).toBe("idle");
      expect(commands).toHaveLength(1);
    });
  });

  test("a redelivered click on a still-pending form gets no ephemeral", async () => {
    await withHarness(async (harness) => {
      const { interactionId } = harness.store.recordPendingInteraction({
        ...harness.seeded,
        requestId: question.requestId,
        kind: "user-input",
        prompt: question,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (id) => questionMessage(id, question),
        now: harness.clock,
      });
      const answer = (actionTs: string) => ({
        ...click(harness, interactionId, actionTs, "agent-tag.user-input.answer"),
        actions: [{
          action_id: "agent-tag.user-input.answer",
          action_ts: actionTs,
          value: JSON.stringify({ interactionId, questionId: "q1", optionIndex: 1 }),
        }],
      });
      const input = {
        actions: harness.router,
        openView: async () => undefined,
        respond: async () => {
          throw new Error("unexpected ephemeral");
        },
      };
      expect((await handleBlockAction(input, answer("2000.000002"))).kind).toBe("partial");
      // Slack redelivering the same click while the form is still pending.
      expect(await handleBlockAction(input, answer("2000.000002"))).toMatchObject({ kind: "duplicate", resolution: null });
    });
  });

  test("an expired request answers \"expired\"; a failing respond is logged, not thrown", async () => {
    await withHarness(async (harness) => {
      const card = await postedApproval(harness);
      harness.clock = later(3_601);
      const logs: unknown[] = [];
      const result = await handleBlockAction(
        {
          actions: harness.router,
          openView: async () => undefined,
          respond: async () => {
            throw Object.assign(new Error("response_url expired"), { data: { error: "expired_url" } });
          },
          logger: (record) => logs.push(record),
        },
        click(harness, card.id, "2000.000002"),
      );
      expect(result).toEqual({ kind: "ignored", reason: "interaction-expired" });
      expect(logs).toMatchObject([{ level: "warn", event: "slack.action.feedback_failed" }]);
    });
  });
});
