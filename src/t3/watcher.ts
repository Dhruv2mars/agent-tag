import { z } from "zod";

import type { ServiceLogger } from "../service.ts";
import type { T3Connection } from "./connection.ts";
import type { T3ThreadStreamItem } from "./gateway.ts";

/** An activity as the stream reports it; enough for a progress view, never its payload. */
export interface ThreadActivityView {
  readonly id: string;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly turnId: string | null;
}

export interface ThreadSessionView {
  readonly status: string;
  readonly activeTurnId: string | null;
  readonly providerName: string | null;
  readonly providerInstanceId: string | null;
}

export type NormalizedThreadItem =
  | { readonly kind: "synchronized" }
  | { readonly kind: "snapshot"; readonly sequence: number }
  | {
      readonly kind: "event";
      readonly sequence: number;
      readonly type: string;
      readonly turnId: string | null;
      /** True when the event cannot change how the turn settles (streamed text, tool progress). */
      readonly progressOnly: boolean;
      readonly activity?: ThreadActivityView;
      readonly session?: ThreadSessionView;
    };

/** Adapter seam: protocol 1 is below; a protocol-2 server needs its own source. */
export interface ThreadEventSource {
  readonly protocol: 1 | 2;
  /** Streams until the stream ends or fails (rejects), or resolves once `signal` aborts. */
  subscribe(input: {
    readonly threadId: string;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
    readonly onItem: (item: NormalizedThreadItem) => void;
  }): Promise<void>;
}

/**
 * Activity kinds that report work in progress but never settle a turn or ask a human. Approval,
 * user-input, failure and unknown kinds are not listed, so they wake the coordinator.
 */
const PROGRESS_ACTIVITY_KINDS = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "task.started",
  "task.progress",
  "turn.plan.updated",
  "runtime.note",
  "context-compaction",
]);

const nullableId = z.string().min(1).nullable().optional().catch(null);
const activityPayloadSchema = z.object({
  activity: z.object({
    id: z.string().min(1),
    tone: z.string().min(1),
    kind: z.string().min(1),
    summary: z.string(),
    turnId: nullableId,
  }),
});
const sessionPayloadSchema = z.object({
  session: z.object({
    status: z.string().min(1),
    activeTurnId: nullableId,
    providerName: nullableId,
    providerInstanceId: nullableId,
  }),
});
const messagePayloadSchema = z.object({ streaming: z.boolean(), turnId: nullableId });
const turnPayloadSchema = z.object({ turnId: nullableId });
const snapshotSequenceSchema = z.object({ snapshotSequence: z.number().int().nonnegative() });

/** Maps one protocol-1 stream item. Payload shapes it does not recognise still wake the coordinator. */
export function normalizeV1Item(item: T3ThreadStreamItem): NormalizedThreadItem | null {
  if (item.kind === "synchronized") return { kind: "synchronized" };
  if (item.kind === "snapshot") {
    const parsed = snapshotSequenceSchema.safeParse(item.snapshot);
    return parsed.success ? { kind: "snapshot", sequence: parsed.data.snapshotSequence } : null;
  }
  const { sequence, type, payload } = item.event;
  if (type === "thread.activity-appended") {
    const parsed = activityPayloadSchema.safeParse(payload);
    if (parsed.success) {
      const activity = { ...parsed.data.activity, turnId: parsed.data.activity.turnId ?? null };
      return {
        kind: "event",
        sequence,
        type,
        turnId: activity.turnId,
        progressOnly: PROGRESS_ACTIVITY_KINDS.has(activity.kind),
        activity,
      };
    }
  } else if (type === "thread.session-set") {
    const parsed = sessionPayloadSchema.safeParse(payload);
    if (parsed.success) {
      const session = {
        status: parsed.data.session.status,
        activeTurnId: parsed.data.session.activeTurnId ?? null,
        providerName: parsed.data.session.providerName ?? null,
        providerInstanceId: parsed.data.session.providerInstanceId ?? null,
      };
      return { kind: "event", sequence, type, turnId: session.activeTurnId, progressOnly: false, session };
    }
  } else if (type === "thread.message-sent") {
    const parsed = messagePayloadSchema.safeParse(payload);
    if (parsed.success) {
      // A streaming delta only grows text; the final, non-streaming message is what settles a turn.
      return { kind: "event", sequence, type, turnId: parsed.data.turnId ?? null, progressOnly: parsed.data.streaming };
    }
  }
  const turn = turnPayloadSchema.safeParse(payload);
  return { kind: "event", sequence, type, turnId: turn.success ? turn.data.turnId ?? null : null, progressOnly: false };
}

/** Protocol-1 `orchestration.subscribeThread` over the shared connection. */
export function protocolV1Source(connection: Pick<T3Connection, "subscribeThread">): ThreadEventSource {
  return {
    protocol: 1,
    subscribe: (input) =>
      connection.subscribeThread({
        threadId: input.threadId,
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        signal: input.signal,
        onItem: (item) => {
          const normalized = normalizeV1Item(item);
          if (normalized !== null) input.onItem(normalized);
        },
      }),
  };
}

export type ThreadWakeReason = "event" | "resync" | "timeout";

export interface ThreadWatch {
  /**
   * Resolves "event" once an item that may change how the turn settles arrives after the previous
   * call returned (immediately if one already did), "resync" once a dropped stream is resubscribed,
   * or "timeout" after `timeoutMs` or when `signal` aborts. Wake-ups within the coalescing window
   * resolve together.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<ThreadWakeReason>;
  /** Highest event sequence seen on the thread, including progress-only events; 0 before any. */
  readonly lastSequence: number;
  /** Every normalized item as it arrives. Returns the unsubscribe function. */
  onItem(listener: (item: NormalizedThreadItem) => void): () => void;
  /** Idempotent. The last release closes the subscription after the linger window. */
  release(): void;
}

/** What the coordinator needs from a watcher; `ThreadWatcher` implements it. */
export interface ThreadWatchSource {
  acquire(threadId: string, options?: { readonly afterSequence?: number }): ThreadWatch;
}

interface Subscription {
  readonly threadId: string;
  readonly controller: AbortController;
  readonly watches: Set<WatchHandle>;
  lastSequence: number;
  refs: number;
  linger: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

const RESUBSCRIBE_BASE_MS = 250;
const RESUBSCRIBE_MAX_MS = 10_000;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

class WatchHandle implements ThreadWatch {
  readonly #subscription: Subscription;
  readonly #coalesceMs: number;
  readonly #onRelease: (watch: WatchHandle) => void;
  readonly #listeners = new Set<(item: NormalizedThreadItem) => void>();
  #pending: "event" | "resync" | null = null;
  #wake: (() => void) | null = null;
  #released = false;

  constructor(subscription: Subscription, coalesceMs: number, onRelease: (watch: WatchHandle) => void) {
    this.#subscription = subscription;
    this.#coalesceMs = coalesceMs;
    this.#onRelease = onRelease;
  }

  get lastSequence(): number {
    return this.#subscription.lastSequence;
  }

  /** Called by the watcher for each item; `wake` is null for items that only report progress. */
  deliver(item: NormalizedThreadItem | null, wake: "event" | "resync" | null): void {
    if (item !== null) {
      for (const listener of this.#listeners) {
        try {
          listener(item);
        } catch {
          // A broken listener must not stop wake-ups.
        }
      }
    }
    if (wake === null) return;
    this.#pending = this.#pending === "resync" || wake === "resync" ? "resync" : "event";
    this.#wake?.();
  }

  next(timeoutMs: number, signal?: AbortSignal): Promise<ThreadWakeReason> {
    const pending = this.#pending;
    if (pending !== null || this.#released || signal?.aborted) {
      this.#pending = null;
      return Promise.resolve(pending ?? "timeout");
    }
    return new Promise((resolve) => {
      let coalesce: ReturnType<typeof setTimeout> | null = null;
      const finish = (reason: ThreadWakeReason) => {
        clearTimeout(timer);
        if (coalesce !== null) clearTimeout(coalesce);
        signal?.removeEventListener("abort", onAbort);
        this.#wake = null;
        this.#pending = null;
        resolve(reason);
      };
      const onAbort = () => finish("timeout");
      const timer = setTimeout(() => finish(this.#pending ?? "timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#wake = () => {
        coalesce ??= setTimeout(() => finish(this.#pending ?? "event"), this.#coalesceMs);
      };
    });
  }

  onItem(listener: (item: NormalizedThreadItem) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#listeners.clear();
    this.#wake?.();
    this.#onRelease(this);
  }
}

/**
 * One ref-counted `subscribeThread` per T3 thread for the whole service. The stream only wakes
 * waiting coordinators and reports progress; settlement still reads the HTTP snapshot, so a dead
 * stream costs latency (until the caller's safety poll), never correctness.
 */
export class ThreadWatcher implements ThreadWatchSource {
  readonly #source: ThreadEventSource;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;
  readonly #lingerMs: number;
  readonly #coalesceMs: number;
  readonly #subscriptions = new Map<string, Subscription>();
  #closed = false;

  constructor(input: {
    readonly source: ThreadEventSource;
    readonly logger?: ServiceLogger;
    readonly now?: () => Date;
    /** How long a subscription stays open after its last release, for the thread's next turn. */
    readonly lingerMs?: number;
    /** Wake-ups this close together resolve one `next()`, so one snapshot fetch covers a burst. */
    readonly coalesceMs?: number;
  }) {
    this.#source = input.source;
    this.#logger = input.logger;
    this.#now = input.now ?? (() => new Date());
    this.#lingerMs = input.lingerMs ?? 30_000;
    this.#coalesceMs = input.coalesceMs ?? 200;
  }

  /** `afterSequence` (e.g. the turn-start receipt) skips the initial snapshot frame on a new subscription. */
  acquire(threadId: string, options?: { readonly afterSequence?: number }): ThreadWatch {
    if (this.#closed) throw new Error("thread watcher is closed");
    let subscription = this.#subscriptions.get(threadId);
    if (subscription === undefined) {
      const created: Subscription = {
        threadId,
        controller: new AbortController(),
        watches: new Set(),
        lastSequence: options?.afterSequence ?? 0,
        refs: 0,
        linger: null,
        done: Promise.resolve(),
      };
      created.done = this.#run(created, options?.afterSequence !== undefined);
      this.#subscriptions.set(threadId, created);
      subscription = created;
    }
    if (subscription.linger !== null) {
      clearTimeout(subscription.linger);
      subscription.linger = null;
    }
    subscription.refs += 1;
    const active = subscription;
    const watch = new WatchHandle(active, this.#coalesceMs, (released) => this.#release(active, released));
    active.watches.add(watch);
    return watch;
  }

  /** Number of open thread subscriptions (lingering ones included). */
  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const subscription of subscriptions) {
      if (subscription.linger !== null) clearTimeout(subscription.linger);
      subscription.controller.abort();
    }
    await Promise.allSettled(subscriptions.map((subscription) => subscription.done));
  }

  #release(subscription: Subscription, watch: WatchHandle): void {
    if (!subscription.watches.delete(watch)) return;
    subscription.refs -= 1;
    if (subscription.refs > 0 || subscription.controller.signal.aborted) return;
    subscription.linger = setTimeout(() => {
      subscription.linger = null;
      if (subscription.refs > 0) return;
      this.#subscriptions.delete(subscription.threadId);
      subscription.controller.abort();
      this.#log("info", "t3.watch.released");
    }, this.#lingerMs);
  }

  async #run(subscription: Subscription, resume: boolean): Promise<void> {
    const signal = subscription.controller.signal;
    let failures = 0;
    let useSequence = resume;
    this.#log("info", "t3.watch.subscribed");
    while (!signal.aborted) {
      // After a drop, the first item of the new stream tells waiting coordinators to refetch: the
      // replay covers missed events, but a gap too large for it arrives as a fresh snapshot.
      let resyncDue = failures > 0;
      try {
        await this.#source.subscribe({
          threadId: subscription.threadId,
          ...(useSequence ? { afterSequence: subscription.lastSequence } : {}),
          signal,
          onItem: (item) => {
            failures = 0;
            // Replays overlap what was already seen; T3 documents dedupe by sequence on the client.
            const duplicate = item.kind === "event" && item.sequence <= subscription.lastSequence;
            const wake = duplicate ? null : this.#accept(subscription, item);
            const reason = resyncDue ? "resync" : wake;
            resyncDue = false;
            for (const watch of subscription.watches) watch.deliver(duplicate ? null : item, reason);
          },
        });
        if (!signal.aborted) this.#log("warn", "t3.watch.ended");
      } catch {
        if (!signal.aborted) this.#log("warn", "t3.watch.failed");
      }
      if (signal.aborted) break;
      useSequence = true;
      failures += 1;
      this.#log("info", "t3.watch.resync");
      const ceiling = Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_BASE_MS * 2 ** (failures - 1));
      await delay(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)), signal);
    }
  }

  /** Advances the thread's sequence; returns whether the item should wake waiting coordinators. */
  #accept(subscription: Subscription, item: NormalizedThreadItem): "event" | null {
    if (item.kind === "synchronized") return null;
    if (item.kind === "snapshot") {
      subscription.lastSequence = Math.max(subscription.lastSequence, item.sequence);
      return "event";
    }
    subscription.lastSequence = item.sequence;
    return item.progressOnly ? null : "event";
  }

  #log(level: "info" | "warn", event: string): void {
    this.#logger?.({ level, event, at: this.#now().toISOString() });
  }
}
