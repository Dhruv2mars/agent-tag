import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

/**
 * A T3 stand-in that speaks the HTTP auth endpoints, the thread snapshot GET, and Effect RPC JSON
 * over `/ws`, and counts every request so tests can assert how many each code path makes.
 */
export interface FakeT3Counts {
  session: number;
  tickets: number;
  wsConnects: number;
  snapshots: number;
  rpc: Record<string, number>;
}

interface StreamRequest {
  readonly socket: ServerWebSocket<unknown>;
  readonly requestId: string | number;
  readonly threadId: string;
  readonly afterSequence: number | undefined;
}

export interface FakeT3 {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly config: { readonly baseUrl: string; readonly tokenFile: string };
  readonly counts: FakeT3Counts;
  readonly dispatched: unknown[];
  subscriptions: StreamRequest[];
  /** What the snapshot GET returns for a thread; a 404 when it returns undefined. */
  snapshot: (threadId: string) => unknown;
  /** Dispatch receipt sequence. */
  dispatchSequence: () => number;
  /** Scopes the session endpoint reports. */
  scopes: string[];
  /** The only bearer token the server accepts. */
  acceptedToken: string;
  /** Pushes a stream item to every open subscription of the thread. */
  push(threadId: string, item: unknown): void;
  /** Closes every WebSocket abruptly. */
  dropSockets(): void;
  writeToken(token: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startFakeT3(): Promise<FakeT3> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-fake-t3-"));
  const tokenFile = join(directory, "t3-token");
  const counts: FakeT3Counts = { session: 0, tickets: 0, wsConnects: 0, snapshots: 0, rpc: {} };
  const tickets = new Set<string>();
  const sockets = new Set<ServerWebSocket<unknown>>();
  const send = (socket: ServerWebSocket<unknown>, message: unknown) => {
    socket.send(JSON.stringify(message));
  };
  const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${fake.acceptedToken}`;

  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/session") {
        counts.session += 1;
        if (!authorized(request)) return new Response("unauthorized", { status: 401 });
        return Response.json({
          authenticated: true,
          scopes: fake.scopes,
          sessionMethod: "bearer-access-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname === "/api/auth/websocket-ticket") {
        counts.tickets += 1;
        if (!authorized(request)) return new Response("unauthorized", { status: 401 });
        const ticket = `ticket-${counts.tickets}`;
        tickets.add(ticket);
        return Response.json({ ticket, expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      if (url.pathname.startsWith("/api/orchestration/threads/")) {
        counts.snapshots += 1;
        if (!authorized(request)) return new Response("unauthorized", { status: 401 });
        const snapshot = fake.snapshot(decodeURIComponent(url.pathname.slice("/api/orchestration/threads/".length)));
        return snapshot === undefined ? new Response("not found", { status: 404 }) : Response.json(snapshot);
      }
      if (url.pathname === "/ws") {
        // Tickets are single-use, as in T3.
        const ticket = url.searchParams.get("wsTicket") ?? "";
        if (!tickets.delete(ticket)) return new Response("bad ticket", { status: 401 });
        if (server.upgrade(request)) return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        counts.wsConnects += 1;
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
        fake.subscriptions = fake.subscriptions.filter((subscription) => subscription.socket !== socket);
      },
      message(socket, raw) {
        const decoded: unknown = JSON.parse(String(raw));
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          const tag = Reflect.get(message, "_tag");
          if (tag === "Ping") {
            send(socket, { _tag: "Pong" });
            continue;
          }
          if (tag === "Interrupt") {
            const requestId = Reflect.get(message, "requestId");
            fake.subscriptions = fake.subscriptions.filter((subscription) => subscription.requestId !== requestId);
            send(socket, { _tag: "Exit", requestId, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: undefined }] } });
            continue;
          }
          if (tag !== "Request") continue;
          const requestId = Reflect.get(message, "id");
          const rpc = String(Reflect.get(message, "tag"));
          const payload: unknown = Reflect.get(message, "payload");
          counts.rpc[rpc] = (counts.rpc[rpc] ?? 0) + 1;
          const succeed = (value: unknown) => send(socket, { _tag: "Exit", requestId, exit: { _tag: "Success", value } });
          if (rpc === "orchestration.dispatchCommand") {
            fake.dispatched.push(payload);
            succeed({ sequence: fake.dispatchSequence() });
          } else if (rpc === "server.probe") {
            succeed({});
          } else if (rpc === "server.getConfig") {
            succeed({ environment: { environmentId: "env-1", capabilities: {} }, providers: [] });
          } else if (rpc === "orchestration.subscribeThread") {
            const after = Reflect.get(payload as object, "afterSequence");
            fake.subscriptions.push({
              socket,
              requestId,
              threadId: String(Reflect.get(payload as object, "threadId")),
              afterSequence: typeof after === "number" ? after : undefined,
            });
          }
        }
      },
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const fake: FakeT3 = {
    baseUrl,
    tokenFile,
    config: { baseUrl, tokenFile },
    counts,
    dispatched: [],
    subscriptions: [],
    snapshot: () => undefined,
    dispatchSequence: () => 1,
    scopes: ["orchestration:read", "orchestration:operate"],
    acceptedToken: "fixture-token",
    push(threadId, item) {
      for (const subscription of fake.subscriptions) {
        if (subscription.threadId !== threadId) continue;
        send(subscription.socket, { _tag: "Chunk", requestId: subscription.requestId, values: [item] });
      }
    },
    dropSockets() {
      for (const socket of sockets) socket.terminate();
    },
    async writeToken(token) {
      await writeFile(tokenFile, `${token}\n`);
      await chmod(tokenFile, 0o600);
    },
    async stop() {
      server.stop(true);
      if (!directory.startsWith(`${tmpdir()}/agent-tag-fake-t3-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    },
  };
  await chmod(directory, 0o700);
  await fake.writeToken("fixture-token");
  return fake;
}

/** Polls `predicate` until it holds or about two seconds pass. */
export async function eventually(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) await Bun.sleep(5);
  if (!predicate()) throw new Error("condition did not become true in time");
}
