import { afterEach, describe, expect, test } from "bun:test";

import { T3Connection } from "../src/t3/connection.ts";
import {
  normalizeV1Item,
  protocolV1Source,
  ThreadWatcher,
  type NormalizedThreadItem,
  type ThreadEventSource,
} from "../src/t3/watcher.ts";
import { eventually, startFakeT3 } from "./fixtures/fake-t3-server.ts";

interface FakeStream {
  readonly threadId: string;
  readonly afterSequence: number | undefined;
  readonly signal: AbortSignal;
  emit(item: NormalizedThreadItem): void;
  end(): void;
  fail(): void;
}

function fakeSource(): ThreadEventSource & { readonly streams: FakeStream[] } {
  const streams: FakeStream[] = [];
  return {
    protocol: 1,
    streams,
    subscribe: (input) =>
      new Promise<void>((resolve, reject) => {
        input.signal.addEventListener("abort", () => resolve(), { once: true });
        streams.push({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          signal: input.signal,
          emit: input.onItem,
          end: resolve,
          fail: () => reject(new Error("stream failed")),
        });
      }),
  };
}

function event(sequence: number, progressOnly = false): NormalizedThreadItem {
  return { kind: "event", sequence, type: "thread.activity-appended", turnId: "turn-1", progressOnly };
}

const watchers: ThreadWatcher[] = [];
function watcher(source: ThreadEventSource, options: { lingerMs?: number; coalesceMs?: number } = {}): ThreadWatcher {
  const created = new ThreadWatcher({ source, lingerMs: options.lingerMs ?? 20, coalesceMs: options.coalesceMs ?? 5 });
  watchers.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((created) => created.close()));
});

describe("ThreadWatcher", () => {
  test("two acquires of one thread share one subscription", async () => {
    const source = fakeSource();
    const threads = watcher(source);
    const first = threads.acquire("thread-1", { afterSequence: 7 });
    const second = threads.acquire("thread-1", { afterSequence: 99 });
    threads.acquire("thread-2");
    await eventually(() => source.streams.length === 2);
    expect(source.streams.map((stream) => [stream.threadId, stream.afterSequence])).toEqual([
      ["thread-1", 7],
      ["thread-2", undefined],
    ]);
    expect(threads.subscriptionCount).toBe(2);
    expect(first.lastSequence).toBe(7);
    expect(second.lastSequence).toBe(7);
  });

  test("next() resolves on an event, and times out without one", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1");
    await eventually(() => source.streams.length === 1);

    expect(await watch.next(20)).toBe("timeout");
    const woken = watch.next(5_000);
    source.streams[0]?.emit(event(3));
    expect(await woken).toBe("event");
    expect(watch.lastSequence).toBe(3);
  });

  test("an event that arrives between waits is not lost", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    source.streams[0]?.emit(event(1));
    expect(await watch.next(5_000)).toBe("event");
    expect(await watch.next(20)).toBe("timeout");
  });

  test("a burst within the coalescing window resolves one wait", async () => {
    const source = fakeSource();
    const watch = watcher(source, { coalesceMs: 30 }).acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    const woken = watch.next(5_000);
    for (let sequence = 1; sequence <= 5; sequence += 1) source.streams[0]?.emit(event(sequence));
    expect(await woken).toBe("event");
    expect(watch.lastSequence).toBe(5);
    expect(await watch.next(20)).toBe("timeout");
  });

  test("progress-only events advance the sequence without waking", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    const seen: NormalizedThreadItem[] = [];
    watch.onItem((item) => seen.push(item));
    source.streams[0]?.emit(event(4, true));
    source.streams[0]?.emit({ kind: "synchronized" });
    expect(await watch.next(30)).toBe("timeout");
    expect(watch.lastSequence).toBe(4);
    expect(seen).toEqual([event(4, true), { kind: "synchronized" }]);
  });

  test("replayed events at or below the last sequence are dropped", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1", { afterSequence: 10 });
    await eventually(() => source.streams.length === 1);
    const seen: NormalizedThreadItem[] = [];
    watch.onItem((item) => seen.push(item));
    source.streams[0]?.emit(event(9));
    source.streams[0]?.emit(event(10));
    expect(await watch.next(30)).toBe("timeout");
    source.streams[0]?.emit(event(11));
    expect(await watch.next(5_000)).toBe("event");
    expect(seen).toEqual([event(11)]);
  });

  test("a snapshot item advances the sequence and wakes", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1", { afterSequence: 2 });
    await eventually(() => source.streams.length === 1);
    source.streams[0]?.emit({ kind: "snapshot", sequence: 40 });
    expect(await watch.next(5_000)).toBe("event");
    expect(watch.lastSequence).toBe(40);
  });

  test("a failed stream resubscribes after the last sequence and wakes waiters with resync", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1", { afterSequence: 5 });
    await eventually(() => source.streams.length === 1);
    source.streams[0]?.emit(event(6));
    expect(await watch.next(5_000)).toBe("event");

    source.streams[0]?.fail();
    await eventually(() => source.streams.length === 2);
    expect(source.streams[1]?.afterSequence).toBe(6);
    const woken = watch.next(5_000);
    // Even an item that would not wake on its own tells waiters to refetch after a gap.
    source.streams[1]?.emit({ kind: "synchronized" });
    expect(await woken).toBe("resync");
  });

  test("a stream that ends cleanly is resubscribed too", async () => {
    const source = fakeSource();
    watcher(source).acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    source.streams[0]?.end();
    await eventually(() => source.streams.length === 2);
    expect(source.streams[1]?.afterSequence).toBe(0);
  });

  test("the last release closes the subscription after the linger window; a reacquire keeps it", async () => {
    const source = fakeSource();
    const threads = watcher(source, { lingerMs: 40 });
    const first = threads.acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    first.release();
    first.release();
    const second = threads.acquire("thread-1");
    await Bun.sleep(60);
    expect(source.streams[0]?.signal.aborted).toBe(false);
    expect(source.streams).toHaveLength(1);

    second.release();
    await eventually(() => source.streams[0]?.signal.aborted === true);
    expect(threads.subscriptionCount).toBe(0);
  });

  test("a released watch's next() returns at once, and release wakes a pending wait", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1");
    const pending = watch.next(5_000);
    watch.release();
    expect(await pending).toBe("timeout");
    expect(await watch.next(5_000)).toBe("timeout");
  });

  test("an aborted signal ends a wait", async () => {
    const source = fakeSource();
    const watch = watcher(source).acquire("thread-1");
    const controller = new AbortController();
    const pending = watch.next(5_000, controller.signal);
    controller.abort();
    expect(await pending).toBe("timeout");
  });

  test("close() aborts every subscription and refuses new acquires", async () => {
    const source = fakeSource();
    const threads = watcher(source);
    threads.acquire("thread-1");
    await eventually(() => source.streams.length === 1);
    await threads.close();
    expect(source.streams[0]?.signal.aborted).toBe(true);
    expect(() => threads.acquire("thread-1")).toThrow("closed");
  });
});

describe("normalizeV1Item", () => {
  const envelope = (sequence: number, type: string, payload: unknown) => ({
    kind: "event" as const,
    event: {
      sequence,
      eventId: `event-${sequence}`,
      type,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      correlationId: null,
      payload,
    },
  });

  test("maps synchronized and snapshot items", () => {
    expect(normalizeV1Item({ kind: "synchronized" })).toEqual({ kind: "synchronized" });
    expect(normalizeV1Item({ kind: "snapshot", snapshot: { snapshotSequence: 12 } })).toEqual({ kind: "snapshot", sequence: 12 });
    expect(normalizeV1Item({ kind: "snapshot", snapshot: { unexpected: true } })).toBeNull();
  });

  test("streaming text and tool activity are progress; approvals, final messages and unknown events wake", () => {
    const activity = (kind: string) => ({ activity: { id: "a-1", tone: "info", kind, summary: "s", turnId: "turn-1", payload: { secret: 1 } } });
    expect(normalizeV1Item(envelope(1, "thread.message-sent", { streaming: true, turnId: "turn-1" }))).toMatchObject({ progressOnly: true, turnId: "turn-1" });
    expect(normalizeV1Item(envelope(2, "thread.message-sent", { streaming: false, turnId: "turn-1" }))).toMatchObject({ progressOnly: false });
    expect(normalizeV1Item(envelope(3, "thread.activity-appended", activity("tool.updated")))).toMatchObject({ progressOnly: true });
    const approval = normalizeV1Item(envelope(4, "thread.activity-appended", activity("approval.requested")));
    expect(approval).toEqual({
      kind: "event",
      sequence: 4,
      type: "thread.activity-appended",
      turnId: "turn-1",
      progressOnly: false,
      // The activity payload never leaves the normalizer.
      activity: { id: "a-1", tone: "info", kind: "approval.requested", summary: "s", turnId: "turn-1" },
    });
    expect(normalizeV1Item(envelope(5, "thread.turn-diff-completed", { turnId: "turn-2" }))).toMatchObject({ progressOnly: false, turnId: "turn-2" });
    expect(normalizeV1Item(envelope(6, "thread.message-sent", { malformed: true }))).toMatchObject({ progressOnly: false, turnId: null });
  });

  test("maps a session update", () => {
    expect(
      normalizeV1Item(
        envelope(7, "thread.session-set", {
          session: { status: "running", activeTurnId: "turn-1", providerName: "codex", providerInstanceId: null, lastError: null },
        }),
      ),
    ).toEqual({
      kind: "event",
      sequence: 7,
      type: "thread.session-set",
      turnId: "turn-1",
      progressOnly: false,
      session: { status: "running", activeTurnId: "turn-1", providerName: "codex", providerInstanceId: null },
    });
  });
});

describe("protocolV1Source over a T3Connection", () => {
  test("streams normalized items and resubscribes after a dropped socket", async () => {
    const fake = await startFakeT3();
    const connection = new T3Connection({ config: fake.config });
    const threads = new ThreadWatcher({ source: protocolV1Source(connection), coalesceMs: 5, lingerMs: 0 });
    try {
      const watch = threads.acquire("thread-1", { afterSequence: 3 });
      await eventually(() => fake.subscriptions.length === 1);
      expect(fake.subscriptions[0]?.afterSequence).toBe(3);

      fake.push("thread-1", {
        kind: "event",
        event: {
          sequence: 4,
          eventId: "event-4",
          type: "thread.turn-diff-completed",
          occurredAt: "2026-10-09T00:00:00.000Z",
          commandId: null,
          correlationId: null,
          payload: { turnId: "turn-1" },
        },
      });
      expect(await watch.next(2_000)).toBe("event");
      expect(watch.lastSequence).toBe(4);

      fake.dropSockets();
      await eventually(() => fake.subscriptions.length === 1 && fake.counts.wsConnects === 2, 1_000);
      expect(fake.subscriptions[0]?.afterSequence).toBe(4);
      expect(fake.counts.tickets).toBe(2);
      fake.push("thread-1", { kind: "synchronized" });
      expect(await watch.next(2_000)).toBe("resync");
    } finally {
      await threads.close();
      await connection.close();
      await fake.stop();
    }
  });
});
