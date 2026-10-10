// Live progress of one T3 turn for its Slack status message: a pure reducer over thread activities
// (from the watcher stream and from snapshots). It keeps only what the status message shows: the
// latest plan, recent tool titles and problems, and the number of finished tools. Tool payloads
// (commands' output, file contents, data) are never kept.
import { z } from "zod";

import type { StatusPlanStep, StatusProgress } from "./store/store.ts";

/** An activity as the stream or a snapshot reports it. `plan` is set for `turn.plan.updated` only. */
export interface ProgressActivity {
  readonly id: string;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly turnId: string | null;
  readonly plan?: ReadonlyArray<StatusPlanStep>;
}

/** Lines shown under the headline, newest last. */
export const RECENT_LINES = 5;
/** Longest rendered progress line; provider tool titles can embed whole shell commands. */
export const PROGRESS_LINE_CHARS = 120;
const MAX_PLAN_STEPS = 12;
/** Activities remembered per turn; older ones only drop out of the recent lines. */
const MAX_ACTIVITIES = 400;

const planSchema = z.object({
  plan: z
    .array(z.object({ step: z.string(), status: z.enum(["pending", "inProgress", "completed"]) }))
    .max(200),
});

/** The plan steps of a `turn.plan.updated` activity payload; undefined when it has none. */
export function planFromPayload(kind: string, payload: unknown): ReadonlyArray<StatusPlanStep> | undefined {
  if (kind !== "turn.plan.updated") return undefined;
  const parsed = planSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  return parsed.data.plan.slice(0, MAX_PLAN_STEPS).map((step) => ({ step: clip(step.step), status: step.status }));
}

/** A snapshot activity as a progress activity (only the plan is read from its payload). */
export function progressActivity(activity: {
  readonly id: string;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly turnId: string | null;
  readonly payload?: unknown;
}): ProgressActivity {
  const plan = planFromPayload(activity.kind, activity.payload);
  return {
    id: activity.id,
    tone: activity.tone,
    kind: activity.kind,
    summary: activity.summary,
    turnId: activity.turnId,
    ...(plan === undefined ? {} : { plan }),
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PROGRESS_LINE_CHARS ? flat : `${flat.slice(0, PROGRESS_LINE_CHARS - 1)}…`;
}

export const EMPTY_PROGRESS: StatusProgress = { plan: [], recent: [], toolCount: 0 };

/**
 * Accumulates one turn's activities. Activities of other turns are ignored once the turn is known,
 * and ones that arrive before it are kept and filtered when it is set. An activity id seen again
 * (T3 re-emits some, e.g. task progress) replaces the earlier one in place.
 */
export class TurnProgress {
  #turnId: string | null = null;
  readonly #activities = new Map<string, ProgressActivity>();

  get turnId(): string | null {
    return this.#turnId;
  }

  setTurn(turnId: string): void {
    if (this.#turnId === turnId) return;
    this.#turnId = turnId;
    for (const [id, activity] of this.#activities) {
      if (activity.turnId !== turnId) this.#activities.delete(id);
    }
  }

  add(activity: ProgressActivity): void {
    if (activity.turnId === null) return;
    if (this.#turnId !== null && activity.turnId !== this.#turnId) return;
    this.#activities.set(activity.id, activity);
    if (this.#activities.size > MAX_ACTIVITIES) {
      const oldest = this.#activities.keys().next();
      if (oldest.done !== true) this.#activities.delete(oldest.value);
    }
  }

  /** The view for the current turn; empty until the turn is known. */
  view(): StatusProgress {
    if (this.#turnId === null) return EMPTY_PROGRESS;
    let plan: ReadonlyArray<StatusPlanStep> = [];
    const recent: string[] = [];
    let toolCount = 0;
    for (const activity of this.#activities.values()) {
      if (activity.turnId !== this.#turnId) continue;
      if (activity.plan !== undefined) plan = activity.plan;
      const line = progressLine(activity);
      if (activity.kind === "tool.completed") toolCount += 1;
      if (line !== null && recent.at(-1) !== line) recent.push(line);
    }
    return { plan: [...plan], recent: recent.slice(-RECENT_LINES), toolCount };
  }
}

function progressLine(activity: ProgressActivity): string | null {
  if (activity.tone === "error") return clip(`Problem: ${activity.summary}`);
  if (activity.kind === "tool.started") return clip(activity.summary.replace(/\s+started$/, ""));
  if (activity.kind === "tool.completed") return clip(activity.summary);
  return null;
}
