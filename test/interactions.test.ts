import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { questionMessage } from "../src/coordinator.ts";
import {
  DEFAULT_INTERACTION_RETRY_POLICY,
  InteractionWorker,
  type InteractionWorkerOutcome,
  NO_LONGER_PENDING_NOTICE,
  RETRIES_EXHAUSTED_NOTICE,
  interactionRetryDelayMs,
  type T3InteractionGateway,
} from "../src/interaction-worker.ts";
import { SlackActionRouter } from "../src/slack/actions.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";

const now = "2026-09-21T00:00:00.000Z";
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
  limits: { maxConcurrentTasks: 2 },
});

function actionBody(input: {
  readonly actionId:
    | "agent-tag.approval.accept"
    | "agent-tag.approval.decline"
    | "agent-tag.approval.cancel"
    | "agent-tag.user-input.answer"
    | "agent-tag.user-input.open"
    | "agent-tag.user-input.dismiss"
    | "agent-tag.turn.cancel";
  readonly value: string;
  readonly actionTs?: string;
  readonly userId?: string;
}): unknown {
  return {
    type: "block_actions",
    team: { id: "T1" },
    user: { id: input.userId ?? "U1" },
    channel: { id: "C1" },
    trigger_id: "trigger-1",
    message: { ts: "1000.000010", thread_ts: "1000.000001" },
    actions: [
      {
        action_id: input.actionId,
        action_ts: input.actionTs ?? "1000.000020",
        value: input.value,
      },
    ],
  };
}

function viewSubmissionBody(input: {
  readonly viewId: string;
  readonly privateMetadata: string;
  readonly optionValues?: ReadonlyArray<string>;
  readonly text?: string;
  readonly userId?: string;
}): unknown {
  const values: Record<string, Record<string, unknown>> = {};
  if (input.optionValues !== undefined) {
    values["agent-tag.user-input.options"] = {
      value: { type: "checkboxes", selected_options: input.optionValues.map((value) => ({ value })) },
    };
  }
  if (input.text !== undefined) {
    values["agent-tag.user-input.text"] = { value: { type: "plain_text_input", value: input.text } };
  }
  return {
    type: "view_submission",
    team: { id: "T1" },
    user: { id: input.userId ?? "U1" },
    view: {
      id: input.viewId,
      callback_id: "agent-tag.user-input.submit",
      private_metadata: input.privateMetadata,
      state: { values },
    },
  };
}

async function unexpectedThreadFetch(): Promise<never> {
  throw new Error("unexpected T3 thread fetch");
}

/** A T3 thread whose current turn is `turnId` (running unless `state` says otherwise). */
function threadWithTurn(
  threadId: string,
  turnId: string,
  options: { readonly state?: "running" | "completed" | "interrupted"; readonly activeTurnId?: string | null } = {},
): T3ThreadSnapshot {
  const state = options.state ?? "running";
  return {
    snapshotSequence: 1,
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state,
        requestedAt: now,
        startedAt: now,
        completedAt: state === "running" ? null : now,
        assistantMessageId: null,
      },
      messages: [],
      activities: [],
      session: {
        threadId,
        status: state === "running" ? "running" : "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: options.activeTurnId !== undefined ? options.activeTurnId : state === "running" ? turnId : null,
        lastError: null,
        updatedAt: now,
      },
    },
  };
}

function seedOperation(store: AgentTagStore): {
  readonly taskId: string;
  readonly operationId: string;
  readonly threadId: string;
} {
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
  const binding = store.getTaskExecution(receipt.taskId);
  return { taskId: receipt.taskId, operationId: receipt.operationId, threadId: binding.threadId };
}

async function withStore(
  run: (input: { readonly store: AgentTagStore; readonly path: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-interactions-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run({ store, path });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-interactions-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("durable interactions", () => {
  test("replays an approval response after restart with the same T3 command id", async () => {
    await withStore(async ({ store: initialStore, path }) => {
      const seeded = seedOperation(initialStore);
      const pending = initialStore.recordPendingInteraction({
        ...seeded,
        requestId: "approval-1",
        kind: "approval",
        prompt: { requestKind: "command" },
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (interactionId) => ({ text: `approve ${interactionId}` }),
        now,
      });
      const router = new SlackActionRouter({ config, store: initialStore, now: () => now });
      const submitted = router.ingest(
        actionBody({ actionId: "agent-tag.approval.accept", value: pending.interactionId }),
      );
      expect(submitted.kind).toBe("accepted");
      const duplicate = router.ingest(
        actionBody({ actionId: "agent-tag.approval.accept", value: pending.interactionId }),
      );
      expect(duplicate.kind).toBe("duplicate");

      const commands: T3Command[] = [];
      let shouldFail = true;
      const t3: T3InteractionGateway = {
        fetchThread: unexpectedThreadFetch,
        dispatch: async (command) => {
          commands.push(command);
          if (shouldFail) {
            shouldFail = false;
            throw new Error("injected dispatch failure");
          }
          return { sequence: 1 };
        },
      };
      const firstWorker = new InteractionWorker({
        config,
        store: initialStore,
        t3,
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      const retry = await firstWorker.processNext();
      if (retry.kind !== "retry-scheduled") throw new Error(`expected a retry, got ${retry.kind}`);
      initialStore.close();

      const reopened = await AgentTagStore.open(path);
      try {
        let current = new Date(now);
        const secondWorker = new InteractionWorker({
          config,
          store: reopened,
          t3,
          workerId: "interaction-b",
          now: () => current,
        });
        expect((await secondWorker.processNext()).kind).toBe("idle");
        current = new Date(retry.blockedUntil);
        expect((await secondWorker.processNext()).kind).toBe("resolved");
        expect(commands).toHaveLength(2);
        expect(commands[0]).toMatchObject({
          type: "thread.approval.respond",
          requestId: "approval-1",
          decision: "accept",
        });
        expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
      } finally {
        reopened.close();
      }
    });
  });

  test("persists rejection and structured question answers as distinct T3 commands", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      const approval = store.recordPendingInteraction({
        ...seeded,
        requestId: "approval-1",
        kind: "approval",
        prompt: { requestKind: "command" },
        conversationId: "C1",
        threadTs: "1000.000001",
        message: () => ({ text: "approval" }),
        now,
      });
      const question = store.recordPendingInteraction({
        ...seeded,
        requestId: "question-1",
        kind: "user-input",
        prompt: {
          requestId: "question-1",
          dismissible: false,
          questions: [
            {
              id: "package",
              header: "Package",
              question: "Which package?",
              options: [{ label: "core" }, { label: "web" }],
              multiSelect: false,
            },
          ],
        },
        conversationId: "C1",
        threadTs: "1000.000001",
        message: () => ({ text: "question" }),
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      router.ingest(
        actionBody({ actionId: "agent-tag.approval.decline", value: approval.interactionId }),
      );
      router.ingest(
        actionBody({
          actionId: "agent-tag.user-input.answer",
          value: JSON.stringify({
            interactionId: question.interactionId,
            questionId: "package",
            answer: "core",
          }),
          actionTs: "1000.000021",
          userId: "U2",
        }),
      );
      const commands: T3Command[] = [];
      const t3: T3InteractionGateway = {
        fetchThread: unexpectedThreadFetch,
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      };
      const worker = new InteractionWorker({
        config, store, t3, workerId: "interaction-a", now: () => new Date(now) });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands).toHaveLength(2);
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "thread.approval.respond", decision: "decline" }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "thread.user-input.respond", answers: { package: "core" } }),
      );
    });
  });

  test("resolves an option-index answer from the stored prompt", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      const hugeLabel = "y".repeat(2_500);
      const question = store.recordPendingInteraction({
        ...seeded,
        requestId: "question-big",
        kind: "user-input",
        prompt: {
          requestId: "question-big",
          dismissible: false,
          questions: [{ id: "pkg", header: "Pick", question: "Which?", options: [{ label: "a" }, { label: hugeLabel }], multiSelect: false }],
        },
        conversationId: "C1",
        threadTs: "1000.000001",
        message: () => ({ text: "question" }),
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      expect(
        router.ingest(
          actionBody({
            actionId: "agent-tag.user-input.answer",
            value: JSON.stringify({ interactionId: question.interactionId, questionId: "pkg", optionIndex: 9 }),
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "invalid-action" });
      expect(
        router.ingest(
          actionBody({
            actionId: "agent-tag.user-input.answer",
            value: JSON.stringify({ interactionId: question.interactionId, questionId: "pkg", optionIndex: 1 }),
            actionTs: "1000.000022",
          }),
        ).kind,
      ).toBe("accepted");
      const commands: T3Command[] = [];
      const t3: T3InteractionGateway = {
        fetchThread: unexpectedThreadFetch,
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      };
      const worker = new InteractionWorker({ config, store, t3, workerId: "interaction-b", now: () => new Date(now) });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "thread.user-input.respond", answers: { pkg: hugeLabel } }),
      );
    });
  });

  test("quarantines an invalid stored response instead of retrying forever", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      const interaction = store.recordPendingInteraction({
        ...seeded,
        requestId: "approval-invalid",
        kind: "approval",
        prompt: { requestKind: "command" },
        conversationId: "C1",
        threadTs: "1000.000001",
        message: () => ({ text: "approval" }),
        now,
      });
      store.submitInteractionResponse({
        interactionId: interaction.interactionId,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "invalid-fixture",
        response: {},
        expirySeconds: 86_400,
        now,
      });
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async () => {
            throw new Error("invalid response must not reach T3");
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect((await worker.processNext()).kind).toBe("failed");
      expect(store.claimNextInteractionResponse({ workerId: "interaction-b", now, leaseMs: 10_000 })).toBeNull();
    });
  });

  test("denies forged, malformed, and unauthorized action payloads without state changes", async () => {
    await withStore(async ({ store }) => {
      seedOperation(store);
      const router = new SlackActionRouter({ config, store, now: () => now });
      expect(
        router.ingest(
          actionBody({ actionId: "agent-tag.approval.accept", value: "unknown-interaction" }),
        ),
      ).toEqual({ kind: "ignored", reason: "interaction-denied" });
      expect(
        router.ingest(
          actionBody({ actionId: "agent-tag.user-input.answer", value: "not-json" }),
        ),
      ).toEqual({ kind: "ignored", reason: "invalid-action" });
      expect(
        router.ingest(
          actionBody({
            actionId: "agent-tag.turn.cancel",
            value: "unknown-task",
            userId: "U2",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "interaction-denied" });
      expect(store.claimNextInteractionResponse({ workerId: "worker", now, leaseMs: 10_000 })).toBeNull();
    });
  });

  test("renders every question and sends one combined T3 response only after all are answered", async () => {
    await withStore(async ({ store: initialStore, path }) => {
      const seeded = seedOperation(initialStore);
      const request = {
        requestId: "question-multi",
        dismissible: false,
        questions: [
          {
            id: "package",
            header: "Package",
            question: "Which package?",
            options: [{ label: "core" }, { label: "web" }],
            multiSelect: false,
            allowCustomAnswer: false,
          },
          {
            id: "targets",
            header: "Targets",
            question: "Which targets should run?",
            options: [{ label: "lint" }, { label: "test" }, { label: "build" }],
            multiSelect: true,
            allowCustomAnswer: false,
          },
          { id: "notes", header: "Notes", question: "Anything else?", options: [], multiSelect: false },
        ],
      };
      const pending = initialStore.recordPendingInteraction({
        ...seeded,
        requestId: request.requestId,
        kind: "user-input",
        prompt: request,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (interactionId) => questionMessage(interactionId, request),
        now,
      });

      const prompt = initialStore.claimNextOutbox({ workerId: "slack-a", now, leaseMs: 10_000 });
      const rendered = JSON.stringify(prompt?.payload.blocks);
      for (const text of ["Which package?", "Which targets should run?", "Anything else?"]) {
        expect(rendered).toContain(text);
      }
      const controls = (prompt?.payload.blocks ?? []).flatMap((block) =>
        block.type === "actions" ? block.elements.map((element) => ({
          actionId: element.action_id,
          value: JSON.parse(element.value) as { questionId: string },
        })) : [],
      );
      expect(controls.filter((control) => control.value.questionId === "package").map((c) => c.actionId))
        .toEqual(["agent-tag.user-input.answer", "agent-tag.user-input.answer"]);
      expect(controls.filter((control) => control.value.questionId === "targets").map((c) => c.actionId))
        .toEqual(["agent-tag.user-input.open"]);
      expect(controls.filter((control) => control.value.questionId === "notes").map((c) => c.actionId))
        .toEqual(["agent-tag.user-input.open"]);

      const commands: T3Command[] = [];
      const t3: T3InteractionGateway = {
        fetchThread: unexpectedThreadFetch,
        dispatch: async (command) => {
          commands.push(command);
          return { sequence: commands.length };
        },
      };
      const router = new SlackActionRouter({ config, store: initialStore, now: () => now });
      const packageAnswer = actionBody({
        actionId: "agent-tag.user-input.answer",
        value: JSON.stringify({ interactionId: pending.interactionId, questionId: "package", optionIndex: 0 }),
        actionTs: "1000.000030",
      });
      expect(router.ingest(packageAnswer)).toMatchObject({ kind: "partial", answered: 1, total: 3 });
      expect(router.ingest(packageAnswer)).toMatchObject({ kind: "duplicate" });
      expect(
        await new InteractionWorker({ config, store: initialStore, t3, now: () => new Date(now) }).processNext(),
      ).toEqual({ kind: "idle" });

      const notesModal = router.ingest(
        actionBody({
          actionId: "agent-tag.user-input.open",
          value: JSON.stringify({ interactionId: pending.interactionId, questionId: "notes" }),
          actionTs: "1000.000031",
          userId: "U2",
        }),
      );
      if (notesModal.kind !== "open-modal") throw new Error(`expected a modal, got ${notesModal.kind}`);
      expect(notesModal.triggerId).toBe("trigger-1");
      expect(JSON.stringify(notesModal.view.blocks)).toContain("plain_text_input");
      expect(
        router.ingestViewSubmission(
          viewSubmissionBody({ viewId: "V1", privateMetadata: notesModal.view.private_metadata ?? "", text: "  " }),
        ),
      ).toMatchObject({ kind: "invalid-input" });
      expect(
        router.ingestViewSubmission(
          viewSubmissionBody({
            viewId: "V1",
            privateMetadata: notesModal.view.private_metadata ?? "",
            text: "Ship it",
            userId: "U2",
          }),
        ),
      ).toMatchObject({ kind: "partial", answered: 2, total: 3 });
      initialStore.close();

      // Partial answers survive a restart.
      const reopened = await AgentTagStore.open(path);
      try {
        const reopenedRouter = new SlackActionRouter({ config, store: reopened, now: () => now });
        const targetsModal = reopenedRouter.ingest(
          actionBody({
            actionId: "agent-tag.user-input.open",
            value: JSON.stringify({ interactionId: pending.interactionId, questionId: "targets" }),
            actionTs: "1000.000032",
          }),
        );
        if (targetsModal.kind !== "open-modal") throw new Error(`expected a modal, got ${targetsModal.kind}`);
        expect(JSON.stringify(targetsModal.view.blocks)).toContain("checkboxes");
        expect(
          reopenedRouter.ingestViewSubmission(
            viewSubmissionBody({
              viewId: "V2",
              privateMetadata: targetsModal.view.private_metadata ?? "",
              optionValues: ["0", "1"],
            }),
          ),
        ).toMatchObject({ kind: "accepted" });

        const worker = new InteractionWorker({ config, store: reopened, t3, now: () => new Date(now) });
        expect((await worker.processNext()).kind).toBe("resolved");
        expect(await worker.processNext()).toEqual({ kind: "idle" });
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          type: "thread.user-input.respond",
          requestId: "question-multi",
          answers: { package: "core", targets: ["lint", "test"], notes: "Ship it" },
        });
      } finally {
        reopened.close();
      }
    });
  });

  test("rejects answers outside the stored question and modal opens from unauthorized users", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      const request = {
        requestId: "question-strict",
        dismissible: false,
        questions: [
          {
            id: "package",
            header: "Package",
            question: "Which package?",
            options: [{ label: "core" }],
            multiSelect: false,
            allowCustomAnswer: false,
          },
        ],
      };
      const pending = store.recordPendingInteraction({
        ...seeded,
        requestId: request.requestId,
        kind: "user-input",
        prompt: request,
        conversationId: "C1",
        threadTs: "1000.000001",
        message: (interactionId) => questionMessage(interactionId, request),
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      for (const value of [
        { interactionId: pending.interactionId, questionId: "package", optionIndex: 7 },
        { interactionId: pending.interactionId, questionId: "package", answer: "forged" },
        { interactionId: pending.interactionId, questionId: "unknown", optionIndex: 0 },
      ]) {
        expect(
          router.ingest(actionBody({ actionId: "agent-tag.user-input.answer", value: JSON.stringify(value) })),
        ).toEqual({ kind: "ignored", reason: "invalid-action" });
      }
      expect(
        router.ingest(
          actionBody({
            actionId: "agent-tag.user-input.open",
            value: JSON.stringify({ interactionId: pending.interactionId, questionId: "package" }),
            userId: "U9",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "user-denied" });
      expect(
        router.ingestViewSubmission(
          viewSubmissionBody({
            viewId: "V9",
            privateMetadata: JSON.stringify({
              interactionId: pending.interactionId,
              questionId: "package",
              conversationId: "C1",
              threadTs: "1000.000001",
            }),
            text: "forged custom answer",
          }),
        ),
      ).toMatchObject({ kind: "invalid-input" });
      expect(store.claimNextInteractionResponse({ workerId: "worker", now, leaseMs: 10_000 })).toBeNull();
    });
  });
  test("refuses responses at the expiry deadline, before the coordinator closes the wait (B7)", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      const expiryMs = config.limits.interactionExpirySeconds * 1_000;
      let clock = Date.parse(now);
      const router = new SlackActionRouter({ config, store, now: () => new Date(clock).toISOString() });
      const question = {
        requestId: "question-late",
        dismissible: true,
        questions: [
          { id: "package", header: "Package", question: "Which package?", options: [{ label: "core" }], multiSelect: false },
        ],
      };
      const record = (requestId: string, kind: "approval" | "user-input", prompt: unknown) =>
        store.recordPendingInteraction({
          ...seeded,
          requestId,
          kind,
          prompt,
          conversationId: "C1",
          threadTs: "1000.000001",
          message: () => ({ text: "waiting" }),
          now,
        }).interactionId;
      const onTime = record("approval-on-time", "approval", {});
      const late = record("approval-late", "approval", {});
      const lateQuestion = record(question.requestId, "user-input", question);

      // One millisecond before the deadline a response is still accepted...
      clock = Date.parse(now) + expiryMs - 1;
      expect(router.ingest(actionBody({ actionId: "agent-tag.approval.accept", value: onTime })).kind).toBe(
        "accepted",
      );
      // ...but from the deadline on, approvals and answers are refused even though the coordinator has
      // not yet polled and marked the interactions expired.
      clock = Date.parse(now) + expiryMs;
      expect(
        router.ingest(actionBody({ actionId: "agent-tag.approval.accept", value: late, actionTs: "1000.000021" })),
      ).toEqual({ kind: "ignored", reason: "interaction-expired" });
      expect(
        router.ingest(actionBody({ actionId: "agent-tag.user-input.dismiss", value: lateQuestion, actionTs: "1000.000022" })),
      ).toEqual({ kind: "ignored", reason: "interaction-expired" });
      expect(
        router.ingest(
          actionBody({
            actionId: "agent-tag.user-input.answer",
            value: JSON.stringify({ interactionId: lateQuestion, questionId: "package", optionIndex: 0 }),
            actionTs: "1000.000023",
          }),
        ),
      ).toEqual({ kind: "ignored", reason: "interaction-expired" });
      expect(
        router.ingestViewSubmission(
          viewSubmissionBody({
            viewId: "view-late",
            privateMetadata: JSON.stringify({
              interactionId: lateQuestion,
              questionId: "package",
              conversationId: "C1",
              threadTs: "1000.000001",
            }),
            text: "core",
          }),
        ),
      ).toEqual({
        kind: "invalid-input",
        errors: { "agent-tag.user-input.text": "This question has expired and can no longer be answered." },
      });

      const database = new Database(path, { readonly: true });
      try {
        const states = Object.fromEntries(
          database
            .query("SELECT request_id, state, partial_response_json FROM interactions")
            .all()
            .map((row) => {
              const { request_id, state, partial_response_json } = row as Record<string, string | null>;
              return [request_id, { state, partial: partial_response_json }];
            }),
        );
        expect(states).toEqual({
          "approval-on-time": { state: "response-pending", partial: null },
          "approval-late": { state: "pending", partial: null },
          "question-late": { state: "pending", partial: null },
        });
      } finally {
        database.close();
      }
      // Only the on-time approval reaches the interaction worker.
      const claimed = store.claimNextInteractionResponse({ workerId: "worker", now: new Date(clock).toISOString(), leaseMs: 10_000 });
      expect(claimed?.interactionId).toBe(onTime);
      expect(store.claimNextInteractionResponse({ workerId: "worker", now: new Date(clock).toISOString(), leaseMs: 10_000 })).toBeNull();
    });
  });
});

function readRows<T>(path: string, sql: string, ...params: string[]): T[] {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return database.query<T, string[]>(sql).all(...params);
  } finally {
    database.close();
  }
}

function queueApprovalResponse(
  store: AgentTagStore,
  seeded: ReturnType<typeof seedOperation>,
  requestId: string,
): string {
  const pending = store.recordPendingInteraction({
    ...seeded,
    requestId,
    kind: "approval",
    prompt: { requestKind: "command" },
    conversationId: "C1",
    threadTs: "1000.000001",
    message: (interactionId) => ({ text: `approve ${interactionId}` }),
    now,
  });
  const submitted = store.submitInteractionResponse({
    interactionId: pending.interactionId,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    actorUserId: "U1",
    sourceActionId: `accept-${requestId}`,
    response: { decision: "accept" },
    expirySeconds: 86_400,
    now,
  });
  expect(submitted.kind).toBe("accepted");
  return pending.interactionId;
}

function noticesFor(path: string, interactionId: string): ReadonlyArray<string> {
  return readRows<{ payload_json: string }>(
    path,
    "SELECT payload_json FROM slack_outbox WHERE client_message_id = ?",
    `${interactionId}:failed`,
  ).map((row) => z.object({ text: z.string() }).parse(JSON.parse(row.payload_json)).text);
}

/** Pending card refreshes (chat.update of the prompt post) for an interaction. */
function cardRefreshesFor(path: string, interactionId: string): ReadonlyArray<{ readonly correlation_id: string }> {
  return readRows<{ correlation_id: string }>(
    path,
    `SELECT update_row.correlation_id FROM slack_outbox AS update_row
     JOIN slack_outbox AS target ON target.outbox_id = update_row.target_outbox_id
     WHERE update_row.method = 'update' AND update_row.refresh_kind = 'interaction-card'
       AND update_row.status = 'pending' AND target.client_message_id = ?`,
    `${interactionId}:prompt`,
  );
}

function claimRunningOperation(store: AgentTagStore, operationId: string): void {
  const claimed = store.claimNextOperation({
    workerId: "coordinator-a",
    now,
    leaseMs: 600_000,
    maxConcurrentTasks: 2,
  });
  expect(claimed?.operationId).toBe(operationId);
}

describe("interaction retries and cancellation", () => {
  test("a T3 rejection is terminal: one dispatch, one notice, no hot loop", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      const interactionId = queueApprovalResponse(store, seeded, "approval-rejected");
      let dispatches = 0;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async () => {
            dispatches += 1;
            // The shape T3 0.0.45 sends for a rejected command, decoded as an unknown RPC error.
            throw {
              _tag: "OrchestrationDispatchCommandError",
              message: `Orchestration command invariant failed (thread.approval.respond): Thread '${seeded.threadId}' does not exist for command 'thread.approval.respond'.`,
            };
          },
        },
        workerId: "interaction-a",
        now: () => current,
      });
      const outcomes: string[] = [];
      for (let iteration = 0; iteration < 50; iteration += 1) {
        outcomes.push((await worker.processNext()).kind);
        current = new Date(current.getTime() + 3_600_000);
      }
      expect(dispatches).toBe(1);
      expect(outcomes[0]).toBe("failed");
      expect(outcomes.slice(1).every((kind) => kind === "idle")).toBe(true);
      // The approval's card shows "Not applied"; no separate thread notice.
      expect(noticesFor(path, interactionId)).toEqual([]);
      expect(cardRefreshesFor(path, interactionId)).toEqual([{ correlation_id: interactionId }]);
      expect(
        readRows<{ state: string; last_error_code: string }>(
          path,
          "SELECT state, last_error_code FROM interactions WHERE interaction_id = ?",
          interactionId,
        ),
      ).toEqual([{ state: "failed", last_error_code: "T3CommandRejected" }]);
    });
  });

  test("a T3 that always fails transiently gets at most maxAttempts dispatches with capped backoff", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      const interactionId = queueApprovalResponse(store, seeded, "approval-flaky");
      const retry = { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 5 };
      let dispatches = 0;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async () => {
            dispatches += 1;
            throw new Error("socket closed before the receipt arrived");
          },
        },
        workerId: "interaction-a",
        retry,
        now: () => current,
      });

      // A fixed clock models a tight service loop: the backed-off row is not claimable again.
      const first = await worker.processNext();
      expect(first.kind).toBe("retry-scheduled");
      for (let iteration = 0; iteration < 1_000; iteration += 1) {
        expect((await worker.processNext()).kind).toBe("idle");
      }
      expect(dispatches).toBe(1);

      const delays: number[] = [];
      let last = first;
      for (let iteration = 0; iteration < 100 && last.kind !== "failed"; iteration += 1) {
        if (last.kind === "retry-scheduled") {
          delays.push(new Date(last.blockedUntil).getTime() - current.getTime());
          current = new Date(last.blockedUntil);
        } else {
          current = new Date(current.getTime() + 3_600_000);
        }
        last = await worker.processNext();
      }
      expect(last).toMatchObject({ kind: "failed", errorCode: "Error" });
      expect(dispatches).toBe(retry.maxAttempts);
      expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
      expect(noticesFor(path, interactionId)).toEqual([]);
      expect(cardRefreshesFor(path, interactionId)).toEqual([{ correlation_id: interactionId }]);
      // Each attempt writes a claim and a failure audit row, plus the card refresh on submit and on the
      // final failure (coalesced into one row): bounded by N.
      const audit = store.listAuditRecords({ limit: 10_000 }).filter((record) => record.source === interactionId);
      expect(audit).toHaveLength(2 * retry.maxAttempts + 2);
      expect((await worker.processNext()).kind).toBe("idle");
    });
  });

  test("a transient error retries with backoff and then resolves with the same command id", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      queueApprovalResponse(store, seeded, "approval-transient");
      const commands: T3Command[] = [];
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async (command) => {
            commands.push(command);
            if (commands.length === 1) {
              throw { _tag: "OrchestrationDispatchCommandError", message: "Failed to persist orchestration event." };
            }
            return { sequence: 7 };
          },
        },
        workerId: "interaction-a",
        now: () => current,
      });
      const retry = await worker.processNext();
      expect(retry).toMatchObject({ kind: "retry-scheduled", errorCode: "T3DispatchFailed" });
      if (retry.kind !== "retry-scheduled") throw new Error("expected a retry");
      expect(new Date(retry.blockedUntil).getTime() - current.getTime()).toBe(
        interactionRetryDelayMs(DEFAULT_INTERACTION_RETRY_POLICY, 1),
      );
      current = new Date(new Date(retry.blockedUntil).getTime() - 1);
      expect((await worker.processNext()).kind).toBe("idle");
      current = new Date(retry.blockedUntil);
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands).toHaveLength(2);
      expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
    });
  });

  test("cancelling a queued operation cancels it in the store and never sends an interrupt", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId });
      expect(router.ingest(cancel).kind).toBe("accepted");
      expect(router.ingest(cancel).kind).toBe("duplicate");
      expect(
        readRows<{ status: string; last_error_code: string }>(
          path,
          "SELECT status, last_error_code FROM operations WHERE operation_id = ?",
          seeded.operationId,
        ),
      ).toEqual([{ status: "failed", last_error_code: "user-cancelled" }]);
      expect(
        readRows<{ payload_json: string }>(
          path,
          "SELECT payload_json FROM slack_outbox WHERE client_message_id = ?",
          `${seeded.operationId}:cancelled`,
        ),
      ).toEqual([{ payload_json: JSON.stringify({ text: "Cancelled." }) }]);
      expect(
        store.claimNextOperation({ workerId: "coordinator-a", now, leaseMs: 10_000, maxConcurrentTasks: 2 }),
      ).toBeNull();

      const commands: T3Command[] = [];
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => current,
      });
      for (let iteration = 0; iteration < 10; iteration += 1) {
        expect((await worker.processNext()).kind).toBe("idle");
        current = new Date(current.getTime() + 3_600_000);
      }
      expect(commands).toEqual([]);
    });
  });

  test("cancelling a running operation sends exactly one interrupt carrying its turn id", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: null, now });
      store.markOperationTurnStarted({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        turnId: "turn-1",
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      expect(router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId })).kind).toBe(
        "accepted",
      );
      expect(
        router.ingest(
          actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId, actionTs: "1000.000021" }),
        ).kind,
      ).toBe("duplicate");

      const commands: T3Command[] = [];
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1"),
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => current,
      });
      const outcomes: string[] = [];
      for (let iteration = 0; iteration < 10; iteration += 1) {
        outcomes.push((await worker.processNext()).kind);
        current = new Date(current.getTime() + 3_600_000);
      }
      expect(outcomes).toEqual(["resolved", ...Array.from({ length: 9 }, () => "idle")]);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: seeded.threadId,
        turnId: "turn-1",
      });
    });
  });

  test("a fresh cancel requeues a cancellation whose transient retries were exhausted", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        turnId: "turn-1",
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = (actionTs: string) =>
        router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId, actionTs }));
      const first = cancel("1000.000020");
      expect(first.kind).toBe("accepted");

      const commands: T3Command[] = [];
      let t3Down = true;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1"),
          dispatch: async (command) => {
            commands.push(command);
            if (t3Down) throw new Error("socket closed before the receipt arrived");
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        retry: { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 2 },
        now: () => current,
      });
      const outcomes: string[] = [];
      for (let iteration = 0; iteration < 4; iteration += 1) {
        outcomes.push((await worker.processNext()).kind);
        current = new Date(current.getTime() + 3_600_000);
      }
      expect(outcomes).toEqual(["retry-scheduled", "failed", "idle", "idle"]);

      // A redelivery of the original click stays deduplicated and does not requeue.
      expect(cancel("1000.000020").kind).toBe("duplicate");
      expect((await worker.processNext()).kind).toBe("idle");

      // After T3 recovers, a fresh click requeues the same cancellation and command id once.
      t3Down = false;
      const fresh = cancel("1000.000030");
      expect(fresh).toMatchObject({ kind: "accepted", commandId: "commandId" in first ? first.commandId : "" });
      expect(cancel("1000.000030").kind).toBe("duplicate");
      expect(cancel("1000.000031").kind).toBe("duplicate");
      expect((await worker.processNext()).kind).toBe("resolved");
      expect((await worker.processNext()).kind).toBe("idle");
      expect(commands).toHaveLength(3);
      expect(new Set(commands.map((command) => command.commandId)).size).toBe(1);
      expect(commands[2]).toMatchObject({ type: "thread.turn.interrupt", turnId: "turn-1" });
      expect(
        readRows(path, "SELECT state, attempts, retries_exhausted FROM interactions WHERE kind = 'cancel'"),
      ).toEqual([{ state: "resolved", attempts: 1, retries_exhausted: 0 }]);
    });
  });

  test("a redelivered cancel superseded by a requeue does not cancel the next operation", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        turnId: "turn-1",
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = (actionTs: string) =>
        router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId, actionTs }));
      expect(cancel("1000.000020").kind).toBe("accepted");

      let t3Down = true;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1"),
          dispatch: async () => {
            if (t3Down) throw new Error("socket closed before the receipt arrived");
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        retry: { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 1 },
        now: () => current,
      });
      expect((await worker.processNext()).kind).toBe("failed");

      // A fresh click requeues the exhausted cancellation, which then resolves.
      t3Down = false;
      expect(cancel("1000.000030").kind).toBe("accepted");
      expect((await worker.processNext()).kind).toBe("resolved");

      // The interrupted turn finishes and the next request is queued on the same task.
      store.completeOperation({ operationId: seeded.operationId, workerId: "coordinator-a", resultSequence: 2, now });
      const next = seedOperation(store);
      expect(next.taskId).toBe(seeded.taskId);
      expect(next.operationId).not.toBe(seeded.operationId);

      // Late redeliveries of either accepted click stay duplicates of the original cancellation.
      expect(cancel("1000.000020").kind).toBe("duplicate");
      expect(cancel("1000.000030").kind).toBe("duplicate");
      expect(
        readRows(path, "SELECT status FROM operations WHERE operation_id = ?", next.operationId),
      ).toEqual([{ status: "pending" }]);
      expect(readRows(path, "SELECT COUNT(*) AS count FROM interactions WHERE kind = 'cancel'")).toEqual([
        { count: 1 },
      ]);
    });
  });

  async function exhaustCancelThenFailOperation(
    errorCode: string,
    /** The T3 thread after the operation failed; by default its turn-1 is still running. */
    threadAfterFailure: (threadId: string) => T3ThreadSnapshot = (threadId) => threadWithTurn(threadId, "turn-1"),
  ) {
    let result: {
      readonly first: ReturnType<SlackActionRouter["ingest"]>;
      readonly fresh: ReturnType<SlackActionRouter["ingest"]>;
      readonly outcome: string;
      readonly commands: T3Command[];
    } | undefined;
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = (actionTs: string) =>
        router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId, actionTs }));
      const first = cancel("1000.000020");
      expect(first.kind).toBe("accepted");
      const commands: T3Command[] = [];
      let t3Down = true;
      let operationFailed = false;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => (operationFailed ? threadAfterFailure(threadId) : threadWithTurn(threadId, "turn-1")),
          dispatch: async (command) => {
            commands.push(command);
            if (t3Down) throw new Error("socket closed before the receipt arrived");
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        retry: { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 2 },
        now: () => current,
      });
      expect((await worker.processNext()).kind).toBe("retry-scheduled");
      current = new Date(current.getTime() + 3_600_000);
      expect((await worker.processNext()).kind).toBe("failed");
      // The operation then fails too, while T3 is still unreachable.
      store.failOperation({ operationId: seeded.operationId, workerId: "coordinator-a", errorCode, retryable: false, now });
      operationFailed = true;
      t3Down = false;
      const fresh = cancel("1000.000030");
      current = new Date(current.getTime() + 3_600_000);
      const outcome = (await worker.processNext()).kind;
      result = { first, fresh, outcome, commands };
    });
    if (result === undefined) throw new Error("fixture did not run");
    return result;
  }

  test("a fresh cancel requeues an exhausted cancellation whose operation failed locally", async () => {
    const { first, fresh, outcome, commands } = await exhaustCancelThenFailOperation("T3TurnStalled");
    expect(fresh).toMatchObject({ kind: "accepted", commandId: "commandId" in first ? first.commandId : "" });
    expect(outcome).toBe("resolved");
    expect(commands).toHaveLength(3);
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(1);
    expect(commands[2]).toMatchObject({ type: "thread.turn.interrupt", turnId: "turn-1" });
  });

  test("a requeued cancellation never interrupts a newer turn that replaced its locally failed operation's turn", async () => {
    // T3 0.0.45 interrupts whatever the session runs and ignores the turn id, so turn-1 must be current.
    const { fresh, outcome, commands } = await exhaustCancelThenFailOperation(
      "T3TurnStalled",
      (threadId) => threadWithTurn(threadId, "turn-2"),
    );
    expect(fresh.kind).toBe("accepted");
    expect(outcome).toBe("failed");
    expect(commands).toHaveLength(2);
  });

  test("a requeued cancellation settles without interrupting once its known turn has ended in T3", async () => {
    const { outcome, commands } = await exhaustCancelThenFailOperation(
      "T3TurnStalled",
      (threadId) => threadWithTurn(threadId, "turn-1", { state: "completed" }),
    );
    expect(outcome).toBe("failed");
    expect(commands).toHaveLength(2);
  });

  test("a cancel never interrupts when the T3 session's active turn is not the operation's", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
      const cancel = store.requestTaskCancellation({
        taskId: seeded.taskId,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "cancel-other-active-turn",
        now,
      });
      if (cancel.kind === "denied") throw new Error("cancel was denied");
      const commands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          // The projection still names turn-1, but the provider session already runs turn-2.
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1", { activeTurnId: "turn-2" }),
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
      expect(commands).toEqual([]);
      expect(noticesFor(path, cancel.interactionId)).toEqual([NO_LONGER_PENDING_NOTICE]);
    });
  });

  /** A thread snapshot with the given user messages and latest turn. */
  function threadWithMessages(
    threadId: string,
    latest: { readonly turnId: string; readonly requestedAt: string; readonly state?: "running" | "completed" },
    messages: ReadonlyArray<{ readonly id: string; readonly turnId: string | null; readonly createdAt: string }>,
  ): T3ThreadSnapshot {
    const base = threadWithTurn(threadId, latest.turnId, { state: latest.state ?? "running" });
    return {
      ...base,
      thread: {
        ...base.thread,
        latestTurn: base.thread.latestTurn === null ? null : { ...base.thread.latestTurn, requestedAt: latest.requestedAt },
        messages: messages.map((message) => ({
          ...message,
          role: "user" as const,
          text: message.id,
          streaming: false,
          updatedAt: message.createdAt,
        })),
      },
    };
  }

  const minutesAfterNow = (minutes: number): string => new Date(Date.parse(now) + minutes * 60_000).toISOString();

  /** Records a message-mode (dismissible) question for the operation and answers it from Slack. */
  function answerAsyncQuestion(
    store: AgentTagStore,
    seeded: ReturnType<typeof seedOperation>,
    requestId: string,
    answerActionTs: string | null,
  ): void {
    const prompt = {
      requestId,
      dismissible: true,
      questions: [
        { id: "package", header: "Package", question: "Which package?", options: [{ label: "core" }], multiSelect: false },
      ],
    };
    const pending = store.recordPendingInteraction({
      ...seeded,
      requestId,
      kind: "user-input",
      prompt,
      conversationId: "C1",
      threadTs: "1000.000001",
      message: (interactionId) => questionMessage(interactionId, prompt),
      now,
    });
    if (answerActionTs === null) return;
    const router = new SlackActionRouter({ config, store, now: () => now });
    expect(
      router.ingest(
        actionBody({
          actionId: "agent-tag.user-input.answer",
          value: JSON.stringify({ interactionId: pending.interactionId, questionId: "package", answer: "core" }),
          actionTs: answerActionTs,
        }),
      ).kind,
    ).toBe("accepted");
  }

  for (const tied of [true, false]) {
    test(`a cancel after a message-mode answer interrupts the operation's continuation turn (message ${tied ? "tied to" : "untied from"} its turn)`, async () => {
      await withStore(async ({ store, path }) => {
        const seeded = seedOperation(store);
        claimRunningOperation(store, seeded.operationId);
        store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
        const messageId = readRows<{ message_id: string }>(
          path,
          "SELECT message_id FROM operations WHERE operation_id = ?",
          seeded.operationId,
        )[0]?.message_id ?? "";
        answerAsyncQuestion(store, seeded, "question-1", "1000.000031");
        store.deferOperation({
          operationId: seeded.operationId,
          workerId: "coordinator-a",
          blockedUntil: new Date(Date.parse(now) + 24 * 3_600_000).toISOString(),
          now,
        });
        // T3 0.0.45 answers a message-mode question with user message `async-answer:<requestId>`
        // and a continuation turn (turn-2) that replaces the operation's original turn-1.
        let phase: "original" | "answered" | "continuation" = "original";
        const fetchThread = async (threadId: string): Promise<T3ThreadSnapshot> => {
          const original = { id: messageId, turnId: "turn-1", createdAt: now };
          if (phase === "original") return threadWithMessages(threadId, { turnId: "turn-1", requestedAt: now }, [original]);
          const answer = { id: "async-answer:question-1", turnId: tied && phase === "continuation" ? "turn-2" : null, createdAt: minutesAfterNow(1) };
          return phase === "answered"
            ? threadWithMessages(threadId, { turnId: "turn-1", requestedAt: now, state: "completed" }, [original, answer])
            : threadWithMessages(threadId, { turnId: "turn-2", requestedAt: minutesAfterNow(1) }, [original, answer]);
        };
        const commands: T3Command[] = [];
        let current = new Date(now);
        const worker = new InteractionWorker({
          config,
          store,
          t3: {
            fetchThread,
            dispatch: async (command) => {
              commands.push(command);
              if (command.type === "thread.user-input.respond") phase = "answered";
              return { sequence: commands.length };
            },
          },
          workerId: "interaction-a",
          now: () => current,
        });
        expect((await worker.processNext()).kind).toBe("resolved");
        expect(commands[0]).toMatchObject({ type: "thread.user-input.respond", requestId: "question-1" });

        const router = new SlackActionRouter({ config, store, now: () => now });
        expect(router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId })).kind).toBe(
          "accepted",
        );
        // T3 holds the answer but has not started its turn: wait instead of settling.
        const waiting = await worker.processNext();
        expect(waiting).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnNotStarted" });
        if (waiting.kind !== "retry-scheduled") throw new Error("expected a retry");
        phase = "continuation";
        current = new Date(waiting.blockedUntil);
        expect((await worker.processNext()).kind).toBe("resolved");
        expect(commands.slice(1)).toEqual([
          expect.objectContaining({ type: "thread.turn.interrupt", threadId: seeded.threadId, turnId: "turn-2" }),
        ]);
      });
    });
  }

  // r12 P2. Since #11 the coordinator does not settle an operation while a delivered message-mode
  // answer's continuation is pending (`awaitingT3AnswerContinuation`), so it cannot reach this state;
  // the worker must still not trust a local `succeeded` (or T3-ended failure) over T3 when the
  // operation answered a message-mode question, because only T3 knows whether that answer's
  // continuation turn is running.
  for (const settled of [
    { status: "succeeded", errorCode: null },
    { status: "failed", errorCode: "T3TurnError" },
  ] as const) {
    for (const continuation of ["running", "completed"] as const) {
      test(`a cancel for an operation settled as ${settled.errorCode ?? settled.status} before its answer's continuation started reads T3 (continuation ${continuation})`, async () => {
        await withStore(async ({ store, path }) => {
          const seeded = seedOperation(store);
          claimRunningOperation(store, seeded.operationId);
          store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
          const messageId = readRows<{ message_id: string }>(
            path,
            "SELECT message_id FROM operations WHERE operation_id = ?",
            seeded.operationId,
          )[0]?.message_id ?? "";
          answerAsyncQuestion(store, seeded, "question-1", "1000.000031");
          let phase: "answered" | "continuation" = "answered";
          let fetches = 0;
          const fetchThread = async (threadId: string): Promise<T3ThreadSnapshot> => {
            fetches += 1;
            const original = { id: messageId, turnId: "turn-1", createdAt: now };
            const answer = { id: "async-answer:question-1", turnId: null, createdAt: minutesAfterNow(1) };
            return phase === "answered"
              ? threadWithMessages(threadId, { turnId: "turn-1", requestedAt: now, state: "completed" }, [original, answer])
              : threadWithMessages(threadId, { turnId: "turn-2", requestedAt: minutesAfterNow(1), state: continuation }, [original, answer]);
          };
          const commands: T3Command[] = [];
          const worker = new InteractionWorker({
            config,
            store,
            t3: { fetchThread, dispatch: async (command) => (commands.push(command), { sequence: commands.length }) },
            workerId: "interaction-a",
            now: () => new Date(now),
          });
          // The answer is delivered while the operation runs; T3 has not started its continuation yet.
          expect((await worker.processNext()).kind).toBe("resolved");
          const router = new SlackActionRouter({ config, store, now: () => now });
          expect(router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId })).kind).toBe("accepted");
          // The pre-#11 coordinator settled here, from the completed turn-1 that asked.
          if (settled.status === "succeeded") {
            store.completeOperation({ operationId: seeded.operationId, workerId: "coordinator-a", resultSequence: 1, now });
          } else {
            store.failOperation({ operationId: seeded.operationId, workerId: "coordinator-a", errorCode: settled.errorCode, retryable: false, now });
          }
          expect(readRows<{ status: string }>(path, "SELECT status FROM operations WHERE operation_id = ?", seeded.operationId))
            .toEqual([{ status: settled.status }]);
          phase = "continuation";
          const outcome = await worker.processNext();
          expect(fetches).toBe(1);
          if (continuation === "running") {
            expect(outcome.kind).toBe("resolved");
            expect(commands.slice(1)).toEqual([
              expect.objectContaining({ type: "thread.turn.interrupt", threadId: seeded.threadId, turnId: "turn-2" }),
            ]);
          } else {
            expect(outcome).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
            expect(commands.slice(1)).toEqual([]);
          }
        });
      });
    }
  }

  test("a cancel for a settled operation that answered no message-mode question settles without reading T3", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
      answerAsyncQuestion(store, seeded, "question-1", null);
      const router = new SlackActionRouter({ config, store, now: () => now });
      expect(router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId })).kind).toBe("accepted");
      store.completeOperation({ operationId: seeded.operationId, workerId: "coordinator-a", resultSequence: 1, now });
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async () => { throw new Error("T3 must not be read"); },
          dispatch: async () => { throw new Error("T3 must not be called"); },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
    });
  });

  /**
   * The older operation answered a message-mode question (continuation turn-2), its cancel exhausted
   * retries, and it failed locally. A newer operation on the task then runs turn-3, and a fresh click
   * requeues the older cancellation against a thread whose user messages after the newer one's are
   * `afterNewer`. Returns the requeued cancel's outcome and the interrupts sent after the requeue.
   */
  async function requeueOlderCancelWhileNewerRuns(
    afterNewer: ReadonlyArray<{ readonly id: string; readonly turnId: string | null; readonly createdAt: string }>,
  ) {
    let result: { readonly outcome: InteractionWorkerOutcome; readonly interrupts: T3Command[] } | undefined;
    await withStore(async ({ store, path }) => {
      const older = seedOperation(store);
      claimRunningOperation(store, older.operationId);
      store.markOperationTurnStarted({ operationId: older.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
      answerAsyncQuestion(store, older, "question-1", "1000.000031");
      // Asked by the older operation too; any answer to it arrives only after the newer one started.
      answerAsyncQuestion(store, older, "question-2", null);
      const messageIdOf = (operationId: string): string => {
        const [row] = readRows<{ message_id: string }>(
          path,
          "SELECT message_id FROM operations WHERE operation_id = ?",
          operationId,
        );
        if (row === undefined) throw new Error("operation not found");
        return row.message_id;
      };
      const olderMessages = [
        { id: messageIdOf(older.operationId), turnId: "turn-1", createdAt: now },
        { id: "async-answer:question-1", turnId: "turn-2", createdAt: minutesAfterNow(1) },
      ];
      let snapshot = (threadId: string) =>
        threadWithMessages(threadId, { turnId: "turn-2", requestedAt: minutesAfterNow(1) }, olderMessages);
      const commands: T3Command[] = [];
      let t3Down = false;
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => snapshot(threadId),
          dispatch: async (command) => {
            commands.push(command);
            if (t3Down) throw new Error("socket closed before the receipt arrived");
            return { sequence: commands.length };
          },
        },
        workerId: "interaction-a",
        retry: { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 1 },
        now: () => current,
      });
      expect((await worker.processNext()).kind).toBe("resolved");

      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = (actionTs: string) =>
        router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: older.taskId, actionTs }));
      expect(cancel("1000.000040").kind).toBe("accepted");
      t3Down = true;
      expect((await worker.processNext()).kind).toBe("failed");
      // It did target the continuation while the older operation owned the current turn.
      expect(commands.at(-1)).toMatchObject({ type: "thread.turn.interrupt", turnId: "turn-2" });
      store.failOperation({
        operationId: older.operationId,
        workerId: "coordinator-a",
        errorCode: "T3TurnStalled",
        retryable: false,
        now,
      });

      const newer = seedOperation(store);
      expect(newer.taskId).toBe(older.taskId);
      claimRunningOperation(store, newer.operationId);
      store.markOperationTurnStarted({ operationId: newer.operationId, workerId: "coordinator-a", turnId: "turn-3", now });
      snapshot = (threadId) => threadWithMessages(threadId, { turnId: "turn-3", requestedAt: minutesAfterNow(2) }, [
        ...olderMessages,
        { id: messageIdOf(newer.operationId), turnId: "turn-3", createdAt: minutesAfterNow(2) },
        ...afterNewer,
      ]);
      t3Down = false;
      const dispatched = commands.length;
      expect(cancel("1000.000050").kind).toBe("accepted");
      current = new Date(current.getTime() + 3_600_000);
      const outcome = await worker.processNext();
      result = { outcome, interrupts: commands.slice(dispatched) };
    });
    if (result === undefined) throw new Error("fixture did not run");
    return result;
  }

  test("a cancel after a message-mode answer never interrupts a newer operation's turn", async () => {
    const { outcome, interrupts } = await requeueOlderCancelWhileNewerRuns([]);
    expect(outcome).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
    expect(interrupts).toEqual([]);
  });

  test("a late message-mode answer that steers a newer operation's turn does not make that turn the older operation's", async () => {
    for (const turnId of ["turn-3", null]) {
      const { outcome, interrupts } = await requeueOlderCancelWhileNewerRuns([
        { id: "async-answer:question-2", turnId, createdAt: minutesAfterNow(3) },
      ]);
      expect(outcome).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
      expect(interrupts).toEqual([]);
    }
  });

  test.each(["T3TurnError", "T3ModelSwitchRejected"])("a fresh cancel does not requeue an exhausted cancellation whose T3 turn is confirmed ended (%s)", async (errorCode) => {
    const { fresh, outcome, commands } = await exhaustCancelThenFailOperation(errorCode);
    expect(fresh).toMatchObject({ kind: "ignored", reason: "interaction-denied" });
    expect(outcome).toBe("idle");
    expect(commands).toHaveLength(2);
  });

  test("a fresh cancel does not requeue a cancellation T3 rejected", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        turnId: "turn-1",
        now,
      });
      const router = new SlackActionRouter({ config, store, now: () => now });
      const cancel = (actionTs: string) =>
        router.ingest(actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId, actionTs }));
      expect(cancel("1000.000020").kind).toBe("accepted");
      let dispatches = 0;
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1"),
          dispatch: async () => {
            dispatches += 1;
            throw {
              _tag: "OrchestrationDispatchCommandError",
              message: `Orchestration command invariant failed (thread.turn.interrupt): Thread '${seeded.threadId}' does not exist for command 'thread.turn.interrupt'.`,
            };
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect((await worker.processNext()).kind).toBe("failed");
      expect(cancel("1000.000030").kind).toBe("duplicate");
      expect((await worker.processNext()).kind).toBe("idle");
      expect(dispatches).toBe(1);
    });
  });

  test("a cancel that races the turn start waits for the turn instead of interrupting blindly", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      expect(
        store.requestTaskCancellation({
          taskId: seeded.taskId,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          sourceActionId: "cancel-before-turn",
          now,
        }),
      ).toMatchObject({ kind: "accepted", disposition: "interrupt-requested" });
      const commands: T3Command[] = [];
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-2"),
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => current,
      });
      const waiting = await worker.processNext();
      expect(waiting).toMatchObject({ kind: "retry-scheduled", errorCode: "T3TurnNotStarted" });
      if (waiting.kind !== "retry-scheduled") throw new Error("expected a retry");
      expect(commands).toEqual([]);

      store.markOperationTurnStarted({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        turnId: "turn-2",
        now,
      });
      current = new Date(waiting.blockedUntil);
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ type: "thread.turn.interrupt", turnId: "turn-2" });
    });
  });

  test("a cancel still interrupts a started turn whose operation failed locally after the settlement timeout", async () => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-4", now });
      const cancel = store.requestTaskCancellation({
        taskId: seeded.taskId,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "cancel-after-stall",
        now,
      });
      if (cancel.kind === "denied") throw new Error("cancel was denied");
      // The coordinator gave up waiting: a local failure that does not prove the T3 turn ended.
      store.failOperation({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        errorCode: "T3TurnStalled",
        retryable: false,
        now,
      });
      const commands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-4"),
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ type: "thread.turn.interrupt", turnId: "turn-4" });
      expect(noticesFor(path, cancel.interactionId)).toEqual([]);
    });
  });

  test.each(["T3TurnError", "T3ModelSwitchRejected"])("a cancel whose operation already finished settles without T3 and says so once (%s)", async (errorCode) => {
    await withStore(async ({ store, path }) => {
      const seeded = seedOperation(store);
      claimRunningOperation(store, seeded.operationId);
      store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-3", now });
      const cancel = store.requestTaskCancellation({
        taskId: seeded.taskId,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "cancel-late",
        now,
      });
      if (cancel.kind === "denied") throw new Error("cancel was denied");
      store.failOperation({
        operationId: seeded.operationId,
        workerId: "coordinator-a",
        errorCode,
        retryable: false,
        now,
      });
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: unexpectedThreadFetch,
          dispatch: async () => {
            throw new Error("a finished operation must not reach T3");
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
      expect((await worker.processNext()).kind).toBe("idle");
      expect(noticesFor(path, cancel.interactionId)).toEqual([NO_LONGER_PENDING_NOTICE]);
    });
  });

  /** An operation deferred for a day on a pending approval, with a cancel queued against its turn. */
  function deferredOperationWithCancel(store: AgentTagStore): ReturnType<typeof seedOperation> {
    const seeded = seedOperation(store);
    claimRunningOperation(store, seeded.operationId);
    store.markOperationTurnStarted({ operationId: seeded.operationId, workerId: "coordinator-a", turnId: "turn-1", now });
    store.deferOperation({
      operationId: seeded.operationId,
      workerId: "coordinator-a",
      blockedUntil: new Date(Date.parse(now) + 24 * 3_600_000).toISOString(),
      now,
    });
    expect(store.claimNextOperation({ workerId: "coordinator-b", now, leaseMs: 10_000, maxConcurrentTasks: 2 }))
      .toBeNull();
    expect(
      store.requestTaskCancellation({
        taskId: seeded.taskId,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        sourceActionId: "cancel-deferred",
        now,
      }),
    ).toMatchObject({ kind: "accepted", disposition: "interrupt-requested" });
    return seeded;
  }

  test("a cancel that finds the deferred operation's turn already ended unblocks the operation", async () => {
    await withStore(async ({ store }) => {
      const seeded = deferredOperationWithCancel(store);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1", { state: "completed" }),
          dispatch: async () => {
            throw new Error("an ended turn must not be interrupted");
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "OperationNotRunning" });
      // The coordinator can claim the operation at once to observe and finalize the ended turn.
      expect(store.claimNextOperation({ workerId: "coordinator-b", now, leaseMs: 10_000, maxConcurrentTasks: 2 }))
        .toMatchObject({ operationId: seeded.operationId });
    });
  });

  test("a cancel keeps its deferred operation blocked while retrying and unblocks it once retries are exhausted", async () => {
    await withStore(async ({ store }) => {
      const seeded = deferredOperationWithCancel(store);
      let current = new Date(now);
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          fetchThread: async (threadId) => threadWithTurn(threadId, "turn-1"),
          dispatch: async () => {
            throw new Error("socket closed before the receipt arrived");
          },
        },
        workerId: "interaction-a",
        retry: { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 2 },
        now: () => current,
      });
      const claimOperation = () =>
        store.claimNextOperation({
          workerId: "coordinator-b",
          now: current.toISOString(),
          leaseMs: 10_000,
          maxConcurrentTasks: 2,
        });
      const first = await worker.processNext();
      expect(first.kind).toBe("retry-scheduled");
      if (first.kind !== "retry-scheduled") throw new Error("expected a retry");
      current = new Date(first.blockedUntil);
      expect(claimOperation()).toBeNull();
      expect(await worker.processNext()).toMatchObject({ kind: "failed", errorCode: "Error" });
      expect(claimOperation()).toMatchObject({ operationId: seeded.operationId });
    });
  });
});
