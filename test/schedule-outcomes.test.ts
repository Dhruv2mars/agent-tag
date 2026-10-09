import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import {
  AgentTagSchedules,
  ScheduleOutcomeWorker,
  ScheduleWorker,
  createScheduleWorkers,
  renderAutoDisabledNotice,
  type ScheduleContext,
} from "../src/scheduler.ts";
import { AgentTagStore, type StoreFaultPoint } from "../src/store/store.ts";

const MINUTE = 60_000;
const start = Date.parse("2026-10-01T09:00:00.000Z");
const at = (offsetMs: number): string => new Date(start + offsetMs).toISOString();

function configWith(autoDisable?: { consecutiveFailures?: number; minFailureSpanSeconds?: number }): AgentTagConfig {
  return agentTagConfigSchema.parse({
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
    limits: { maxConcurrentTasks: 4, maxActiveSchedules: 20 },
    ...(autoDisable === undefined ? {} : { routines: { autoDisable } }),
  });
}

const config = configWith();

interface Harness {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly context: (threadTs?: string) => ScheduleContext;
  readonly setFault: (point: StoreFaultPoint | null) => void;
  readonly reopen: () => Promise<AgentTagStore>;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-schedule-outcomes-"));
  const path = join(directory, "agent-tag.sqlite");
  let fault: StoreFaultPoint | null = null;
  const open = () =>
    AgentTagStore.open(path, {
      faultInjector: (point) => {
        if (point === fault) throw new Error(`injected ${point}`);
      },
    });
  let store = await open();
  try {
    await run({
      get store() {
        return store;
      },
      path,
      context: (threadTs = "1000.000001") => ({
        workspaceId: "T1",
        actorUserId: "U1",
        profileId: "engineering",
        taskId: store.ensureTaskForThread({
          workspaceId: "T1",
          conversationId: "C1",
          threadTs,
          actorUserId: "U1",
          conversationType: "channel",
          profileId: "engineering",
          repositoryRoot: "/srv/repos/example",
          now: at(-MINUTE),
        }),
      }),
      setFault: (point) => {
        fault = point;
      },
      reopen: async () => {
        store.close();
        store = await open();
        return store;
      },
    });
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-schedule-outcomes-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function createRoutine(
  store: AgentTagStore,
  context: ScheduleContext,
  spec: { kind?: "agent" | "reminder"; cadenceSeconds?: number; prompt?: string },
  settings: AgentTagConfig = config,
) {
  const result = new AgentTagSchedules({ config: settings, store }).create({
    context,
    spec: {
      kind: spec.kind ?? "agent",
      prompt: spec.prompt ?? "summarize open PRs",
      runAt: at(0),
      ...(spec.cadenceSeconds === undefined ? {} : { cadenceSeconds: spec.cadenceSeconds }),
      missedRunPolicy: "run-once",
      misfireGraceSeconds: 3_600,
      overlapPolicy: "skip",
    },
    now: at(-MINUTE),
  });
  if (result.kind !== "accepted") throw new Error(`schedule fixture denied: ${result.reason}`);
  return result.schedule;
}

/** Runs the routine due at `offsetMs` through the ScheduleWorker. */
async function dispatch(store: AgentTagStore, offsetMs: number): Promise<void> {
  const worker = new ScheduleWorker({ config, store, workerId: `schedule-${offsetMs}`, now: () => new Date(at(offsetMs)) });
  const outcome = await worker.processNext();
  if (outcome.kind !== "dispatched") throw new Error(`expected a dispatch at ${offsetMs}, got ${outcome.kind}`);
}

function finishOperation(
  store: AgentTagStore,
  offsetMs: number,
  result: "succeeded" | "failed" | "user-cancelled" | "retry",
  errorCode = "T3TurnFailed",
): void {
  const now = at(offsetMs);
  const claimed = store.claimNextOperation({ workerId: "coordinator", now, leaseMs: 60_000, maxConcurrentTasks: 4 });
  if (claimed === null) throw new Error("no operation to finish");
  if (result === "succeeded") {
    store.completeOperation({ operationId: claimed.operationId, workerId: "coordinator", resultSequence: 1, now });
  } else if (result === "user-cancelled") {
    store.cancelOperationWithOutbox({
      operationId: claimed.operationId,
      taskId: claimed.taskId,
      workerId: "coordinator",
      conversationId: "C1",
      threadTs: "1000.000001",
      now,
    });
  } else {
    store.failOperation({
      operationId: claimed.operationId,
      workerId: "coordinator",
      errorCode,
      retryable: result === "retry",
      ...(result === "retry" ? { blockedUntil: at(offsetMs + 10 * MINUTE) } : {}),
      now,
    });
  }
}

function outcomeWorker(store: AgentTagStore, offsetMs: number, settings: AgentTagConfig = config) {
  return new ScheduleOutcomeWorker({ config: settings, store, workerId: "outcomes", now: () => new Date(at(offsetMs)) });
}

/** One full failing (or succeeding) run of an agent routine at `offsetMs`, then an outcome sweep. */
async function runOnce(
  store: AgentTagStore,
  offsetMs: number,
  result: "succeeded" | "failed",
  settings: AgentTagConfig = config,
) {
  await dispatch(store, offsetMs);
  finishOperation(store, offsetMs + MINUTE, result);
  return outcomeWorker(store, offsetMs + 2 * MINUTE, settings).processNext();
}

function runOutcomes(store: AgentTagStore, scheduleId: string) {
  return store
    .listAuditRecords()
    .filter((record) => record.action === "schedule.run.outcome" && record.correlationId === scheduleId)
    .map((record) => ({ dueAt: String(record.metadata.dueAt), outcome: record.result, errorCode: record.metadata.errorCode }))
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

function autoDisableNotices(store: AgentTagStore, scheduleId: string) {
  const notices = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const claimed = store.claimNextOutbox({ workerId: "slack", now: at(1_000 * MINUTE), leaseMs: 10_000 });
    if (claimed === null) break;
    store.markOutboxDelivered({ outboxId: claimed.outboxId, workerId: "slack", slackMessageTs: `${attempt}.0`, now: at(1_000 * MINUTE) });
    if (claimed.clientMessageId === `${scheduleId}:auto-disabled`) notices.push(claimed);
  }
  return notices;
}

function disableAudits(store: AgentTagStore, scheduleId: string) {
  return store
    .listAuditRecords()
    .filter((record) => record.action === "schedule.auto-disabled" && record.correlationId === scheduleId);
}

/** Auto-disable notices ever enqueued for a schedule (read from the audit log, without draining the outbox). */
function noticeEnqueues(store: AgentTagStore, scheduleId: string) {
  return store
    .listAuditRecords()
    .filter(
      (record) =>
        record.action === "slack.outbox.enqueued" && record.metadata.clientMessageId === `${scheduleId}:auto-disabled`,
    );
}

describe("schedule run outcomes", () => {
  test("maps operation and reminder outcomes; retry-pending runs stay unsettled", async () => {
    await withHarness(async ({ store, context }) => {
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_800 });
      const sweep = (offsetMs: number) => outcomeWorker(store, offsetMs).processNext();

      await dispatch(store, 0);
      finishOperation(store, MINUTE, "succeeded");
      await dispatch(store, 30 * MINUTE);
      finishOperation(store, 31 * MINUTE, "failed", "T3TurnStalled");
      await dispatch(store, 60 * MINUTE);
      finishOperation(store, 61 * MINUTE, "user-cancelled");
      expect(await sweep(62 * MINUTE)).toEqual({ kind: "outcomes-recorded", recorded: 3, autoDisabled: [] });

      await dispatch(store, 90 * MINUTE);
      finishOperation(store, 91 * MINUTE, "retry");
      expect(await sweep(92 * MINUTE)).toEqual({ kind: "idle" });

      expect(runOutcomes(store, routine.scheduleId)).toEqual([
        { dueAt: at(0), outcome: "succeeded", errorCode: null },
        { dueAt: at(30 * MINUTE), outcome: "failed", errorCode: "T3TurnStalled" },
        // A user stopping the turn is neutral: it neither breaks nor extends the streak.
        { dueAt: at(60 * MINUTE), outcome: "cancelled", errorCode: "user-cancelled" },
      ]);
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "active",
        consecutiveFailures: 1,
        failureStreakStartedAt: at(30 * MINUTE),
      });

      // Reminder runs have no operation: their outcome is the reminder message's delivery.
      const delivered = createRoutine(store, context("2000.000001"), { kind: "reminder", prompt: "stand up" });
      const failed = createRoutine(store, context("3000.000001"), { kind: "reminder", prompt: "deploy" });
      expect(await new ScheduleWorker({ config, store, now: () => new Date(at(0)) }).processNext()).toMatchObject({
        kind: "dispatched",
      });
      expect(await new ScheduleWorker({ config, store, now: () => new Date(at(0)) }).processNext()).toMatchObject({
        kind: "dispatched",
      });
      expect(await sweep(MINUTE)).toEqual({ kind: "idle" });
      for (let index = 0; index < 4; index += 1) {
        const claimed = store.claimNextOutbox({ workerId: "slack", now: at(2 * MINUTE), leaseMs: 10_000 });
        if (claimed === null) break;
        if (claimed.clientMessageId === `${failed.scheduleId}:${at(0)}:reminder`) {
          store.failOutbox({ outboxId: claimed.outboxId, workerId: "slack", errorCode: "channel_not_found", now: at(2 * MINUTE) });
        } else {
          store.markOutboxDelivered({ outboxId: claimed.outboxId, workerId: "slack", slackMessageTs: `${index}.1`, now: at(2 * MINUTE) });
        }
      }
      expect(await sweep(3 * MINUTE)).toMatchObject({ kind: "outcomes-recorded", recorded: 2 });
      expect(runOutcomes(store, delivered.scheduleId)).toEqual([{ dueAt: at(0), outcome: "succeeded", errorCode: null }]);
      expect(runOutcomes(store, failed.scheduleId)).toEqual([
        { dueAt: at(0), outcome: "failed", errorCode: "channel_not_found" },
      ]);
    });
  });

  test("disables a recurring routine after 3 failures spanning at least an hour, once", async () => {
    await withHarness(async ({ store, context }) => {
      // Due at t=0, t+30.5m and t+61m.
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_830 });
      expect(await runOnce(store, 0, "failed")).toMatchObject({ kind: "outcomes-recorded" });
      expect(await runOnce(store, 30.5 * MINUTE, "failed")).toMatchObject({ kind: "outcomes-recorded" });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", consecutiveFailures: 2 });
      expect(await runOnce(store, 61 * MINUTE, "failed")).toEqual({
        kind: "auto-disabled",
        recorded: 1,
        autoDisabled: [routine.scheduleId],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "cancelled",
        endedReason: "auto-disabled",
        endedAt: at(63 * MINUTE),
        consecutiveFailures: 3,
        failureStreakStartedAt: at(0),
      });

      // Re-running the sweep is a no-op, and the disabled routine never fires again.
      expect(await outcomeWorker(store, 64 * MINUTE).processNext()).toEqual({ kind: "idle" });
      expect(
        await new ScheduleWorker({ config, store, now: () => new Date(at(600 * MINUTE)) }).processNext(),
      ).toEqual({ kind: "idle" });

      const disabledAudits = store.listAuditRecords().filter((record) => record.action === "schedule.auto-disabled");
      expect(disabledAudits).toHaveLength(1);
      expect(disabledAudits[0]).toMatchObject({
        correlationId: routine.scheduleId,
        result: "cancelled",
        metadata: { kind: "agent", consecutiveFailures: 3, streakStartedAt: at(0), lastErrorCode: "T3TurnFailed" },
      });
      const notices = autoDisableNotices(store, routine.scheduleId);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.threadTs).toBe("1000.000001");
      expect(notices[0]?.payload.text).toContain("<@U1> I turned off routine");
      expect(notices[0]?.payload.text).toContain("after 3 failed runs in a row");
      expect(notices[0]?.payload.text).toContain("`T3TurnFailed`");
      expect(store.diagnostics().schedulesAutoDisabled).toBe(1);
      const listed = (since?: string) =>
        store
          .listActiveSchedulesForConversation({
            workspaceId: "T1",
            conversationId: "C1",
            ...(since === undefined ? {} : { autoDisabledSince: since }),
          })
          .map((row) => row.scheduleId);
      expect(listed()).toEqual([]);
      expect(listed(at(0))).toEqual([routine.scheduleId]);
      expect(listed(at(64 * MINUTE))).toEqual([]);
      // Audit metadata never carries the routine prompt.
      expect(JSON.stringify(store.listAuditRecords())).not.toContain("summarize open PRs");
    });
  });

  test("three failures within 59 minutes do not disable; a success resets the streak", async () => {
    await withHarness(async ({ store, context }) => {
      // Due at t=0, t+29.5m, t+59m, t+88.5m, ...
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_770 });
      const step = 29.5 * MINUTE;
      await runOnce(store, 0, "failed");
      await runOnce(store, step, "failed");
      expect(await runOnce(store, 2 * step, "failed")).toMatchObject({ kind: "outcomes-recorded", autoDisabled: [] });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", consecutiveFailures: 3 });

      expect(await runOnce(store, 3 * step, "succeeded")).toMatchObject({ kind: "outcomes-recorded" });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "active",
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
      });

      // A new streak starts from scratch: two more failures (span 29.5m) are not enough.
      await runOnce(store, 4 * step, "failed");
      await runOnce(store, 5 * step, "failed");
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "active",
        consecutiveFailures: 2,
        failureStreakStartedAt: at(4 * step),
      });
      // The 3rd failure of the new streak spans 59 minutes: still active. The 4th (88.5m) disables.
      expect(await runOnce(store, 6 * step, "failed")).toMatchObject({ autoDisabled: [] });
      expect(await runOnce(store, 7 * step, "failed")).toMatchObject({ autoDisabled: [routine.scheduleId] });
      expect(store.getSchedule(routine.scheduleId)?.endedReason).toBe("auto-disabled");
    });
  });

  test("honours configured thresholds and never disables one-shot routines", async () => {
    await withHarness(async ({ store, context }) => {
      const strict = configWith({ consecutiveFailures: 2, minFailureSpanSeconds: 0 });
      const oneShot = createRoutine(store, context("2000.000001"), {}, strict);
      await dispatch(store, 0);
      finishOperation(store, MINUTE, "failed");
      expect(await outcomeWorker(store, 2 * MINUTE, strict).processNext()).toMatchObject({ autoDisabled: [] });
      expect(store.getSchedule(oneShot.scheduleId)).toMatchObject({ state: "completed", endedReason: "completed" });

      const recurring = createRoutine(store, context(), { cadenceSeconds: 300 }, strict);
      await runOnce(store, 10 * MINUTE, "failed", strict);
      expect(store.getSchedule(recurring.scheduleId)?.state).toBe("active");
      expect(await runOnce(store, 15 * MINUTE, "failed", strict)).toMatchObject({
        autoDisabled: [recurring.scheduleId],
      });
    });
  });

  test("defers disabling a leased schedule to a later sweep", async () => {
    await withHarness(async ({ store, context }) => {
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_830 });
      await runOnce(store, 0, "failed");
      await runOnce(store, 30.5 * MINUTE, "failed");
      await dispatch(store, 61 * MINUTE);
      finishOperation(store, 62 * MINUTE, "failed");
      // A ScheduleWorker holds the lease for the next due run while the third outcome is recorded.
      const claimed = store.claimDueSchedule({ workerId: "busy", now: at(91.5 * MINUTE), leaseMs: 60_000 });
      expect(claimed?.scheduleId).toBe(routine.scheduleId);
      expect(await outcomeWorker(store, 91.5 * MINUTE).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 1,
        autoDisabled: [],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", consecutiveFailures: 3 });
      // Once the lease is gone (expired here), the next sweep disables it with no new run.
      expect(await outcomeWorker(store, 93 * MINUTE).processNext()).toEqual({
        kind: "auto-disabled",
        recorded: 0,
        autoDisabled: [routine.scheduleId],
      });
      expect(autoDisableNotices(store, routine.scheduleId)).toHaveLength(1);
    });
  });

  test("a success at the end of a backlog larger than one sweep keeps the routine enabled", async () => {
    await withHarness(async ({ store, context }) => {
      // A delayed outcome worker finds 50 failed runs followed by a successful one (51 > batch of 50).
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_800 });
      const step = 30 * MINUTE;
      for (let index = 0; index < 50; index += 1) {
        await dispatch(store, index * step);
        finishOperation(store, index * step + MINUTE, "failed");
      }
      await dispatch(store, 50 * step);
      finishOperation(store, 50 * step + MINUTE, "succeeded");

      const sweepAt = 50 * step + 2 * MINUTE;
      // The first sweep sees only the failures; the success is still awaiting reconciliation.
      expect(await outcomeWorker(store, sweepAt).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 50,
        autoDisabled: [],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", endedReason: null });
      expect(await outcomeWorker(store, sweepAt + MINUTE).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 1,
        autoDisabled: [],
      });
      expect(await outcomeWorker(store, sweepAt + 2 * MINUTE).processNext()).toEqual({ kind: "idle" });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "active",
        endedReason: null,
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
      });
      expect(disableAudits(store, routine.scheduleId)).toHaveLength(0);
      expect(noticeEnqueues(store, routine.scheduleId)).toHaveLength(0);
    });
  });

  test("an all-failure backlog larger than one sweep disables once, after it is fully reconciled", async () => {
    await withHarness(async ({ store, context }) => {
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_800 });
      const step = 30 * MINUTE;
      for (let index = 0; index < 52; index += 1) {
        await dispatch(store, index * step);
        finishOperation(store, index * step + MINUTE, "failed");
      }
      const sweepAt = 52 * step;
      // 50 of 52 finished runs reconciled: the streak is not final yet, so no decision is made.
      expect(await outcomeWorker(store, sweepAt).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 50,
        autoDisabled: [],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", endedReason: null });
      expect(disableAudits(store, routine.scheduleId)).toHaveLength(0);

      expect(await outcomeWorker(store, sweepAt + MINUTE).processNext()).toEqual({
        kind: "auto-disabled",
        recorded: 2,
        autoDisabled: [routine.scheduleId],
      });
      expect(await outcomeWorker(store, sweepAt + 2 * MINUTE).processNext()).toEqual({ kind: "idle" });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "cancelled",
        endedReason: "auto-disabled",
        endedAt: at(sweepAt + MINUTE),
        consecutiveFailures: 52,
        failureStreakStartedAt: at(0),
      });
      const audits = disableAudits(store, routine.scheduleId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toMatchObject({ consecutiveFailures: 52, streakStartedAt: at(0) });
      expect(noticeEnqueues(store, routine.scheduleId)).toHaveLength(1);
    });
  });

  test("a newer run still in flight defers the decision, and its success prevents the disable", async () => {
    await withHarness(async ({ store, context }) => {
      const routine = createRoutine(store, context(), { cadenceSeconds: 1_830 });
      for (const offset of [0, 30.5, 61]) {
        await dispatch(store, offset * MINUTE);
        finishOperation(store, (offset + 1) * MINUTE, "failed");
      }
      // The next run is dispatched before the outcome worker gets to the third failure.
      await dispatch(store, 91.5 * MINUTE);
      expect(await outcomeWorker(store, 92 * MINUTE).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 3,
        autoDisabled: [],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({ state: "active", consecutiveFailures: 3 });
      finishOperation(store, 93 * MINUTE, "succeeded");
      expect(await outcomeWorker(store, 94 * MINUTE).processNext()).toEqual({
        kind: "outcomes-recorded",
        recorded: 1,
        autoDisabled: [],
      });
      expect(store.getSchedule(routine.scheduleId)).toMatchObject({
        state: "active",
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
      });
      expect(disableAudits(store, routine.scheduleId)).toHaveLength(0);
      expect(noticeEnqueues(store, routine.scheduleId)).toHaveLength(0);
    });
  });

  test("records each outcome once across a crashed sweep, a restart and a crashed dispatch", async () => {
    await withHarness(async (harness) => {
      const routine = createRoutine(harness.store, harness.context(), { cadenceSeconds: 1_830 });

      // The scheduler crashes after ingesting the run but before settling it.
      const crashed = harness.store.claimDueSchedule({ workerId: "crashed", now: at(0), leaseMs: 30_000 });
      expect(crashed?.dueAt).toBe(at(0));
      const firstIngest = harness.store.ingestSlackEvent({
        deliveryId: `schedule:${routine.scheduleId}:${at(0)}`,
        eventKey: `schedule:${routine.scheduleId}:${at(0)}`,
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/example",
        text: routine.prompt,
        receivedAt: at(0),
      });
      let store = await harness.reopen();
      // After the lease expires the run is re-dispatched to the same operation and settled once.
      expect(
        await new ScheduleWorker({ config, store, workerId: "recovered", now: () => new Date(at(MINUTE)) }).processNext(),
      ).toMatchObject({ kind: "dispatched", dueAt: at(0) });
      expect(store.diagnostics()).toMatchObject({ operations: 1, scheduleRuns: 1 });
      finishOperation(store, 2 * MINUTE, "failed");
      expect(store.listAuditRecords().some((record) => record.target === firstIngest.operationId)).toBe(true);

      // The outcome sweep crashes after recording the run: the whole sweep rolls back.
      harness.setFault("schedule-outcome.after-record");
      expect(() => outcomeWorker(store, 3 * MINUTE).processNext()).toThrow("injected schedule-outcome.after-record");
      expect(runOutcomes(store, routine.scheduleId)).toEqual([]);
      expect(store.getSchedule(routine.scheduleId)?.consecutiveFailures).toBe(0);

      harness.setFault(null);
      store = await harness.reopen();
      expect(await outcomeWorker(store, 4 * MINUTE).processNext()).toMatchObject({ recorded: 1 });
      expect(await outcomeWorker(store, 5 * MINUTE).processNext()).toEqual({ kind: "idle" });
      store = await harness.reopen();
      expect(await outcomeWorker(store, 6 * MINUTE).processNext()).toEqual({ kind: "idle" });
      expect(runOutcomes(store, routine.scheduleId)).toEqual([
        { dueAt: at(0), outcome: "failed", errorCode: "T3TurnFailed" },
      ]);
      expect(store.getSchedule(routine.scheduleId)?.consecutiveFailures).toBe(1);
    });
  });

  test("the service runs an outcome worker beside the schedule worker", async () => {
    await withHarness(async ({ store }) => {
      const workers = createScheduleWorkers({ config, store });
      expect(workers.map((worker) => worker.constructor)).toEqual([ScheduleWorker, ScheduleOutcomeWorker]);
      for (const worker of workers) expect(await worker.processNext()).toEqual({ kind: "idle" });
    });
  });

  test("renders the auto-disable notice without injectable mentions", () => {
    const notice = renderAutoDisabledNotice({
      scheduleId: "a1b2c3d4-0000-4000-8000-000000000000",
      kind: "agent",
      prompt: "ping <!channel> and *bold*\nthen `x`",
      actorUserId: "U1",
      consecutiveFailures: 3,
      streakStartedAt: "2026-10-01T09:00:00.000Z",
      lastErrorCode: null,
    });
    expect(notice.text).toStartWith(":pause_button: <@U1> I turned off routine `a1b2c3`");
    expect(notice.text).not.toContain("<!channel>");
    expect(notice.text).not.toContain("Last error");
    expect(notice.text).toContain("<!date^1790845200^{date_short_pretty} at {time}|2026-10-01T09:00:00.000Z>");
  });
});
