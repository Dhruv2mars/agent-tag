import { ProviderSelectionError } from "../policy/provider.ts";
import type { ServiceLogger } from "../service.ts";
import {
  type EnvironmentFetch,
  fetchT3EnvironmentDescriptor,
  T3EnvironmentRequestError,
  T3EnvironmentUnavailableError,
} from "./protocol.ts";

/** Progress of the startup wait, persisted so `agent-tag status` and doctor can report it. */
export interface T3StartupWait {
  readonly baseUrl: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly nextAttemptAt: string;
}

export const T3_STARTUP_INITIAL_DELAY_MS = 1_000;
export const T3_STARTUP_MAX_DELAY_MS = 60_000;

/** Connection failures and 5xx answers: T3 is down or still starting, so waiting can fix it. */
function transientT3Error(error: unknown): error is Error {
  return error instanceof T3EnvironmentRequestError
    || (error instanceof T3EnvironmentUnavailableError && error.status >= 500);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("startup aborted", "AbortError");
}

function sleepOrAbort(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface StartupWaitInput {
  readonly baseUrl: string;
  readonly logger: ServiceLogger;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly onWaiting?: (wait: T3StartupWait) => void | Promise<void>;
}

/**
 * Runs `attempt` until it stops throwing a `transient` error, sleeping 1 s doubling to 60 s between
 * tries and reporting each wait through the logger and `onWaiting`. Rejects only when `signal`
 * aborts or `attempt` throws something that is not transient.
 */
async function retryWhileTransient<T>(
  input: StartupWaitInput & {
    readonly attempt: () => Promise<T>;
    readonly transient: (error: unknown) => error is Error;
    readonly describe: (error: Error) => string;
    /** Logged when an attempt succeeds after at least one wait. */
    readonly recoveredEvent: string;
  },
): Promise<{ readonly value: T; readonly attempts: number }> {
  const sleep = input.sleep ?? sleepOrAbort;
  let delay = T3_STARTUP_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    if (input.signal?.aborted) throw abortError(input.signal);
    let value: T;
    try {
      value = await input.attempt();
    } catch (error) {
      if (!input.transient(error)) throw error;
      const nextAttemptAt = new Date(input.now().getTime() + delay).toISOString();
      const wait = { baseUrl: input.baseUrl, attempts: attempt, lastError: error.message, nextAttemptAt };
      input.logger({
        level: "warn",
        event: "t3.startup.waiting",
        at: input.now().toISOString(),
        count: attempt,
        errorCode: error.name,
        detail: `${input.describe(error)}; retrying in ${Math.round(delay / 1_000)} s`,
      });
      await input.onWaiting?.(wait);
      await sleep(delay, input.signal);
      delay = Math.min(delay * 2, T3_STARTUP_MAX_DELAY_MS);
      continue;
    }
    if (attempt > 1) {
      input.logger({ level: "info", event: input.recoveredEvent, at: input.now().toISOString(), count: attempt });
    }
    return { value, attempts: attempt };
  }
}

/**
 * Waits until T3 answers `/.well-known/t3/environment`, retrying connection failures with exponential
 * backoff (1 s doubling to 60 s). Under launchd/systemd a failed start would just be respawned, so a
 * missing T3 used to become a tight crash loop; waiting in-process instead keeps one quiet process that
 * starts serving as soon as T3 is back. Any other answer (an incompatible protocol, a 404) returns at
 * once: the caller's `inspectT3` then fails with the precise error. Rejects only when `signal` aborts.
 */
export async function waitForReachableT3(
  input: StartupWaitInput & { readonly fetch?: EnvironmentFetch; readonly timeoutMs?: number },
): Promise<{ readonly attempts: number }> {
  const { attempts } = await retryWhileTransient({
    ...input,
    attempt: async () => {
      try {
        await fetchT3EnvironmentDescriptor({
          baseUrl: input.baseUrl,
          signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        });
      } catch (error) {
        if (transientT3Error(error)) throw error;
      }
    },
    transient: transientT3Error,
    describe: (error) => `T3 is not reachable at ${input.baseUrl} (${error.message})`,
    recoveredEvent: "t3.startup.reachable",
  });
  return { attempts };
}

/**
 * Inspects T3 until every configured provider and model is runnable, then returns that catalog. A
 * T3 that just started reports its providers from a cache and re-probes them over the next seconds
 * (slower on a loaded machine), so the first catalog can say codex "is not enabled and installed" or
 * "reports error" for a provider that is fine a moment later. Exiting on that only had the service
 * manager respawn us, restart managed T3, and hit the same race; waiting here keeps the process up,
 * and a provider that never becomes runnable shows in `agent-tag status` and doctor. Other inspection
 * errors still reject.
 */
export async function waitForRunnableProviders<T>(
  input: StartupWaitInput & { readonly inspect: () => Promise<T>; readonly validate: (server: T) => void },
): Promise<T> {
  const { value } = await retryWhileTransient({
    ...input,
    attempt: async () => {
      const server = await input.inspect();
      input.validate(server);
      return server;
    },
    transient: (error): error is ProviderSelectionError => error instanceof ProviderSelectionError,
    describe: (error) => `T3 at ${input.baseUrl} cannot run the configured models yet (${error.message})`,
    recoveredEvent: "t3.startup.providers-ready",
  });
  return value;
}
