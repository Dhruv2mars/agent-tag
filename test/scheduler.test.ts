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
  test("operations queued before origin/messageTs existed get them derived from the event key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-scheduler-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    try {
      const legacy = {
        workspaceId: "T1",
        conversationId: "C1",
        actorUserId: "U1",
        conversationType: "channel" as const,
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        receivedAt: createdAt,
      };
      store.ingestSlackEvent({ ...legacy, deliveryId: "Ev1", eventKey: "C1:1000.000001", threadTs: "1000.000001", text: "slack" });
      store.ingestSlackEvent({
        ...legacy,
        deliveryId: "schedule:s1:2026-09-21T00:00:00.000Z",
        eventKey: "schedule:s1:2026-09-21T00:00:00.000Z",
        threadTs: "2000.000001",
        text: "routine",
      });
      store.ingestSlackEvent({ ...legacy, deliveryId: "x1", eventKey: "mystery-key", threadTs: "3000.000001", text: "unknown" });
      const claim = () => store.claimNextOperation({ workerId: "w", now: createdAt, leaseMs: 10_000, maxConcurrentTasks: 3 });
      const payloads = new Map([claim(), claim(), claim()].map((operation) => [operation?.payload.text, operation?.payload]));
      expect(payloads.get("slack")).toMatchObject({ origin: "slack", messageTs: "1000.000001" });
      expect(payloads.get("routine")).toMatchObject({ origin: "schedule" });
      expect(payloads.get("unknown")).toMatchObject({ origin: "schedule" });
      expect(payloads.get("routine")?.messageTs).toBeUndefined();
      expect(payloads.get("unknown")?.messageTs).toBeUndefined();
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-scheduler-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("scheduled agent runs are marked with the schedule origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-scheduler-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "initial task",
        receivedAt: createdAt,
        messageTs: "1000.000001",
        origin: "slack",
      });
      const initial = store.claimNextOperation({ workerId: "w", now: createdAt, leaseMs: 10_000, maxConcurrentTasks: 1 });
      if (initial === null) throw new Error("initial operation was not claimable");
      expect(initial.payload).toMatchObject({ origin: "slack", messageTs: "1000.000001" });
      store.completeOperation({ operationId: initial.operationId, workerId: "w", resultSequence: 1, now: createdAt });
      const schedules = new AgentTagSchedules({ config, store });
      acceptedSchedule(
        schedules.create({
          context: { workspaceId: "T1", actorUserId: "U1", profileId: "engineering", taskId: receipt.taskId },
          spec: {
            kind: "agent",
            prompt: "run the scheduled check",
            runAt: "2026-09-21T00:01:00.000Z",
            missedRunPolicy: "run-once",
            misfireGraceSeconds: 60,
            overlapPolicy: "skip",
          },
          now: createdAt,
        }),
      );
      const due = "2026-09-21T00:01:00.000Z";
      const worker = new ScheduleWorker({ config, store, workerId: "schedule-a", now: () => new Date(due) });
      expect(await worker.processNext()).toMatchObject({ kind: "dispatched" });
      const scheduled = store.claimNextOperation({ workerId: "w", now: due, leaseMs: 10_000, maxConcurrentTasks: 1 });
      expect(scheduled?.payload).toMatchObject({ text: "run the scheduled check", actorUserId: "U1", origin: "schedule" });
      expect(scheduled?.payload.messageTs).toBeUndefined();
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-scheduler-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

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
        conversationType: "channel",
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

      const afterRestart = new ScheduleWorker({ config,
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

      const overlapping = new ScheduleWorker({ config,
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
      const reminderWorker = new ScheduleWorker({ config,
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
      const skipWorker = new ScheduleWorker({ config,
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

  test("persists calendar recurrences and computes DST-correct next runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-scheduler-"));
    const path = join(directory, "agent-tag.sqlite");
    let store = await AgentTagStore.open(path);
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-r1",
        eventKey: "C1:2000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "2000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: "routine task",
        receivedAt: "2026-10-30T12:00:00.000Z",
      });
      const context: ScheduleContext = {
        workspaceId: "T1",
        actorUserId: "U1",
        profileId: "engineering",
        taskId: receipt.taskId,
      };
      const recurrence = { kind: "cron", expression: "0 9 * * *", timeZone: "America/New_York" } as const;
      const base = {
        kind: "reminder",
        prompt: "daily standup",
        runAt: "2026-10-31T13:00:00.000Z",
        missedRunPolicy: "skip",
        misfireGraceSeconds: 300,
        overlapPolicy: "skip",
      } as const;
      expect(
        new AgentTagSchedules({ config, store }).create({
          context,
          spec: { ...base, recurrence, cadenceSeconds: 86_400 },
          now: "2026-10-30T12:00:00.000Z",
        }),
      ).toEqual({ kind: "denied", reason: "invalid-schedule" });
      const created = acceptedSchedule(
        new AgentTagSchedules({ config, store }).create({
          context,
          spec: { ...base, recurrence },
          now: "2026-10-30T12:00:00.000Z",
        }),
      );
      expect(created).toMatchObject({ recurrence, cadenceSeconds: null });
      store.close();
      store = await AgentTagStore.open(path);
      const schedules = new AgentTagSchedules({ config, store });
      expect(schedules.list(context)[0]).toMatchObject({ recurrence, nextRunAt: "2026-10-31T13:00:00.000Z" });

      // 09:00 EDT on Oct 31 -> 09:00 EST on Nov 1 (23 hours later, across fall-back).
      const worker = new ScheduleWorker({ config, store, workerId: "routine-a", now: () => new Date("2026-10-31T13:00:00.000Z") });
      expect(await worker.processNext()).toMatchObject({ kind: "dispatched", scheduleId: created.scheduleId });
      expect(schedules.list(context)[0]).toMatchObject({ state: "active", nextRunAt: "2026-11-01T14:00:00.000Z" });

      // A late worker skips the stale run and jumps to the next future 09:00 local.
      const late = new ScheduleWorker({ config, store, workerId: "routine-b", now: () => new Date("2026-11-03T15:00:00.000Z") });
      expect(await late.processNext()).toMatchObject({ kind: "missed-skipped", dueAt: "2026-11-01T14:00:00.000Z" });
      expect(schedules.list(context)[0]).toMatchObject({ state: "active", nextRunAt: "2026-11-04T14:00:00.000Z" });
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-scheduler-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });

  test("tracks end reasons, settles across a concurrent cancel, and dedupes Slack-sourced creates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-scheduler-"));
    const path = join(directory, "agent-tag.sqlite");
    const store = await AgentTagStore.open(path);
    try {
      const thread = {
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "3000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        now: createdAt,
      } as const;
      const taskId = store.ensureTaskForThread(thread);
      expect(store.ensureTaskForThread({ ...thread, now: "2026-09-21T00:00:05.000Z" })).toBe(taskId);
      expect(store.diagnostics()).toMatchObject({ tasks: 1, operations: 0 });
      const otherTaskId = store.ensureTaskForThread({ ...thread, threadTs: "3000.000002" });
      expect(otherTaskId).not.toBe(taskId);

      const context: ScheduleContext = { workspaceId: "T1", actorUserId: "U1", profileId: "engineering", taskId };
      const schedules = new AgentTagSchedules({ config, store });
      const spec = {
        kind: "reminder",
        prompt: "check the deploy",
        runAt: "2026-09-21T00:01:00.000Z",
        cadenceSeconds: 60,
        missedRunPolicy: "run-once",
        misfireGraceSeconds: 30,
        overlapPolicy: "skip",
      } as const;
      const source = { eventKey: "C1:3000.000009", timeZone: "Asia/Kolkata", humanReadable: "every minute", notifyUserId: "U1" };
      const sourced = acceptedSchedule(schedules.create({ context, spec, source, now: createdAt }));
      expect(sourced).toMatchObject({
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "3000.000001",
        timeZone: "Asia/Kolkata",
        humanReadable: "every minute",
        notifyUserId: "U1",
        consecutiveFailures: 0,
        endedReason: null,
      });
      // A redelivered Slack request returns the same schedule instead of creating a second one.
      expect(schedules.create({ context, spec, source, now: "2026-09-21T00:00:02.000Z" })).toEqual({
        kind: "accepted",
        schedule: sourced,
      });
      expect(
        schedules.create({
          context: { ...context, taskId: otherTaskId },
          spec,
          source,
          now: "2026-09-21T00:00:03.000Z",
        }),
      ).toEqual({ kind: "denied", reason: "schedule-denied" });
      expect(store.findScheduleBySourceEvent({ workspaceId: "T1", sourceEventKey: source.eventKey })?.scheduleId).toBe(
        sourced.scheduleId,
      );
      expect(store.listSchedules(taskId)).toHaveLength(1);
      expect(
        store.listAuditRecords().filter((record) => record.action === "schedule.created").map((record) => record.metadata.source),
      ).toEqual(["slack"]);

      // The user cancels while a worker holds the run's lease: settling records the run and keeps the cancel.
      const claimed = store.claimDueSchedule({ workerId: "worker-a", now: "2026-09-21T00:01:00.000Z", leaseMs: 30_000 });
      expect(claimed?.scheduleId).toBe(sourced.scheduleId);
      expect(schedules.cancel({ context, scheduleId: sourced.scheduleId, now: "2026-09-21T00:01:01.000Z" })).toEqual({
        kind: "accepted",
      });
      expect(() =>
        store.settleScheduleRun({
          scheduleId: sourced.scheduleId,
          workerId: "worker-a",
          dueAt: "2026-09-21T00:01:00.000Z",
          disposition: "dispatched",
          nextRunAt: "2026-09-21T00:02:00.000Z",
          now: "2026-09-21T00:01:02.000Z",
        }),
      ).not.toThrow();
      expect(store.diagnostics().scheduleRuns).toBe(1);
      expect(store.getSchedule(sourced.scheduleId)).toMatchObject({
        state: "cancelled",
        endedReason: "user-cancelled",
        endedAt: "2026-09-21T00:01:01.000Z",
        nextRunAt: "2026-09-21T00:01:00.000Z",
      });
      expect(
        store.listAuditRecords().find((record) => record.action === "schedule.run.settled")?.metadata.cancelledDuringRun,
      ).toBe(true);
      const once = acceptedSchedule(
        schedules.create({ context, spec: { ...spec, cadenceSeconds: undefined, runAt: "2026-09-21T00:05:00.000Z" }, now: createdAt }),
      );
      const revoked = acceptedSchedule(
        schedules.create({ context, spec: { ...spec, runAt: "2026-09-21T00:06:00.000Z" }, now: createdAt }),
      );
      const kept = acceptedSchedule(
        schedules.create({ context, spec: { ...spec, runAt: "2026-09-21T01:00:00.000Z" }, now: createdAt }),
      );
      const worker = (now: string) => new ScheduleWorker({ config, store, workerId: "worker-c", now: () => new Date(now) });
      expect(await worker("2026-09-21T00:05:00.000Z").processNext()).toMatchObject({ scheduleId: once.scheduleId });
      expect(store.getSchedule(once.scheduleId)).toMatchObject({ state: "completed", endedReason: "completed" });
      const revokedClaim = store.claimDueSchedule({ workerId: "worker-d", now: "2026-09-21T00:06:00.000Z", leaseMs: 30_000 });
      expect(revokedClaim?.scheduleId).toBe(revoked.scheduleId);
      store.revokeClaimedSchedule({ scheduleId: revoked.scheduleId, workerId: "worker-d", now: "2026-09-21T00:06:01.000Z" });
      expect(store.getSchedule(revoked.scheduleId)).toMatchObject({
        state: "cancelled",
        endedReason: "authority-revoked",
        endedAt: "2026-09-21T00:06:01.000Z",
      });

      // Any other settle without the lease on a live schedule still fails closed.
      expect(() =>
        store.settleScheduleRun({
          scheduleId: kept.scheduleId,
          workerId: "worker-x",
          dueAt: "2026-09-21T01:00:00.000Z",
          disposition: "dispatched",
          now: "2026-09-21T00:07:00.000Z",
        }),
      ).toThrow();

      expect(
        store.listActiveSchedulesForConversation({ workspaceId: "T1", conversationId: "C1" }).map((row) => row.scheduleId),
      ).toEqual([kept.scheduleId]);
      expect(store.listActiveSchedulesForConversation({ workspaceId: "T1", conversationId: "C2" })).toEqual([]);
      expect(() => store.listActiveSchedulesForConversation({ workspaceId: "T1", conversationId: "C1", limit: 0 })).toThrow();
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-scheduler-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
