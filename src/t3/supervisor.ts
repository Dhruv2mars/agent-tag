import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { z } from "zod";

import type { ResolvedManagedT3 } from "../config.ts";
import { compareVersions } from "../release.ts";
import { redactSecrets } from "../security/redact.ts";
import type { ServiceLogger, ServiceLogRecord } from "../service.ts";
import { ensurePrivateDirectory, inspectInstalledT3, installPinnedT3, T3DowngradeError } from "./install.ts";
import type { T3Pin } from "./pin.ts";
import {
  type EnvironmentFetch,
  fetchT3EnvironmentDescriptor,
  type T3EnvironmentDescriptor,
  T3ProtocolMismatchError,
  T3ServerVersionMismatchError,
  t3DescriptorProblem,
} from "./protocol.ts";

export type T3RuntimeState = "stopped" | "starting" | "ready" | "restarting" | "failed";

/** The verified binary to run; `installPinnedT3` returns a superset of this. */
export interface ManagedT3Binary {
  readonly binary: string;
  readonly version: string;
}

export interface T3ChildProcess {
  readonly pid: number;
  /** Resolves once the process has exited, with its exit code or the terminating signal. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  readonly stderr: ReadableStream<Uint8Array> | null;
}

export type T3SpawnFn = (
  command: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => T3ChildProcess;

export interface T3RuntimeTiming {
  readonly readyTimeoutMs: number;
  readonly readyPollMs: number;
  readonly stopTimeoutMs: number;
  readonly orphanTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly crashWindowMs: number;
  readonly maxRestarts: number;
}

const DEFAULT_TIMING: T3RuntimeTiming = {
  readyTimeoutMs: 60_000,
  readyPollMs: 250,
  stopTimeoutMs: 15_000,
  orphanTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  crashWindowMs: 10 * 60_000,
  maxRestarts: 5,
};

const STDERR_LINE_BYTES = 2_048;
const STDERR_LINES_PER_MINUTE = 30;
const STDERR_TAIL_LINES = 10;
const STDERR_DRAIN_MS = 1_000;
const SUPERVISED_FILE = "supervised.json";

export interface T3ManagedRuntimeOptions {
  readonly settings: Pick<ResolvedManagedT3, "port" | "homeDir" | "runtimeDir">;
  readonly installed: ManagedT3Binary;
  readonly logger: ServiceLogger;
  readonly spawn?: T3SpawnFn;
  /** The environment T3 inherits before filtering; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly fetch?: EnvironmentFetch;
  /** Full command line of a pid, or undefined when it is not running; defaults to `ps -ww -o args=`. */
  readonly processArgs?: (pid: number) => Promise<string | undefined>;
  readonly timing?: Partial<T3RuntimeTiming>;
}

export interface T3RuntimeStatus {
  readonly state: T3RuntimeState;
  readonly pid?: number;
  readonly restarts: number;
  readonly lastExit?: string;
  readonly startedAt?: string;
}

/** Something already answers on the managed port; Agent Tag never presents a token to a server it did not start. */
export class T3PortInUseError extends Error {
  override readonly name = "T3PortInUseError";

  constructor(port: number) {
    super(
      `127.0.0.1:${port} is already in use by a process Agent Tag did not start; stop that process or set t3.port to a free port`,
    );
  }
}

/** The managed T3 exited or never became ready; the message carries the last redacted stderr lines. */
export class T3StartupError extends Error {
  override readonly name = "T3StartupError";
}

/** T3 kept crashing: `maxRestarts` restarts inside `crashWindowMs`. The service exits and its manager takes over. */
export class T3CrashLoopError extends Error {
  override readonly name = "T3CrashLoopError";
}

/** Matches a credential-bearing value in T3 output: pairing links, tickets, bearer and `token: x` pairs. */
const CREDENTIAL_SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\/pair#token=)[^\s"'&]+/gi, "$1[REDACTED]"],
  [/([?&#]?\b(?:token|wsTicket|ws_ticket|ticket|credential|access_token|refresh_token)=)[^\s"'&]+/gi, "$1[REDACTED]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]"],
  [/("?\b(?:token|credential|secret|password|authorization)"?\s*[:=]\s*"?)[^\s"',}]+/gi, "$1[REDACTED]"],
];

/** Redacts known credential shapes plus T3's pairing and ticket formats from one line of T3 output. */
export function redactT3Output(line: string): string {
  let redacted = redactSecrets(line);
  for (const [pattern, replacement] of CREDENTIAL_SCRUBBERS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/**
 * T3's environment: the operator's (HOME, PATH, provider logins) minus every `AGENT_TAG_*` and
 * `T3CODE_*` variable and the dev-server override, plus the managed base dir and headless flags.
 */
export function managedT3Environment(
  base: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith("AGENT_TAG_") || key.startsWith("T3CODE_") || key === "VITE_DEV_SERVER_URL") continue;
    env[key] = value;
  }
  env.T3CODE_HOME = homeDir;
  env.T3CODE_NO_BROWSER = "1";
  env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "0";
  return env;
}

/** `t3 serve` in its own process group (setsid), so stop and orphan reaping reach every descendant. */
export const defaultT3Spawn: T3SpawnFn = (command, options) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: { ...options.env },
    stdin: "ignore",
    // `t3 serve` prints headless pairing details (a live credential) to stdout: never read it.
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
  });
  return {
    pid: child.pid,
    exited: child.exited.then(() => ({ code: child.exitCode, signal: child.signalCode ?? null })),
    stderr: child.stderr,
  };
};

async function defaultProcessArgs(pid: number): Promise<string | undefined> {
  const child = Bun.spawn(["ps", "-ww", "-o", "args=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const args = stdout.trim();
  return code === 0 && args.length > 0 ? args : undefined;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
  }
  // Not a group leader (or the group is gone): fall back to the process itself.
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when anything accepts a TCP connection on 127.0.0.1:port. */
export function loopbackPortAnswers(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const serverRuntimeSchema = z.object({ pid: z.number().int().positive() });
const supervisedSchema = z.object({ pid: z.number().int().positive() });
const runtimeStateSchema = z.looseObject({ highestVersionStarted: z.string().optional() });

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function describeExit(exit: { readonly code: number | null; readonly signal: string | null }): string {
  return exit.signal === null ? `exit code ${exit.code ?? "unknown"}` : `signal ${exit.signal}`;
}

interface RunningChild {
  readonly process: T3ChildProcess;
  exit: { readonly code: number | null; readonly signal: string | null } | undefined;
  readonly stderrDone: Promise<void>;
}

/**
 * Supervises one `t3 serve` for managed mode: refuses a foreign server on the port, reaps its own
 * orphan from a previous Agent Tag that was killed, waits until the environment descriptor matches
 * the pin and `server-runtime.json` names our child, restarts crashes with exponential backoff, and
 * reports a crash loop instead of restarting forever. stdout is discarded (pairing credential);
 * stderr is logged line by line, length- and rate-limited and redacted.
 */
export class T3ManagedRuntime {
  readonly #settings: T3ManagedRuntimeOptions["settings"];
  readonly #installed: ManagedT3Binary;
  readonly #logger: ServiceLogger;
  readonly #spawn: T3SpawnFn;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #fetch: EnvironmentFetch | undefined;
  readonly #processArgs: (pid: number) => Promise<string | undefined>;
  readonly #timing: T3RuntimeTiming;
  readonly #fatalListeners: Array<(error: Error) => void> = [];
  #fatalError: Error | undefined;
  readonly #stateListeners: Array<(state: T3RuntimeState) => void> = [];
  readonly #stderrTail: string[] = [];
  #state: T3RuntimeState = "stopped";
  #child: RunningChild | undefined;
  #stop = new AbortController();
  #recovering: Promise<void> | undefined;
  #restartTimes: number[] = [];
  #restarts = 0;
  #lastExit: string | undefined;
  #startedAt: string | undefined;
  #stderrWindowStart = 0;
  #stderrWindowCount = 0;
  #stderrDropped = 0;

  constructor(options: T3ManagedRuntimeOptions) {
    this.#settings = options.settings;
    this.#installed = options.installed;
    this.#logger = options.logger;
    this.#spawn = options.spawn ?? defaultT3Spawn;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? abortableSleep;
    this.#fetch = options.fetch;
    this.#processArgs = options.processArgs ?? defaultProcessArgs;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#settings.port}`;
  }

  status(): T3RuntimeStatus {
    return {
      state: this.#state,
      ...(this.#child === undefined || this.#child.exit !== undefined ? {} : { pid: this.#child.process.pid }),
      restarts: this.#restarts,
      ...(this.#lastExit === undefined ? {} : { lastExit: this.#lastExit }),
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
    };
  }

  /**
   * Called once when T3 keeps crashing; the runtime is then `failed` and will not restart. A listener
   * added after the failure is called right away, so a crash loop during slow startup is not lost.
   */
  onFatal(listener: (error: Error) => void): void {
    if (this.#fatalError !== undefined) {
      listener(this.#fatalError);
      return;
    }
    this.#fatalListeners.push(listener);
  }

  onStateChange(listener: (state: T3RuntimeState) => void): void {
    this.#stateListeners.push(listener);
  }

  /** Starts T3 and resolves with its descriptor once it is ready and gated; throws (and leaves nothing running) otherwise. */
  async start(signal?: AbortSignal): Promise<T3EnvironmentDescriptor> {
    if (this.#state !== "stopped") throw new Error(`cannot start managed T3 in ${this.#state} state`);
    this.#stop = new AbortController();
    const forwardAbort = (): void => this.#stop.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    this.#setState("starting");
    try {
      await ensurePrivateDirectory(this.#settings.runtimeDir);
      await ensurePrivateDirectory(this.#settings.homeDir);
      await this.#assertNoDowngrade();
      await this.#reapOrphans();
      const descriptor = await this.#launch();
      this.#setState("ready");
      this.#log("info", "t3.runtime.started", `T3 ${this.#installed.version} pid ${this.#child?.process.pid} on ${this.baseUrl}`);
      return descriptor;
    } catch (error) {
      this.#setState("stopped");
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** SIGTERM to T3's process group, SIGKILL after `stopTimeoutMs`; resolves once no group member is left. */
  async stop(): Promise<void> {
    if (this.#state === "stopped" && this.#child === undefined) return;
    this.#stop.abort();
    await this.#recovering;
    const child = this.#child;
    if (child !== undefined) await this.#terminate(child, this.#timing.stopTimeoutMs);
    this.#child = undefined;
    await rm(join(this.#settings.runtimeDir, SUPERVISED_FILE), { force: true });
    const wasRunning = this.#state !== "stopped";
    this.#setState(this.#state === "failed" ? "failed" : "stopped");
    if (wasRunning) this.#log("info", "t3.runtime.stopped");
  }

  /** Spawns T3 and waits until it is ready; on any failure the child's group is killed before rethrowing. */
  async #launch(): Promise<T3EnvironmentDescriptor> {
    if (await loopbackPortAnswers(this.#settings.port)) throw new T3PortInUseError(this.#settings.port);
    const { homeDir, port } = this.#settings;
    let spawned: T3ChildProcess;
    try {
      spawned = this.#spawn(
        [this.#installed.binary, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", homeDir],
        { cwd: homeDir, env: managedT3Environment(this.#env, homeDir) },
      );
    } catch (error) {
      throw new T3StartupError(`could not start ${this.#installed.binary}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const child: RunningChild = { process: spawned, exit: undefined, stderrDone: this.#pumpStderr(spawned.stderr) };
    this.#child = child;
    void spawned.exited.then((exit) => this.#onExit(child, exit));
    try {
      await writeJsonAtomically(join(this.#settings.runtimeDir, SUPERVISED_FILE), {
        pid: spawned.pid,
        binary: this.#installed.binary,
        homeDir,
        port,
        startedAt: this.#now().toISOString(),
      });
      const descriptor = await this.#waitUntilReady(child);
      this.#startedAt = this.#now().toISOString();
      await this.#recordVersionStarted();
      return descriptor;
    } catch (error) {
      await this.#terminate(child, this.#timing.stopTimeoutMs);
      if (this.#child === child) this.#child = undefined;
      throw error;
    }
  }

  async #waitUntilReady(child: RunningChild): Promise<T3EnvironmentDescriptor> {
    const deadline = this.#now().getTime() + this.#timing.readyTimeoutMs;
    const runtimeFile = join(this.#settings.homeDir, "userdata", "server-runtime.json");
    for (;;) {
      if (this.#stop.signal.aborted) throw new T3StartupError("managed T3 start was cancelled");
      if (child.exit !== undefined) {
        // A descendant left in the group may still hold stderr open; it belongs to a dead server.
        signalProcessGroup(child.process.pid, "SIGKILL");
        await this.#drainStderr(child);
        throw new T3StartupError(
          `managed T3 exited with ${describeExit(child.exit)} before becoming ready${this.#stderrSummary()}`,
        );
      }
      let descriptor: T3EnvironmentDescriptor | undefined;
      try {
        descriptor = await fetchT3EnvironmentDescriptor({
          baseUrl: this.baseUrl,
          signal: AbortSignal.timeout(2_000),
          ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        });
      } catch {
        descriptor = undefined;
      }
      if (descriptor !== undefined) {
        const problem = t3DescriptorProblem(descriptor, { pinnedVersion: this.#installed.version });
        if (problem !== undefined) throw problem;
        const runtime = await readJson(runtimeFile, serverRuntimeSchema);
        if (runtime?.pid === child.process.pid) return descriptor;
      }
      if (this.#now().getTime() >= deadline) {
        throw new T3StartupError(
          `managed T3 did not become ready on ${this.baseUrl} within ${Math.round(this.#timing.readyTimeoutMs / 1000)}s${this.#stderrSummary()}`,
        );
      }
      await this.#sleep(this.#timing.readyPollMs, this.#stop.signal);
    }
  }

  #onExit(child: RunningChild, exit: { readonly code: number | null; readonly signal: string | null }): void {
    child.exit = exit;
    if (this.#child !== child || this.#stop.signal.aborted || this.#state !== "ready") return;
    // Only a ready runtime's exit is a crash here; exits while starting surface from #waitUntilReady.
    this.#lastExit = describeExit(exit);
    this.#log("warn", "t3.runtime.exited", `${this.#lastExit}${this.#stderrSummary()}`);
    // Anything T3 left behind in its group belongs to a dead server.
    signalProcessGroup(child.process.pid, "SIGKILL");
    this.#child = undefined;
    this.#recovering = this.#recover().finally(() => {
      this.#recovering = undefined;
    });
  }

  async #recover(): Promise<void> {
    for (;;) {
      if (this.#stop.signal.aborted) return;
      const now = this.#now().getTime();
      this.#restartTimes = this.#restartTimes.filter((time) => now - time < this.#timing.crashWindowMs);
      if (this.#restartTimes.length >= this.#timing.maxRestarts) {
        this.#fail(
          new T3CrashLoopError(
            `managed T3 crashed after ${this.#restartTimes.length} restarts within ${Math.round(this.#timing.crashWindowMs / 60_000)} min (last: ${this.#lastExit ?? "unknown"}); giving up so the service manager can restart Agent Tag`,
          ),
        );
        return;
      }
      const delay = Math.min(this.#timing.backoffBaseMs * 2 ** this.#restartTimes.length, this.#timing.backoffMaxMs);
      this.#setState("restarting");
      await this.#sleep(delay, this.#stop.signal);
      if (this.#stop.signal.aborted) return;
      this.#restartTimes.push(this.#now().getTime());
      this.#restarts += 1;
      try {
        await this.#launch();
        this.#setState("ready");
        this.#log("info", "t3.runtime.restarted", `pid ${this.#child?.process.pid} after ${delay} ms backoff`, this.#restarts);
        return;
      } catch (error) {
        if (this.#stop.signal.aborted) return;
        if (error instanceof T3ProtocolMismatchError || error instanceof T3ServerVersionMismatchError || error instanceof T3PortInUseError) {
          this.#fail(error);
          return;
        }
        this.#lastExit = error instanceof Error ? error.message : String(error);
        this.#log("warn", "t3.runtime.restart_failed", this.#lastExit);
      }
    }
  }

  #fail(error: Error): void {
    this.#fatalError = error;
    this.#setState("failed");
    this.#log("warn", "t3.runtime.crashloop", error.message);
    for (const listener of this.#fatalListeners) listener(error);
  }

  /** SIGTERM the group, wait for the leader, then SIGKILL whatever is left of the group. */
  async #terminate(child: RunningChild, timeoutMs: number): Promise<void> {
    const pid = child.process.pid;
    if (child.exit === undefined) signalProcessGroup(pid, "SIGTERM");
    const exited = await Promise.race([
      child.process.exited.then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
    if (!exited) {
      this.#log("warn", "t3.runtime.kill", `pid ${pid} ignored SIGTERM for ${timeoutMs} ms; sending SIGKILL`);
    }
    // Descendants (provider sessions) may outlive the leader; give them a moment, then SIGKILL the group.
    for (let attempt = 0; attempt < 20 && signalProcessGroup(pid, 0); attempt += 1) await Bun.sleep(50);
    signalProcessGroup(pid, "SIGKILL");
    await child.process.exited;
    await this.#drainStderr(child);
  }

  /** Waits for the stderr pump, bounded: a process that left T3's group can hold the pipe open forever. */
  async #drainStderr(child: RunningChild): Promise<void> {
    await Promise.race([child.stderrDone, Bun.sleep(STDERR_DRAIN_MS)]);
  }

  /**
   * A previous Agent Tag that was SIGKILLed leaves its `t3 serve` running. A pid recorded in our
   * `supervised.json` or T3's `server-runtime.json` is reaped only when its command line is
   * `... serve ... --base-dir <homeDir>`: our own home dir, which nothing else may use. Any other pid
   * (a recycled one, a foreign server) is left alone; a foreign server then fails the port check.
   */
  async #reapOrphans(): Promise<void> {
    const pids = new Set<number>();
    for (const [path, schema] of [
      [join(this.#settings.runtimeDir, SUPERVISED_FILE), supervisedSchema],
      [join(this.#settings.homeDir, "userdata", "server-runtime.json"), serverRuntimeSchema],
    ] as const) {
      const record = await readJson(path, schema);
      if (record !== undefined && record.pid !== process.pid) pids.add(record.pid);
    }
    for (const pid of pids) {
      if (!processAlive(pid)) continue;
      const args = await this.#processArgs(pid);
      if (args === undefined || !isManagedServeCommand(args, { homeDir: this.#settings.homeDir, runtimeDir: this.#settings.runtimeDir, binary: this.#installed.binary })) continue;
      this.#log("warn", "t3.runtime.orphan_reaped", `pid ${pid} from a previous Agent Tag run`);
      signalProcessGroup(pid, "SIGTERM");
      const deadline = Date.now() + this.#timing.orphanTimeoutMs;
      while (processAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
      signalProcessGroup(pid, "SIGKILL");
      while (processAlive(pid) && Date.now() < deadline + 2_000) await Bun.sleep(50);
    }
    if (pids.size > 0) {
      // A reaped server releases its port asynchronously.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await loopbackPortAnswers(this.#settings.port))) await Bun.sleep(100);
    }
  }

  /** T3 migrates its database forward only: never start an older T3 against a home a newer one used. */
  async #assertNoDowngrade(): Promise<void> {
    const state = await readJson(join(this.#settings.runtimeDir, "state.json"), runtimeStateSchema);
    const highest = state?.highestVersionStarted;
    if (highest !== undefined && compareVersions(highest, this.#installed.version) > 0) {
      throw new T3DowngradeError(
        `refusing to start T3 ${this.#installed.version}: T3 ${highest} already ran against ${this.#settings.homeDir} and migrates its database forward only; keep the newer Agent Tag or point t3.homeDir at a fresh directory`,
      );
    }
  }

  async #recordVersionStarted(): Promise<void> {
    const path = join(this.#settings.runtimeDir, "state.json");
    const state = (await readJson(path, runtimeStateSchema)) ?? {};
    const highest = state.highestVersionStarted;
    if (highest !== undefined && compareVersions(highest, this.#installed.version) >= 0) return;
    await writeJsonAtomically(path, { ...state, highestVersionStarted: this.#installed.version });
  }

  async #pumpStderr(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (stream === null) return;
    const decoder = new TextDecoder();
    let pending = "";
    let truncating = false;
    try {
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline === -1) {
            if (pending.length > STDERR_LINE_BYTES) {
              if (!truncating) this.#stderrLine(`${pending.slice(0, STDERR_LINE_BYTES)}…`);
              truncating = true;
              pending = "";
            }
            break;
          }
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!truncating) this.#stderrLine(line.length > STDERR_LINE_BYTES ? `${line.slice(0, STDERR_LINE_BYTES)}…` : line);
          truncating = false;
        }
      }
      if (pending.length > 0 && !truncating) this.#stderrLine(pending.slice(0, STDERR_LINE_BYTES));
    } catch {
      // The pipe closes with the process; nothing to report.
    }
  }

  #stderrLine(raw: string): void {
    const line = redactT3Output(raw.replace(/\r$/, "")).trimEnd();
    if (line.length === 0) return;
    this.#stderrTail.push(line);
    if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    const now = this.#now().getTime();
    if (now - this.#stderrWindowStart >= 60_000) {
      if (this.#stderrDropped > 0) this.#log("warn", "t3.runtime.stderr_dropped", undefined, this.#stderrDropped);
      this.#stderrWindowStart = now;
      this.#stderrWindowCount = 0;
      this.#stderrDropped = 0;
    }
    if (this.#stderrWindowCount >= STDERR_LINES_PER_MINUTE) {
      this.#stderrDropped += 1;
      return;
    }
    this.#stderrWindowCount += 1;
    this.#log("info", "t3.runtime.stderr", line);
  }

  #stderrSummary(): string {
    return this.#stderrTail.length === 0 ? "" : `; last T3 stderr:\n${this.#stderrTail.join("\n")}`;
  }

  #setState(state: T3RuntimeState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  #log(level: ServiceLogRecord["level"], event: string, detail?: string, count?: number): void {
    this.#logger({
      level,
      event,
      at: this.#now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
      ...(count === undefined ? {} : { count }),
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True for `<our t3> serve ... --base-dir <homeDir>`: the executable must be the installed binary or
 * another pinned install under `<runtimeDir>/versions/<version>/t3` (an orphan from before an
 * upgrade), and the base dir must be our own home. A foreign executable with the same arguments is
 * never ours.
 */
export function isManagedServeCommand(
  args: string,
  owner: { readonly homeDir: string; readonly runtimeDir: string; readonly binary: string },
): boolean {
  const executable = new RegExp(`^(?:${escapeRegExp(owner.binary)}|${escapeRegExp(owner.runtimeDir)}/versions/[^/\\s]+/t3) serve(?: |$)`);
  return executable.test(args) && ` ${args} `.includes(` --base-dir ${owner.homeDir} `);
}

/**
 * The binary managed mode runs: installed (download + verify) when `autoInstall`, otherwise an
 * existing verified install, or an actionable error.
 */
export async function prepareManagedT3Binary(input: {
  readonly settings: ResolvedManagedT3;
  readonly pin: T3Pin;
  readonly logger: ServiceLogger;
  readonly now?: () => Date;
}): Promise<ManagedT3Binary> {
  const { settings, pin } = input;
  const now = input.now ?? (() => new Date());
  if (settings.autoInstall) {
    return installPinnedT3({
      pin,
      runtimeDir: settings.runtimeDir,
      ...(settings.downloadBaseUrl === undefined ? {} : { downloadBaseUrl: settings.downloadBaseUrl }),
      log: (event, detail) => input.logger({ level: "info", event, at: now().toISOString(), detail }),
    });
  }
  const status = await inspectInstalledT3({ pin, runtimeDir: settings.runtimeDir });
  if (!status.filesVerified || status.binary === null || status.version === null) {
    throw new Error(
      `managed T3 ${pin.version} is not installed and verified in ${settings.runtimeDir}${status.problem === null ? "" : ` (${status.problem})`}; run \`agent-tag t3 install CONFIG\` or set t3.autoInstall to true`,
    );
  }
  return { binary: status.binary, version: status.version };
}
