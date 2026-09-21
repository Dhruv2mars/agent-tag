import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagSchedules, ScheduleWorker, type ScheduleContext } from "../src/scheduler.ts";
import { AgentTagStore } from "../src/store/store.ts";

const createdAt = "2026-09-21T00:00:00.000Z";
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

function acceptedSchedule(result: ReturnType<AgentTagSchedules["create"]>) {
  if (result.kind !== "accepted") throw new Error(`schedule fixture denied: ${result.reason}`);
  return result.schedule;
}

describe("durable scheduler", () => {
  test("recovers after restart and enforces missed-run, overlap, reminder, and cancellation policies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-scheduler-"));
    const path = join(directory, "agent-tag.sqlite");
    let store = await AgentTagStore.open(path);
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "initial task",
        receivedAt: createdAt,
      });
      const context: ScheduleContext = {
        workspaceId: "T1",
        actorUserId: "U1",
        profileId: "engineering",
        taskId: receipt.taskId,
      };
      let schedules = new AgentTagSchedules({ config, store });
      const recurring = acceptedSchedule(
        schedules.create({
          context,
          spec: {
            kind: "agent",
            prompt: "run the scheduled check",
            runAt: "2026-09-21T00:00:00.000Z",
            cadenceSeconds: 60,
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 10,
            overlapPolicy: "skip",
          },
          now: createdAt,
        }),
      );
      store.close();
      store = await AgentTagStore.open(path);
      schedules = new AgentTagSchedules({ config, store });

      const afterRestart = new ScheduleWorker({
        store,
        workerId: "schedule-a",
        now: () => new Date("2026-09-21T00:02:00.000Z"),
      });
      expect(await afterRestart.processNext()).toMatchObject({
        kind: "dispatched",
        scheduleId: recurring.scheduleId,
      });
      expect(schedules.list(context)[0]).toMatchObject({
        state: "active",
        nextRunAt: "2026-09-21T00:03:00.000Z",
      });

      const overlapping = new ScheduleWorker({
        store,
        workerId: "schedule-b",
        now: () => new Date("2026-09-21T00:03:00.000Z"),
      });
      expect(await overlapping.processNext()).toMatchObject({
        kind: "overlap-skipped",
        scheduleId: recurring.scheduleId,
      });
      expect(schedules.cancel({ context, scheduleId: recurring.scheduleId, now: "2026-09-21T00:03:01.000Z" })).toEqual({
        kind: "accepted",
      });

      const reminder = acceptedSchedule(
        schedules.create({
          context,
          spec: {
            kind: "reminder",
            prompt: "review the release",
            runAt: "2026-09-21T00:04:00.000Z",
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 60,
            overlapPolicy: "skip",
          },
          now: "2026-09-21T00:03:02.000Z",
        }),
      );
      const reminderWorker = new ScheduleWorker({
        store,
        workerId: "schedule-c",
        now: () => new Date("2026-09-21T00:04:00.000Z"),
      });
      expect(await reminderWorker.processNext()).toMatchObject({
        kind: "dispatched",
        scheduleId: reminder.scheduleId,
      });
      const reminderOutbox = store.claimNextOutbox({
        workerId: "slack-a",
        now: "2026-09-21T00:04:01.000Z",
        leaseMs: 10_000,
      });
      expect(reminderOutbox?.payload.text).toBe("Reminder: review the release");

      const skipped = acceptedSchedule(
        schedules.create({
          context,
          spec: {
            kind: "agent",
            prompt: "stale work",
            runAt: "2026-09-21T00:00:00.000Z",
            missedRunPolicy: "skip",
            misfireGraceSeconds: 5,
            overlapPolicy: "queue",
          },
          now: "2026-09-21T00:04:02.000Z",
        }),
      );
      const skipWorker = new ScheduleWorker({
        store,
        workerId: "schedule-d",
        now: () => new Date("2026-09-21T00:05:00.000Z"),
      });
      expect(await skipWorker.processNext()).toMatchObject({
        kind: "missed-skipped",
        scheduleId: skipped.scheduleId,
      });
      expect(schedules.list(context).find((schedule) => schedule.scheduleId === skipped.scheduleId)?.state).toBe(
        "completed",
      );
      expect(
        schedules.create({
          context: { ...context, taskId: "forged-task" },
          spec: {
            kind: "reminder",
            prompt: "forged",
            runAt: "2026-09-21T00:06:00.000Z",
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 60,
            overlapPolicy: "skip",
          },
          now: "2026-09-21T00:05:00.000Z",
        }),
      ).toEqual({ kind: "denied", reason: "task-denied" });
      const limited = new AgentTagSchedules({
        config: agentTagConfigSchema.parse({
          ...config,
          limits: { ...config.limits, maxActiveSchedules: 1 },
        }),
        store,
      });
      acceptedSchedule(
        limited.create({
          context,
          spec: {
            kind: "reminder",
            prompt: "first active schedule",
            runAt: "2026-09-22T00:00:00.000Z",
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 60,
            overlapPolicy: "skip",
          },
          now: "2026-09-21T00:05:00.000Z",
        }),
      );
      expect(
        limited.create({
          context,
          spec: {
            kind: "reminder",
            prompt: "second active schedule",
            runAt: "2026-09-22T00:00:00.000Z",
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 60,
            overlapPolicy: "skip",
          },
          now: "2026-09-21T00:05:01.000Z",
        }),
      ).toEqual({ kind: "denied", reason: "schedule-limit" });
      expect(store.listAuditRecords().map((record) => record.action)).toEqual(
        expect.arrayContaining([
          "schedule.created",
          "schedule.claimed",
          "schedule.run.settled",
          "schedule.cancelled",
          "schedule.denied",
        ]),
      );
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-scheduler-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
