import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
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
        prompt: { question: "Which package?" },
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
      const worker = new InteractionWorker({ store, t3, workerId: "interaction-a", now: () => new Date(now) });
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
});
