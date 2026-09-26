import { z } from "zod";

import type { AgentTagConfig } from "./config.ts";
import type { AgentTagStore, ClaimedSchedule, ScheduleSummary } from "./store/store.ts";

export interface ScheduleContext {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly taskId: string;
}

const scheduleSpecSchema = z.object({
  kind: z.enum(["agent", "reminder"]),
  prompt: z.string().trim().min(1).max(4_000),
  runAt: z.iso.datetime(),
  cadenceSeconds: z.number().int().min(60).max(31_536_000).optional(),
  missedRunPolicy: z.enum(["run-once", "skip"]),
  misfireGraceSeconds: z.number().int().min(0).max(86_400),
  overlapPolicy: z.enum(["skip", "queue"]),
});

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export type ScheduleMutationResult =
  | { readonly kind: "accepted"; readonly schedule: ScheduleSummary }
  | { readonly kind: "denied"; readonly reason: string };

export class AgentTagSchedules {
  readonly #config: AgentTagConfig;
  readonly #store: AgentTagStore;

  constructor(input: { readonly config: AgentTagConfig; readonly store: AgentTagStore }) {
    this.#config = input.config;
    this.#store = input.store;
  }

  create(input: {
    readonly context: ScheduleContext;
    readonly spec: unknown;
    readonly now: string;
  }): ScheduleMutationResult {
    const denial = this.#denial(input.context);
    if (denial !== null) return this.#deny(input.context, input.context.taskId, denial, input.now);
    const parsed = scheduleSpecSchema.safeParse(input.spec);
    if (!parsed.success) {
      return this.#deny(input.context, input.context.taskId, "invalid-schedule", input.now);
    }
    if (this.#store.countActiveSchedules(input.context.workspaceId) >= this.#config.limits.maxActiveSchedules) {
      return this.#deny(input.context, input.context.taskId, "schedule-limit", input.now);
    }
    return {
      kind: "accepted",
      schedule: this.#store.createSchedule({
        taskId: input.context.taskId,
        actorUserId: input.context.actorUserId,
        kind: parsed.data.kind,
        prompt: parsed.data.prompt,
        runAt: parsed.data.runAt,
        ...(parsed.data.cadenceSeconds === undefined
          ? {}
          : { cadenceSeconds: parsed.data.cadenceSeconds }),
        missedRunPolicy: parsed.data.missedRunPolicy,
        misfireGraceSeconds: parsed.data.misfireGraceSeconds,
        overlapPolicy: parsed.data.overlapPolicy,
        now: input.now,
      }),
    };
  }

  list(context: ScheduleContext): ReadonlyArray<ScheduleSummary> {
    return this.#denial(context) === null ? this.#store.listSchedules(context.taskId) : [];
  }

  cancel(input: {
    readonly context: ScheduleContext;
    readonly scheduleId: string;
    readonly now: string;
  }): { readonly kind: "accepted" | "denied" } {
    const denial = this.#denial(input.context);
    if (denial !== null) {
      this.#deny(input.context, input.scheduleId, denial, input.now);
      return { kind: "denied" };
    }
    const belongs = this.#store
      .listSchedules(input.context.taskId)
      .some((schedule) => schedule.scheduleId === input.scheduleId);
    if (!belongs) {
      this.#deny(input.context, input.scheduleId, "schedule-denied", input.now);
      return { kind: "denied" };
    }
    return this.#store.cancelSchedule({
      scheduleId: input.scheduleId,
      taskId: input.context.taskId,
      actorUserId: input.context.actorUserId,
      now: input.now,
    })
      ? { kind: "accepted" }
      : { kind: "denied" };
  }

  #denial(context: ScheduleContext): string | null {
    if (context.workspaceId !== this.#config.slack.workspaceId) return "workspace-denied";
    if (!this.#config.access.allowedUserIds.includes(context.actorUserId)) return "user-denied";
    if (!this.#config.profiles.some((profile) => profile.id === context.profileId)) return "profile-denied";
    if (
      !this.#store.taskBelongsToContext({
        taskId: context.taskId,
        workspaceId: context.workspaceId,
        profileId: context.profileId,
        actorUserId: context.actorUserId,
      })
    ) {
      return "task-denied";
    }
    return null;
  }

  #deny(
    context: ScheduleContext,
    sourceId: string,
    reason: string,
    now: string,
  ): { readonly kind: "denied"; readonly reason: string } {
    this.#store.recordScheduleDenial({
      actorUserId: context.actorUserId,
      sourceId,
      reason,
      workspaceId: context.workspaceId,
      now,
    });
    return { kind: "denied", reason };
  }
}

export type ScheduleWorkerOutcome =
  | { readonly kind: "idle" }
  | {
      readonly kind: "dispatched" | "missed-skipped" | "overlap-skipped";
      readonly scheduleId: string;
      readonly dueAt: string;
    };

function nextRunAt(schedule: ClaimedSchedule, now: Date): string | undefined {
  if (schedule.cadenceSeconds === null) return undefined;
  const dueMs = new Date(schedule.dueAt).getTime();
  const intervalMs = schedule.cadenceSeconds * 1_000;
  const elapsed = Math.max(0, now.getTime() - dueMs);
  const intervals = Math.floor(elapsed / intervalMs) + 1;
  return new Date(dueMs + intervals * intervalMs).toISOString();
}

function slackOrderKey(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1_000);
  const microseconds = ((date.getTime() % 1_000) * 1_000).toString().padStart(6, "0");
  return `${seconds}.${microseconds}`;
}

export class ScheduleWorker {
  readonly #store: AgentTagStore;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #now: () => Date;

  constructor(input: {
    readonly store: AgentTagStore;
    readonly workerId?: string;
    readonly leaseMs?: number;
    readonly now?: () => Date;
  }) {
    this.#store = input.store;
    this.#workerId = input.workerId ?? `schedule-worker-${crypto.randomUUID()}`;
    this.#leaseMs = input.leaseMs ?? 30_000;
    this.#now = input.now ?? (() => new Date());
  }

  async processNext(): Promise<ScheduleWorkerOutcome> {
    const current = this.#now();
    const schedule = this.#store.claimDueSchedule({
      workerId: this.#workerId,
      now: current.toISOString(),
      leaseMs: this.#leaseMs,
    });
    if (schedule === null) return { kind: "idle" };
    const next = nextRunAt(schedule, current);
    const misfired =
      current.getTime() >
      new Date(schedule.dueAt).getTime() + schedule.misfireGraceSeconds * 1_000;
    if (misfired && schedule.missedRunPolicy === "skip") {
      this.#settle(schedule, "missed-skipped", current, next);
      return { kind: "missed-skipped", scheduleId: schedule.scheduleId, dueAt: schedule.dueAt };
    }
    if (schedule.overlapPolicy === "skip" && this.#store.hasOpenScheduleOperation(schedule.scheduleId)) {
      this.#settle(schedule, "overlap-skipped", current, next);
      return { kind: "overlap-skipped", scheduleId: schedule.scheduleId, dueAt: schedule.dueAt };
    }

    let operationId: string | undefined;
    if (schedule.kind === "reminder") {
      this.#store.enqueueOutbox({
        taskId: schedule.taskId,
        correlationId: schedule.scheduleId,
        conversationId: schedule.conversationId,
        threadTs: schedule.threadTs,
        clientMessageId: `${schedule.scheduleId}:${schedule.dueAt}:reminder`,
        payload: { text: `Reminder: ${schedule.prompt}` },
        createdAt: current.toISOString(),
      });
    } else {
      const task = this.#store.getTaskExecution(schedule.taskId);
      const receipt = this.#store.ingestSlackEvent({
        deliveryId: `schedule:${schedule.scheduleId}:${schedule.dueAt}`,
        eventKey: `schedule:${schedule.scheduleId}:${schedule.dueAt}`,
        workspaceId: schedule.workspaceId,
        conversationId: schedule.conversationId,
        threadTs: schedule.threadTs,
        actorUserId: schedule.actorUserId,
        conversationType: task.conversationType,
        profileId: schedule.profileId,
        repositoryRoot: schedule.repositoryRoot,
        text: schedule.prompt,
        receivedAt: current.toISOString(),
        sourceOrderKey: slackOrderKey(new Date(schedule.dueAt)),
      });
      operationId = receipt.operationId;
    }
    this.#store.settleScheduleRun({
      scheduleId: schedule.scheduleId,
      workerId: this.#workerId,
      dueAt: schedule.dueAt,
      disposition: "dispatched",
      ...(operationId === undefined ? {} : { operationId }),
      ...(next === undefined ? {} : { nextRunAt: next }),
      now: current.toISOString(),
    });
    return { kind: "dispatched", scheduleId: schedule.scheduleId, dueAt: schedule.dueAt };
  }

  #settle(
    schedule: ClaimedSchedule,
    disposition: "missed-skipped" | "overlap-skipped",
    now: Date,
    next: string | undefined,
  ): void {
    this.#store.settleScheduleRun({
      scheduleId: schedule.scheduleId,
      workerId: this.#workerId,
      dueAt: schedule.dueAt,
      disposition,
      ...(next === undefined ? {} : { nextRunAt: next }),
      now: now.toISOString(),
    });
  }
}
