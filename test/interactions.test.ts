import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { questionMessage } from "../src/coordinator.ts";
import { InteractionWorker, type T3InteractionGateway } from "../src/interaction-worker.ts";
import { SlackActionRouter } from "../src/slack/actions.ts";
import { AgentTagStore } from "../src/store/store.ts";
import type { T3Command } from "../src/t3/gateway.ts";

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
      expect((await firstWorker.processNext()).kind).toBe("retry-scheduled");
      initialStore.close();

      const reopened = await AgentTagStore.open(path);
      try {
        const secondWorker = new InteractionWorker({
          config,
          store: reopened,
          t3,
          workerId: "interaction-b",
          now: () => new Date(now),
        });
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

  test("turn cancellation is authorized, durable, and dispatched as an interrupt", async () => {
    await withStore(async ({ store }) => {
      const seeded = seedOperation(store);
      const router = new SlackActionRouter({ config, store, now: () => now });
      const result = router.ingest(
        actionBody({ actionId: "agent-tag.turn.cancel", value: seeded.taskId }),
      );
      expect(result.kind).toBe("accepted");
      const commands: T3Command[] = [];
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
          dispatch: async (command) => {
            commands.push(command);
            return { sequence: 1 };
          },
        },
        workerId: "interaction-a",
        now: () => new Date(now),
      });
      expect((await worker.processNext()).kind).toBe("resolved");
      expect(commands[0]).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: seeded.threadId,
      });
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
        now,
      });
      const worker = new InteractionWorker({
        config,
        store,
        t3: {
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
});
