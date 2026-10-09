import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";

import type { ServiceLogRecord } from "../src/service.ts";
import { T3Connection, T3ConnectionClosedError } from "../src/t3/connection.ts";
import { T3ThreadNotFoundError, type T3Command, type T3ThreadStreamItem } from "../src/t3/gateway.ts";
import { eventually, startFakeT3, type FakeT3 } from "./fixtures/fake-t3-server.ts";

export function threadSnapshot(threadId: string, snapshotSequence = 3) {
  return {
    snapshotSequence,
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/tmp/fixture",
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

function interrupt(commandId: string): T3Command {
  return { type: "thread.turn.interrupt", commandId, threadId: "thread-1", createdAt: "2026-10-09T00:00:00.000Z" };
}

describe("T3Connection", () => {
  let fake: FakeT3;
  let connection: T3Connection;
  let clock: number;
  const logs: ServiceLogRecord[] = [];

  beforeEach(async () => {
    fake = await startFakeT3();
    fake.snapshot = (threadId) => (threadId === "missing" ? undefined : threadSnapshot(threadId));
    clock = Date.parse("2026-10-09T00:00:00.000Z");
    logs.length = 0;
    connection = new T3Connection({ config: fake.config, logger: (record) => logs.push(record), now: () => new Date(clock) });
  });

  afterEach(async () => {
    await connection.close();
    await fake.stop();
  });

  test("fifty dispatches and snapshot reads cost one session inspect, one ticket and one socket", async () => {
    for (let index = 0; index < 50; index += 1) await connection.dispatch(interrupt(`command-${index}`));
    await Promise.all(Array.from({ length: 50 }, () => connection.fetchThread("thread-1")));

    expect(fake.counts).toMatchObject({ session: 1, tickets: 1, wsConnects: 1, snapshots: 50 });
    expect(fake.counts.rpc["orchestration.dispatchCommand"]).toBe(50);
    expect(connection.stats).toEqual({ sessionInspects: 1, wsTickets: 1, wsConnects: 1, snapshotFetches: 50, rpcCalls: 50 });
    expect(logs.map((record) => record.event)).toEqual(["t3.connection.opened"]);
  });

  test("concurrent first calls share one session load and one socket", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) => connection.dispatch(interrupt(`command-${index}`))));
    expect(fake.counts).toMatchObject({ session: 1, tickets: 1, wsConnects: 1 });
  });

  test("a 401 re-reads and re-inspects the token once, then retries", async () => {
    await connection.fetchThread("thread-1");
    // The token rotates on disk and in T3 within the mtime-check interval, so the cache is still in use.
    fake.acceptedToken = "rotated-token";
    await fake.writeToken("rotated-token");

    const snapshot = await connection.fetchThread("thread-1");
    expect(snapshot.thread.id).toBe("thread-1");
    expect(fake.counts).toMatchObject({ session: 2, snapshots: 3 });
  });

  test("a credential that stays rejected fails after one retry", async () => {
    await connection.fetchThread("thread-1");
    fake.acceptedToken = "someone-elses-token";
    const error = await connection.fetchThread("thread-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("HTTP 401");
    expect(fake.counts.session).toBe(2);
  });

  test("a token file whose mtime changed is re-read once the stat interval passes", async () => {
    await connection.session();
    fake.acceptedToken = "rotated-token";
    await fake.writeToken("rotated-token");
    await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));

    await connection.session();
    expect(fake.counts.session).toBe(1);
    clock += 6_000;
    await connection.session();
    expect(fake.counts.session).toBe(2);
    await connection.fetchThread("thread-1");
    expect(fake.counts).toMatchObject({ session: 2, snapshots: 1 });
  });

  test("a rotated token is re-inspected before the next RPC and retires the socket it opened", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.acceptedToken = "rotated-token";
    await fake.writeToken("rotated-token");
    await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));
    clock += 6_000;

    expect(await connection.dispatch(interrupt("command-2"))).toEqual({ sequence: 1 });
    expect(fake.counts).toMatchObject({ session: 2, tickets: 2, wsConnects: 2 });
    expect(logs.map((record) => record.event)).toEqual(["t3.connection.opened", "t3.connection.rotated", "t3.connection.reconnect"]);
    await eventually(() => fake.openSockets === 1);
  });

  test("a rotated token that fails inspection blocks RPCs on the already-open socket", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.scopes = ["orchestration:read", "orchestration:operate", "access:write"];
    await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));
    clock += 6_000;

    await expect(connection.dispatch(interrupt("command-2"))).rejects.toThrow("extra=access:write");
    expect(fake.counts.rpc["orchestration.dispatchCommand"]).toBe(1);
  });

  test("concurrent RPCs after a rotation to a rejected token all fail; none reaches the old socket", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.scopes = ["orchestration:read", "orchestration:operate", "access:write"];
    await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));
    clock += 6_000;

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => connection.dispatch(interrupt(`command-concurrent-${index}`))),
    );
    expect(results.map((result) => result.status)).toEqual(Array(5).fill("rejected"));
    expect(fake.counts.rpc["orchestration.dispatchCommand"]).toBe(1);
    expect(fake.counts.session).toBe(2);
  });

  test("concurrent RPCs after a valid rotation share one re-inspect and one new socket", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.acceptedToken = "rotated-token";
    await fake.writeToken("rotated-token");
    await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));
    clock += 6_000;

    await Promise.all(Array.from({ length: 5 }, (_, index) => connection.dispatch(interrupt(`command-concurrent-${index}`))));
    expect(fake.counts).toMatchObject({ session: 2, tickets: 2, wsConnects: 2 });
    expect(fake.counts.rpc["orchestration.dispatchCommand"]).toBe(6);
  });

  test("an aborted caller does not abort a session check other callers share", async () => {
    await connection.session();
    clock += 6_000;
    const controller = new AbortController();
    const aborted = connection.session(controller.signal);
    const shared = connection.session();
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    await expect(shared).resolves.toBeDefined();
  });

  test("aborting the caller that started a connect does not fail another caller waiting on it", async () => {
    let releaseTicket = () => {};
    fake.ticketGate = new Promise((resolve) => {
      releaseTicket = resolve;
    });
    const controller = new AbortController();
    const first = connection.dispatch(interrupt("command-1"), controller.signal);
    await eventually(() => fake.counts.tickets === 1);
    const second = connection.dispatch(interrupt("command-2"));
    controller.abort();
    await expect(first).rejects.toBeDefined();
    releaseTicket();
    expect(await second).toEqual({ sequence: 1 });
    expect(fake.counts).toMatchObject({ tickets: 1, wsConnects: 1 });
  });

  test("a failed shared session check is never an unhandled rejection, even if every caller stopped waiting", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await connection.session();
      fake.scopes = ["orchestration:read", "orchestration:operate", "access:write"];
      await utimes(fake.tokenFile, new Date(clock + 10_000), new Date(clock + 10_000));
      clock += 6_000;

      const preAborted = new AbortController();
      preAborted.abort();
      await expect(connection.session(preAborted.signal)).rejects.toBeDefined();
      await Bun.sleep(50);
      const controller = new AbortController();
      const waiting = connection.session(controller.signal);
      controller.abort();
      await expect(waiting).rejects.toBeDefined();
      await Bun.sleep(50);
      expect(unhandled).toEqual([]);
      await expect(connection.session()).rejects.toThrow("extra=access:write");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a hung ticket request times out instead of wedging every later caller", async () => {
    const bounded = new T3Connection({ config: fake.config, now: () => new Date(clock), sharedTimeoutMs: 50 });
    try {
      let releaseTicket = () => {};
      fake.ticketGate = new Promise((resolve) => {
        releaseTicket = resolve;
      });
      await expect(bounded.dispatch(interrupt("command-1"))).rejects.toBeDefined();
      fake.ticketGate = null;
      releaseTicket();
      expect(await bounded.dispatch(interrupt("command-2"))).toEqual({ sequence: 1 });
    } finally {
      await bounded.close();
    }
  });

  test("close() during a pending connect leaves no socket open", async () => {
    let releaseTicket = () => {};
    fake.ticketGate = new Promise((resolve) => {
      releaseTicket = resolve;
    });
    const dispatched = connection.dispatch(interrupt("command-1"));
    await eventually(() => fake.counts.tickets === 1);

    const closed = connection.close();
    releaseTicket();
    await closed;
    await expect(dispatched).rejects.toBeDefined();
    await Bun.sleep(50);
    expect(fake.openSockets).toBe(0);
    expect(fake.counts.rpc["orchestration.dispatchCommand"]).toBeUndefined();
  });

  test("a session is re-inspected before it expires", async () => {
    await connection.session();
    clock = Date.parse("2099-01-01T00:00:00.000Z") - 30_000;
    await connection.session();
    expect(fake.counts.session).toBe(2);
  });

  test("a token with extra scopes is refused on every inspection", async () => {
    fake.scopes = ["orchestration:read", "orchestration:operate", "access:write"];
    await expect(connection.session()).rejects.toThrow("extra=access:write");
    await expect(connection.dispatch(interrupt("command-1"))).rejects.toThrow("extra=access:write");
    expect(fake.counts.tickets).toBe(0);
  });

  test("a snapshot 404 is the typed not-found error", async () => {
    await expect(connection.fetchThread("missing")).rejects.toBeInstanceOf(T3ThreadNotFoundError);
  });

  test("a dropped socket is retired and the next call reconnects with a fresh ticket", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.dropSockets();

    // The first call after the drop may still land on the dead socket; a caller's retry reconnects.
    let result: unknown;
    for (let attempt = 0; attempt < 5 && result === undefined; attempt += 1) {
      result = await connection.dispatch(interrupt(`command-retry-${attempt}`)).catch(() => undefined);
    }
    expect(result).toEqual({ sequence: 1 });
    expect(fake.counts).toMatchObject({ session: 1, tickets: 2, wsConnects: 2 });
    expect(logs.map((record) => record.event)).toEqual(["t3.connection.opened", "t3.connection.lost", "t3.connection.reconnect"]);
  });

  test("subscribeThread streams items, and aborting it keeps the shared socket", async () => {
    const items: T3ThreadStreamItem[] = [];
    const controller = new AbortController();
    const streamed = connection.subscribeThread({
      threadId: "thread-1",
      afterSequence: 4,
      signal: controller.signal,
      onItem: (item) => items.push(item),
    });
    await eventually(() => fake.subscriptions.length === 1);
    expect(fake.subscriptions[0]).toMatchObject({ threadId: "thread-1", afterSequence: 4 });

    fake.push("thread-1", { kind: "synchronized" });
    await eventually(() => items.length === 1);
    expect(items).toEqual([{ kind: "synchronized" }]);

    controller.abort();
    await streamed;
    await eventually(() => fake.subscriptions.length === 0);
    await connection.dispatch(interrupt("command-1"));
    expect(fake.counts).toMatchObject({ tickets: 1, wsConnects: 1 });
  });

  test("a stream on a dropped socket rejects so the watcher can resubscribe", async () => {
    const streamed = connection.subscribeThread({
      threadId: "thread-1",
      signal: new AbortController().signal,
      onItem: () => undefined,
    });
    await eventually(() => fake.subscriptions.length === 1);
    fake.dropSockets();
    await expect(streamed).rejects.toBeDefined();
  });

  test("close() closes the socket and refuses later calls", async () => {
    await connection.dispatch(interrupt("command-1"));
    await connection.close();
    await expect(connection.dispatch(interrupt("command-2"))).rejects.toBeInstanceOf(T3ConnectionClosedError);
    expect(logs.at(-1)?.event).toBe("t3.connection.closed");
  });

  test("logs never carry the token or WebSocket ticket", async () => {
    await connection.dispatch(interrupt("command-1"));
    fake.dropSockets();
    for (let attempt = 0; attempt < 5; attempt += 1) await connection.dispatch(interrupt(`retry-${attempt}`)).catch(() => undefined);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("ticket-");
  });
});
