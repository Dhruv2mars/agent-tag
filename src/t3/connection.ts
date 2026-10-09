import { stat } from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import { readSecretFile, type SecretString } from "../security/secret-file.ts";
import type { ServiceLogger } from "../service.ts";
import {
  assertRestrictedOrchestrationSession,
  inspectT3Session,
  isT3CredentialRejection,
  issueT3WebSocketUrl,
  type T3Session,
} from "./auth.ts";
import {
  dispatchResultSchema,
  protocolLayer,
  requestT3ThreadSnapshot,
  rpcGroup,
  t3CommandSchema,
  t3ServerConfigSchema,
  threadStreamItemSchema,
  type T3Command,
  type T3ConnectionConfig,
  type T3DispatchResult,
  type T3ServerInfo,
  type T3ThreadSnapshot,
  type T3ThreadStreamItem,
} from "./gateway.ts";

type Client = RpcClient.FromGroup<typeof rpcGroup, RpcClientError>;

/** One opened WebSocket and its RPC client. Retired as a whole when its transport fails. */
interface Generation {
  readonly client: Client;
  readonly scope: Scope.Closeable;
  /** The token its ticket was minted with; a rotated token retires the socket. */
  readonly token: SecretString;
}

/** Request counters since the connection was created; `t3.connection.stats` logs them. */
export interface T3ConnectionStats {
  sessionInspects: number;
  wsTickets: number;
  wsConnects: number;
  snapshotFetches: number;
  rpcCalls: number;
}

/** A session is re-inspected this long before T3 says it expires. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;
/** The token file's mtime is checked at most this often, to pick up a rotated token without a restart. */
const TOKEN_STAT_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 10_000;

export class T3ConnectionClosedError extends Error {
  constructor() {
    super("T3 connection is closed");
    this.name = "T3ConnectionClosedError";
  }
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/**
 * True when an RPC failed because its WebSocket did, not because T3 answered with an error. T3's
 * typed errors decode as plain tagged objects (see dispatch-errors.ts); the RPC client reports
 * transport loss as `RpcClientError`; anything else is a defect of the client. Both of the latter
 * leave the client unusable, so its generation is retired and the next call reconnects.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof Error) return true;
  if (typeof error !== "object" || error === null) return true;
  return Reflect.get(error, "_tag") === "RpcClientError";
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortEffect(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The service's one T3 connection: an inspected session cached until it nears expiry, the token
 * changes on disk, or T3 rejects it, and one long-lived WebSocket RPC client shared by every caller.
 * A WebSocket ticket is minted only when a socket is (re)opened. One-shot paths (CLI, doctor,
 * onboarding) keep using the gateway functions, which open a socket per call.
 */
export class T3Connection {
  readonly stats: T3ConnectionStats = { sessionInspects: 0, wsTickets: 0, wsConnects: 0, snapshotFetches: 0, rpcCalls: 0 };
  readonly #config: T3ConnectionConfig;
  readonly #logger: ServiceLogger | undefined;
  readonly #now: () => Date;
  #session: { readonly token: SecretString; readonly session: T3Session; readonly mtimeMs: number } | null = null;
  #sessionLoad: Promise<{ readonly token: SecretString; readonly session: T3Session; readonly mtimeMs: number }> | null = null;
  #tokenCheckedAt = 0;
  #generation: Generation | null = null;
  #connecting: Promise<Generation> | null = null;
  #failures = 0;
  #closed = false;
  /** Aborted by close(), so a pending connect stops instead of opening a socket nobody will close. */
  readonly #closing = new AbortController();

  constructor(input: { readonly config: T3ConnectionConfig; readonly logger?: ServiceLogger; readonly now?: () => Date }) {
    this.#config = { baseUrl: input.config.baseUrl, tokenFile: input.config.tokenFile };
    this.#logger = input.logger;
    this.#now = input.now ?? (() => new Date());
  }

  /** The token and its checked restricted session; re-read and re-inspected only when stale. */
  async session(signal?: AbortSignal): Promise<{ readonly token: SecretString; readonly session: T3Session }> {
    this.#assertOpen();
    const cached = this.#session;
    const nowMs = this.#now().getTime();
    if (cached !== null) {
      let fresh = Date.parse(cached.session.expiresAt) - SESSION_EXPIRY_MARGIN_MS > nowMs;
      if (fresh && nowMs - this.#tokenCheckedAt >= TOKEN_STAT_INTERVAL_MS) {
        this.#tokenCheckedAt = nowMs;
        const mtimeMs = await stat(this.#config.tokenFile).then((metadata) => metadata.mtimeMs, () => Number.NaN);
        if (mtimeMs !== cached.mtimeMs) fresh = false;
      }
      if (fresh) return cached;
      if (this.#session === cached) this.#session = null;
    }
    this.#sessionLoad ??= this.#loadSession(signal).finally(() => {
      this.#sessionLoad = null;
    });
    return this.#sessionLoad;
  }

  /** Drops the cached session so the next call re-reads the token file and re-inspects it. */
  invalidateSession(): void {
    this.#session = null;
  }

  async #loadSession(signal: AbortSignal | undefined) {
    const mtimeMs = await stat(this.#config.tokenFile).then((metadata) => metadata.mtimeMs, () => Number.NaN);
    const token = await readSecretFile(this.#config.tokenFile);
    this.stats.sessionInspects += 1;
    const session = await inspectT3Session({ baseUrl: this.#config.baseUrl, token, ...signalOption(signal) });
    // The security property is unchanged: every (re)inspection still requires the restricted token.
    assertRestrictedOrchestrationSession(session);
    const loaded = { token, session, mtimeMs };
    this.#session = loaded;
    this.#tokenCheckedAt = this.#now().getTime();
    return loaded;
  }

  /** Runs `request` with the cached session; a 401/403 re-reads and re-inspects the token once, then retries. */
  async #withSession<A>(signal: AbortSignal | undefined, request: (token: SecretString) => Promise<A>): Promise<A> {
    const { token } = await this.session(signal);
    try {
      return await request(token);
    } catch (error) {
      if (!isT3CredentialRejection(error)) throw error;
      this.invalidateSession();
      const retry = await this.session(signal);
      return request(retry.token);
    }
  }

  async fetchThread(threadId: string, signal?: AbortSignal): Promise<T3ThreadSnapshot> {
    return this.#withSession(signal, (token) => {
      this.stats.snapshotFetches += 1;
      return requestT3ThreadSnapshot({ baseUrl: this.#config.baseUrl, token, threadId, ...signalOption(signal) });
    });
  }

  async dispatch(command: T3Command, signal?: AbortSignal): Promise<T3DispatchResult> {
    const parsed = t3CommandSchema.parse(command);
    const raw = await this.#rpc(signal, (client) => client["orchestration.dispatchCommand"](parsed));
    return dispatchResultSchema.parse(raw);
  }

  async inspect(signal?: AbortSignal): Promise<T3ServerInfo> {
    await this.#rpc(signal, (client) => client["server.probe"]({}));
    const raw = await this.#rpc(signal, (client) => client["server.getConfig"]({}));
    return t3ServerConfigSchema.parse(raw);
  }

  /**
   * Streams one thread's items until the stream ends, fails, or `signal` aborts (which resolves).
   * A transport failure retires the socket, so the caller's resubscribe reconnects.
   */
  async subscribeThread(input: {
    readonly threadId: string;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
    readonly onItem: (item: T3ThreadStreamItem) => void;
  }): Promise<void> {
    const payload = {
      threadId: input.threadId,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
    };
    await this.#rpc(input.signal, (client) =>
      Effect.raceFirst(
        client["orchestration.subscribeThread"](payload).pipe(
          Stream.runForEach((item) => Effect.sync(() => input.onItem(threadStreamItemSchema.parse(item)))),
        ),
        abortEffect(input.signal),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing.abort();
    await this.#connecting?.catch(() => undefined);
    const generation = this.#generation;
    this.#generation = null;
    this.#session = null;
    if (generation !== null) {
      await Effect.runPromise(Scope.close(generation.scope, Exit.void));
      this.#log("info", "t3.connection.closed");
    }
  }

  async #rpc<A, E>(signal: AbortSignal | undefined, call: (client: Client) => Effect.Effect<A, E>): Promise<A> {
    // Checks the session first (expiry, token mtime), so a rotated token is validated before any command.
    const { token } = await this.session(signal);
    const generation = await this.#client(token, signal);
    this.stats.rpcCalls += 1;
    try {
      const result = await Effect.runPromise(call(generation.client), signalOption(signal));
      this.#failures = 0;
      return result;
    } catch (error) {
      // An aborted call only interrupts its own request; the shared socket stays up.
      if (!signal?.aborted && isTransportFailure(error)) this.#retire(generation);
      throw error;
    }
  }

  #client(token: SecretString, signal: AbortSignal | undefined): Promise<Generation> {
    this.#assertOpen();
    const current = this.#generation;
    if (current !== null && current.token.exposeToBoundary() !== token.exposeToBoundary()) {
      this.#generation = null;
      this.#log("info", "t3.connection.rotated");
      void Effect.runPromise(Scope.close(current.scope, Exit.void)).catch(() => undefined);
    } else if (current !== null) {
      return Promise.resolve(current);
    }
    this.#connecting ??= this.#connect(signal).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect(callerSignal: AbortSignal | undefined): Promise<Generation> {
    const signal = callerSignal === undefined ? this.#closing.signal : AbortSignal.any([callerSignal, this.#closing.signal]);
    if (this.#failures > 0) {
      const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.#failures - 1));
      await abortableDelay(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)), signal);
    }
    try {
      let ticketToken: SecretString | undefined;
      const url = await this.#withSession(signal, (token) => {
        this.stats.wsTickets += 1;
        ticketToken = token;
        return issueT3WebSocketUrl({ baseUrl: this.#config.baseUrl, token, signal });
      });
      this.#assertOpen();
      const scope = await Effect.runPromise(Scope.make());
      const client = await Effect.runPromise(
        // The protocol layer is built into the generation's scope: `Effect.provide(layer)` alone would
        // close the socket as soon as `RpcClient.make` returned.
        Layer.buildWithScope(protocolLayer(url), scope).pipe(
          Effect.flatMap((context) => RpcClient.make(rpcGroup).pipe(Effect.provide(context))),
          Scope.provide(scope),
        ),
        { signal },
      ).catch(async (error: unknown) => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw error;
      });
      if (this.#closed || ticketToken === undefined) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw new T3ConnectionClosedError();
      }
      const generation = { client, scope, token: ticketToken };
      this.#generation = generation;
      this.stats.wsConnects += 1;
      // Never log the URL: it carries the single-use ticket.
      this.#log("info", this.stats.wsConnects === 1 ? "t3.connection.opened" : "t3.connection.reconnect");
      return generation;
    } catch (error) {
      if (!signal?.aborted) this.#failures += 1;
      throw error;
    }
  }

  #retire(generation: Generation): void {
    if (this.#generation !== generation) return;
    this.#generation = null;
    this.#failures += 1;
    this.#log("warn", "t3.connection.lost");
    void Effect.runPromise(Scope.close(generation.scope, Exit.void)).catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new T3ConnectionClosedError();
  }

  #log(level: "info" | "warn", event: string): void {
    this.#logger?.({ level, event, at: this.#now().toISOString() });
  }
}
