import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator, type T3CoordinatorGateway } from "../src/coordinator.ts";
import type { ServiceLogRecord } from "../src/service.ts";
import type { SlackContextSource } from "../src/slack/context-source.ts";
import { SlackUserDirectory } from "../src/slack/users.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";

const start = "2026-10-01T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U0A1", "U0B2"], allowedChannelIds: ["C1"] },
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
  limits: { maxConcurrentTasks: 1 },
});

const PEOPLE: Record<string, string> = { U0A1: "Alice Chen", U0B2: "Bob Lee" };

function completedSnapshot(threadId: string, userMessageId: string, requestedAt: string): T3ThreadSnapshot {
  return {
    snapshotSequence: 9,
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "agent-tag/task-1",
      worktreePath: "/tmp/worktree",
      latestTurn: {
        turnId: `turn-${userMessageId}`,
        state: "completed",
        requestedAt,
        startedAt: requestedAt,
        completedAt: requestedAt,
        assistantMessageId: `assistant-${userMessageId}`,
      },
      messages: [
        {
          id: userMessageId,
          role: "user",
          text: "request",
          turnId: null,
          streaming: false,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        },
        {
          id: `assistant-${userMessageId}`,
          role: "assistant",
          text: "done",
          turnId: `turn-${userMessageId}`,
          streaming: false,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        },
      ],
      activities: [],
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: requestedAt,
      },
    },
  };
}

/** A users.info fake that counts every Slack call. */
function countingSlack(options: { readonly names?: Record<string, string>; readonly error?: string } = {}) {
  const calls: string[] = [];
  const logs: ServiceLogRecord[] = [];
  const users = new SlackUserDirectory({
    lookup: async (userId) => {
      calls.push(userId);
      if (options.error !== undefined) {
        throw Object.assign(new Error(options.error), {
          code: "slack_webapi_platform_error",
          data: { ok: false, error: options.error },
        });
      }
      return { ok: true, user: { id: userId, profile: { display_name: (options.names ?? PEOPLE)[userId] ?? "" } } };
    },
    logger: (record) => logs.push(record),
  });
  const source: SlackContextSource = { botUserId: "UBOT", selfBotId: "BSELF", users };
  return { calls, logs, source };
}

function recordingT3(clock: () => Date, options: { failTurnStarts?: number } = {}) {
  const commands: T3Command[] = [];
  let failTurnStarts = options.failTurnStarts ?? 0;
  let threadId = "not-dispatched";
  let messageId = "not-dispatched";
  const t3: T3CoordinatorGateway = {
    dispatch: async (command) => {
      if (command.type === "thread.turn.start") {
        commands.push(command);
        if (failTurnStarts > 0) {
          failTurnStarts -= 1;
          throw new Error("transient T3 failure");
        }
        threadId = command.threadId;
        messageId = command.message.messageId;
      }
      return { sequence: commands.length };
    },
    fetchThread: async () => completedSnapshot(threadId, messageId, clock().toISOString()),
  };
  const turnTexts = () =>
    commands.flatMap((command) => (command.type === "thread.turn.start" ? [command.message.text] : []));
  return { t3, turnTexts };
}

function slackEvent(overrides: Partial<SlackEventInput> & { readonly ts: string }): SlackEventInput {
  const { ts, ...rest } = overrides;
  return {
    deliveryId: `delivery-${ts}`,
    eventKey: `C1:${ts}`,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    actorUserId: "U0A1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text: "request",
    receivedAt: start,
    sourceOrderKey: ts,
    messageTs: ts,
    origin: "slack",
    ...rest,
  };
}

async function withStore(run: (store: AgentTagStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-turn-text-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    await run(store);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-turn-text-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

describe("coordinator turn envelope", () => {
  test("two allowlisted users steering one thread are attributed by name and ID (D3)", async () => {
    await withStore(async (store) => {
      let current = new Date(start).getTime();
      const clock = () => new Date(current);
      const slack = countingSlack();
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: slack.source,
        workerId: "worker-a",
        now: clock,
        sleep: async (milliseconds) => {
          current += milliseconds;
        },
      });

      store.ingestSlackEvent(slackEvent({ ts: "1000.000001", text: "investigate the flaky build" }));
      expect((await coordinator.processNext()).kind).toBe("completed");
      store.ingestSlackEvent(slackEvent({ ts: "1000.000002", actorUserId: "U0B2", text: "also check the retry path" }));
      expect((await coordinator.processNext()).kind).toBe("completed");

      expect(turnTexts()).toEqual([
        "Slack message from Alice Chen (U0A1):\ninvestigate the flaky build",
        "Slack message from Bob Lee (U0B2):\nalso check the retry path",
      ]);
      expect(slack.calls).toEqual(["U0A1", "U0B2"]);
    });
  });

  test("mentions in the request resolve to names; the agent's own renders as @Agent Tag (D4)", async () => {
    await withStore(async (store) => {
      const clock = () => new Date(start);
      const slack = countingSlack();
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: slack.source,
        workerId: "worker-a",
        now: clock,
        sleep: async () => {},
      });
      store.ingestSlackEvent(
        slackEvent({ ts: "1000.000001", text: "pair with <@U0B2> in <#C9|eng>, <!here> and ask <@UBOT|agent>" }),
      );
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(turnTexts()).toEqual([
        "Slack message from Alice Chen (U0A1):\npair with @Bob Lee in #eng, @here and ask @Agent Tag",
      ]);
      expect(slack.calls.sort()).toEqual(["U0A1", "U0B2"]);
    });
  });

  test("a retry after the text is frozen makes zero Slack calls and resends identical text (D11)", async () => {
    await withStore(async (store) => {
      let current = new Date(start).getTime();
      const clock = () => new Date(current);
      const first = countingSlack();
      const { t3, turnTexts } = recordingT3(clock, { failTurnStarts: 1 });
      const firstCoordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: first.source,
        workerId: "worker-a",
        now: clock,
        sleep: async () => {},
      });
      store.ingestSlackEvent(slackEvent({ ts: "1000.000001", text: "ship it with <@U0B2>" }));
      expect(await firstCoordinator.processNext()).toMatchObject({ kind: "retry-scheduled" });
      expect(first.calls.sort()).toEqual(["U0A1", "U0B2"]);

      // A restarted worker with an empty cache and renamed users must not consult Slack at all.
      current += 60_000;
      const second = countingSlack({ names: { U0A1: "Renamed Alice", U0B2: "Renamed Bob" } });
      const secondCoordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: second.source,
        workerId: "worker-b",
        now: clock,
        sleep: async () => {},
      });
      expect((await secondCoordinator.processNext()).kind).toBe("completed");
      expect(second.calls).toEqual([]);
      const texts = turnTexts();
      expect(texts).toHaveLength(2);
      expect(texts[1]).toBe(texts[0]);
      expect(texts[0]).toBe("Slack message from Alice Chen (U0A1):\nship it with @Bob Lee");
    });
  });

  test("missing users:read degrades to raw IDs with one warning and still dispatches", async () => {
    await withStore(async (store) => {
      const clock = () => new Date(start);
      const slack = countingSlack({ error: "missing_scope" });
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: slack.source,
        workerId: "worker-a",
        now: clock,
        sleep: async () => {},
      });
      store.ingestSlackEvent(slackEvent({ ts: "1000.000001", text: "ask <@U0B2>" }));
      store.ingestSlackEvent(slackEvent({ ts: "2000.000001", threadTs: "2000.000001", actorUserId: "U0B2", text: "next" }));
      expect((await coordinator.processNext()).kind).toBe("completed");
      // The first turn's lookups run concurrently, so both may reach Slack before it is disabled.
      const firstTurnCalls = slack.calls.length;
      expect(firstTurnCalls).toBeGreaterThanOrEqual(1);
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(turnTexts()).toEqual([
        "Slack message from U0A1 (U0A1):\nask @U0B2",
        "Slack message from U0B2 (U0B2):\nnext",
      ]);
      expect(slack.calls).toHaveLength(firstTurnCalls);
      expect(slack.logs.map((log) => [log.event, log.errorCode])).toEqual([["slack.users.disabled", "missing_scope"]]);
    });
  });

  test("scheduled operations use the routine header", async () => {
    await withStore(async (store) => {
      const clock = () => new Date(start);
      const slack = countingSlack();
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: slack.source,
        workerId: "worker-a",
        now: clock,
        sleep: async () => {},
      });
      const { messageTs: _messageTs, ...scheduled } = slackEvent({ ts: "1000.000001", text: "check CI", origin: "schedule" });
      store.ingestSlackEvent(scheduled);
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(turnTexts()).toEqual(["Scheduled routine run (created by Alice Chen (U0A1)):\ncheck CI"]);
    });
  });

  test("slow speaker lookups are bounded well inside the lease and fall back to raw IDs", async () => {
    await withStore(async (store) => {
      let current = new Date(start).getTime();
      const clock = () => new Date(current);
      const calls: string[] = [];
      // Every users.info call costs 5s of lease time and never answers; 28 mentioned users
      // would otherwise hold the claim for ~35s+ against a 30s lease before dispatch.
      const users = new SlackUserDirectory({
        lookup: (userId) => {
          calls.push(userId);
          current += 5_000;
          return new Promise(() => {});
        },
        lookupTimeoutMs: 5_000,
        logger: () => {},
      });
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: { botUserId: "UBOT", users },
        workerId: "worker-a",
        leaseMs: 30_000,
        speakerLookupBudgetMs: 20,
        now: clock,
        sleep: async () => {},
      });
      const mentioned = Array.from({ length: 27 }, (_, index) => `U${String(index + 10).padStart(3, "0")}`);
      store.ingestSlackEvent(
        slackEvent({ ts: "1000.000001", text: mentioned.map((id) => `<@${id}>`).join(" ") }),
      );
      const outcome = await coordinator.processNext();
      expect(outcome.kind).toBe("completed");
      const [text] = turnTexts();
      expect(text).toBe(`Slack message from U0A1 (U0A1):\n${mentioned.map((id) => `@${id}`).join(" ")}`);
      // Only the first concurrent batch started before the turn-wide deadline.
      expect(calls.length).toBeLessThanOrEqual(4);
    });
  }, 2_000);

  test("scheduled prompts are not scanned for Slack mentions", async () => {
    await withStore(async (store) => {
      const clock = () => new Date(start);
      const slack = countingSlack();
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3,
        slackContext: slack.source,
        workerId: "worker-a",
        now: clock,
        sleep: async () => {},
      });
      const { messageTs: _messageTs, ...scheduled } = slackEvent({
        ts: "1000.000001",
        text: "Review Array<T> with <@U0B2> &amp; <div>x</div>",
        origin: "schedule",
      });
      store.ingestSlackEvent(scheduled);
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(turnTexts()).toEqual([
        "Scheduled routine run (created by Alice Chen (U0A1)):\nReview Array<T> with <@U0B2> &amp; <div>x</div>",
      ]);
      expect(slack.calls).toEqual(["U0A1"]);
    });
  });

  test("without a Slack context source speakers render as raw IDs", async () => {
    await withStore(async (store) => {
      const clock = () => new Date(start);
      const { t3, turnTexts } = recordingT3(clock);
      const coordinator = new AgentTagCoordinator({ config, store, t3, workerId: "worker-a", now: clock, sleep: async () => {} });
      store.ingestSlackEvent(slackEvent({ ts: "1000.000001", text: "hello <@U0B2>" }));
      expect((await coordinator.processNext()).kind).toBe("completed");
      expect(turnTexts()).toEqual(["Slack message from U0A1 (U0A1):\nhello @U0B2"]);
    });
  });
});
