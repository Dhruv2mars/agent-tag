import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { type CommandRunner, runCommand } from "../command.ts";
import type { ResolvedT3Config, T3RotationConfig } from "../config.ts";
import { readSecretFile, replaceSecretFile, SecretString } from "../security/secret-file.ts";
import type { ServiceLogger, ServiceLogRecord, ServiceWorker } from "../service.ts";
import { issueT3AdminSession, revokeT3AdminSession } from "./admin-session.ts";
import {
  assertRestrictedOrchestrationSession,
  expectAdministrativeAccessDenied,
  inspectT3Session,
  isT3CredentialRejection,
  listT3AuthClients,
  mintRestrictedT3Token,
  revokeT3AuthClient,
  type T3AuthClient,
} from "./auth.ts";
import { redactT3Output } from "./supervisor.ts";

/** `<runtimeDir>/credential-state.json`: current label, last rotation, replaced tokens awaiting revocation. */
export const T3_CREDENTIAL_STATE_FILE = "credential-state.json";

/** Every restricted token Agent Tag mints carries this label prefix plus a UTC timestamp. */
export const T3_ORCHESTRATION_LABEL_PREFIX = "agent-tag-orchestration-";
const ADMIN_ROTATE_LABEL = "agent-tag-rotate";
const ADMIN_REVOKE_LABEL = "agent-tag-revoke";

const DAY_MS = 86_400_000;
/** Expiry is re-checked this often; a rejection reported by the T3 connection triggers a check at once. */
export const T3_TOKEN_CHECK_INTERVAL_MS = 6 * 3_600_000;
/** A failed check or rotation is retried after this long, and rejection-driven rotations are capped to one per window. */
export const T3_TOKEN_RETRY_MS = 5 * 60_000;
/** External mode warns at this many days left and logs an error at `EXTERNAL_ERROR_DAYS`. */
export const EXTERNAL_WARN_DAYS = 7;
export const EXTERNAL_ERROR_DAYS = 1;
const LOCK_TIMEOUT_MS = 30_000;
/** Replaced tokens past their grace period are looked for this often. */
const REVOKE_CHECK_INTERVAL_MS = 60_000;
/** An unconfirmed revocation is retried with backoff (1, 2, 4, 8, 16 min), then left to expire. */
export const MAX_REVOKE_ATTEMPTS = 6;
/** Every T3 request and admin command in the lifecycle is bounded by this deadline. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Where a short-lived administrative credential comes from. */
export type T3AdminSource =
  /** `t3 auth session issue|revoke --base-dir` (managed mode, or external with --t3-base-dir). */
  | { readonly kind: "cli"; readonly t3Bin: string; readonly baseDir: string; readonly run: CommandRunner }
  /** An operator-supplied admin token (external mode, --admin-token-file); never revoked by us. */
  | { readonly kind: "token"; readonly token: SecretString };

const retiredSchema = z.object({
  /** The label of the replaced token; absent when it was minted outside Agent Tag (e.g. `enroll:t3`). */
  label: z.string().min(1).optional(),
  /** The replaced token's expiry, which identifies an unlabeled client in `/api/auth/clients`. */
  expiresAt: z.string().min(1).optional(),
  retiredAt: z.iso.datetime(),
  /** Revocation passes that could not confirm the revoke; retried with backoff up to `MAX_REVOKE_ATTEMPTS`. */
  attempts: z.number().int().min(0).optional(),
  /** When the next attempt is due: the last unconfirmed attempt plus its backoff. */
  nextAttemptAt: z.iso.datetime().optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  currentLabel: z.string().min(1).nullable(),
  rotatedAt: z.iso.datetime().nullable(),
  rotationReason: z.string().nullable().default(null),
  retired: z.array(retiredSchema),
});

export type T3CredentialState = z.infer<typeof stateSchema>;
type Retired = z.infer<typeof retiredSchema>;

const EMPTY_STATE: T3CredentialState = { version: 1, currentLabel: null, rotatedAt: null, rotationReason: null, retired: [] };

export interface T3TokenExpiry {
  readonly expiresAt: string;
  readonly daysRemaining: number;
}

export type T3RotationReason = "missing" | "rejected" | "expiring" | "manual";

export interface T3CredentialLifecycleOptions {
  readonly mode: "managed" | "external";
  readonly baseUrl: string;
  readonly tokenFile: string;
  /** Managed rotation thresholds; external mode warns at `EXTERNAL_WARN_DAYS` instead. */
  readonly rotation?: T3RotationConfig;
  /** Needed to enroll, rotate and revoke; external mode without it only reports expiry. */
  readonly admin?: T3AdminSource;
  /** `credential-state.json` (0600, in a 0700 dir); without it no replaced token is revoked later. */
  readonly stateFile?: string;
  /** The exact command an external operator runs to rotate, quoted in expiry logs. */
  readonly rotateCommand?: string;
  readonly logger: ServiceLogger;
  readonly now?: () => Date;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

/** Error text for logs, scrubbed of anything credential-shaped as defense in depth. */
function errorMessage(error: unknown): string {
  return redactT3Output(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `agent-tag-orchestration-20261010T030512Z-1a2b3c`: the random suffix keeps every label unique, so
 * the current-label guard never shields a replaced token minted in the same second.
 */
export function t3OrchestrationLabel(at: Date, suffix: string = randomBytes(3).toString("hex")): string {
  return `${T3_ORCHESTRATION_LABEL_PREFIX}${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${suffix}`;
}

/** Bounds a request by `REQUEST_TIMEOUT_MS` and, when given, the caller's (service shutdown) signal. */
function deadline(signal?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** When a replaced token is next due for a revocation attempt: after its grace period, then per its backoff. */
function revokeDueAt(entry: Retired, graceMs: number): number {
  return entry.nextAttemptAt === undefined ? Date.parse(entry.retiredAt) + graceMs : Date.parse(entry.nextAttemptAt);
}

/** Backoff after the `attempts`-th unconfirmed revoke: 1, 2, 4, 8, 16 minutes. */
const revokeBackoffMs = (attempts: number) => 2 ** (attempts - 1) * 60_000;

const sameRetired = (a: Retired, b: Retired) => a.retiredAt === b.retiredAt && a.label === b.label && a.expiresAt === b.expiresAt;

export function t3TokenExpiry(expiresAt: string, now: Date): T3TokenExpiry {
  return { expiresAt, daysRemaining: Math.round(((Date.parse(expiresAt) - now.getTime()) / DAY_MS) * 10) / 10 };
}

export async function readT3CredentialState(path: string): Promise<T3CredentialState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw error;
  }
  try {
    return stateSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`T3 credential state ${path} is not readable; delete it to start over (replaced tokens then expire on their own)`);
  }
}

/**
 * True when `client` is the replaced token described by `retired`: same Agent Tag label, never the
 * current session or label. A token minted outside Agent Tag (no recorded label) never matches,
 * since expiry and scopes do not identify a client; it expires on its own.
 */
export function isRetiredT3Client(client: T3AuthClient, retired: Retired, currentLabel: string | null): boolean {
  if (client.current === true) return false;
  if (retired.label === undefined || !retired.label.startsWith(T3_ORCHESTRATION_LABEL_PREFIX)) return false;
  const label = client.client?.label;
  return label !== undefined && label !== currentLabel && label === retired.label;
}

/**
 * The restricted T3 token's lifecycle (PR-O B10): enroll when missing or rejected, rotate before
 * expiry, and revoke the replaced token after a grace period. Admin tokens live in memory only and
 * are revoked in `finally`; no token appears in a log record or error message.
 */
export class T3CredentialLifecycle {
  readonly #options: T3CredentialLifecycleOptions;
  readonly #now: () => Date;
  #nextCheckAt = 0;
  #nextRevokeAt = 0;
  #rejected = false;
  #lastRejectedRotationAt = Number.NEGATIVE_INFINITY;

  constructor(options: T3CredentialLifecycleOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get mode(): "managed" | "external" {
    return this.#options.mode;
  }

  /** Called by the T3 connection when T3 rejects the token; the next maintenance pass acts on it. */
  noteRejected(): void {
    this.#rejected = true;
  }

  /** The current token's expiry; throws (a credential rejection, or an outage) when it cannot be read. */
  async check(signal?: AbortSignal): Promise<T3TokenExpiry> {
    const token = await readSecretFile(this.#options.tokenFile);
    const session = await inspectT3Session({ baseUrl: this.#options.baseUrl, token, signal: deadline(signal) });
    assertRestrictedOrchestrationSession(session);
    return t3TokenExpiry(session.expiresAt, this.#now());
  }

  /**
   * Managed startup, after the runtime is ready: keeps a valid restricted token, otherwise mints one.
   * An unreachable T3 throws; it never causes a rotation.
   */
  async ensureToken(signal?: AbortSignal): Promise<"kept" | "enrolled"> {
    let reason: T3RotationReason | undefined;
    try {
      await this.check(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reason = "missing";
      else if (isT3CredentialRejection(error)) reason = "rejected";
      else throw error;
    }
    if (reason === undefined) return "kept";
    await this.rotate(reason, signal);
    return "enrolled";
  }

  /**
   * Mints a new restricted token, writes it atomically over the token file, and records the replaced
   * one for revocation after `revokeGraceMinutes`. Running turns keep using the old token until then.
   */
  async rotate(reason: T3RotationReason, signal?: AbortSignal): Promise<T3TokenExpiry & { readonly label: string }> {
    const admin = this.#options.admin;
    if (admin === undefined) throw new Error("rotating the T3 token needs an administrative credential");
    const { baseUrl } = this.#options;
    try {
      const result = await this.#withLock(signal, async () => {
        const previous = await this.#previousToken(signal);
        const label = t3OrchestrationLabel(this.#now());
        const expiry = await this.#withAdmin(admin, ADMIN_ROTATE_LABEL, signal, async (administrativeToken) => {
          const token = await mintRestrictedT3Token({ baseUrl, administrativeToken, label, signal: deadline(signal) });
          const session = await inspectT3Session({ baseUrl, token, signal: deadline(signal) });
          assertRestrictedOrchestrationSession(session);
          await expectAdministrativeAccessDenied({ baseUrl, token, signal: deadline(signal) });
          await mkdir(dirname(this.#options.tokenFile), { recursive: true, mode: 0o700 });
          await replaceSecretFile({ path: this.#options.tokenFile, secret: token });
          return t3TokenExpiry(session.expiresAt, this.#now());
        });
        await this.#recordRotation(label, reason, previous);
        return { ...expiry, label };
      });
      this.#log({
        level: "info",
        event: "t3.token.rotated",
        outcome: reason,
        detail: `label ${result.label}; expires ${result.expiresAt}`,
      });
      return result;
    } catch (error) {
      this.#log({ level: "warn", event: "t3.token.rotate_failed", outcome: reason, errorCode: errorName(error), detail: errorMessage(error) });
      throw error;
    }
  }

  /**
   * One maintenance pass: expiry check (every 6 h, or at once after a rejection), rotation or an
   * expiry warning, then revocation of replaced tokens whose grace period is over.
   */
  async maintain(signal?: AbortSignal): Promise<string> {
    const nowMs = this.#now().getTime();
    let outcome = "idle";
    const rejectionDue = this.#rejected && nowMs - this.#lastRejectedRotationAt >= T3_TOKEN_RETRY_MS;
    if (rejectionDue || nowMs >= this.#nextCheckAt) {
      this.#rejected = false;
      outcome = await this.#checkAndRotate(nowMs, signal);
    }
    if (nowMs < this.#nextRevokeAt || signal?.aborted) return outcome;
    this.#nextRevokeAt = nowMs + REVOKE_CHECK_INTERVAL_MS;
    const revoked = await this.revokeRetired(signal);
    return revoked > 0 ? "t3-token-revoked" : outcome;
  }

  async #checkAndRotate(nowMs: number, signal?: AbortSignal): Promise<string> {
    const { mode } = this.#options;
    let reason: T3RotationReason | undefined;
    let expiry: T3TokenExpiry | undefined;
    try {
      expiry = await this.check(signal);
      const expiring = mode === "managed"
        ? expiry.daysRemaining < (this.#options.rotation?.rotateBeforeDays ?? 7)
        : expiry.daysRemaining <= EXTERNAL_WARN_DAYS;
      if (expiring) reason = "expiring";
    } catch (error) {
      if (!isT3CredentialRejection(error) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        // T3 is unreachable (or the gate closed under us): try again soon, never rotate blind.
        this.#nextCheckAt = nowMs + T3_TOKEN_RETRY_MS;
        return "idle";
      }
      reason = isT3CredentialRejection(error) ? "rejected" : "missing";
    }
    this.#nextCheckAt = nowMs + T3_TOKEN_CHECK_INTERVAL_MS;
    if (reason === undefined) return "idle";
    if (mode === "external" || this.#options.admin === undefined) {
      this.#warnExternal(reason, expiry);
      return "t3-token-expiring";
    }
    if (reason === "rejected") {
      if (nowMs - this.#lastRejectedRotationAt < T3_TOKEN_RETRY_MS) return "idle";
      this.#lastRejectedRotationAt = nowMs;
    }
    try {
      await this.rotate(reason, signal);
      return "t3-token-rotated";
    } catch {
      this.#nextCheckAt = nowMs + T3_TOKEN_RETRY_MS;
      return "t3-token-rotate-failed";
    }
  }

  #warnExternal(reason: T3RotationReason, expiry: T3TokenExpiry | undefined): void {
    const command = this.#options.rotateCommand ?? "agent-tag t3 rotate CONFIG --admin-token-file FILE";
    const severe = expiry === undefined || expiry.daysRemaining <= EXTERNAL_ERROR_DAYS;
    const what = expiry === undefined
      ? reason === "missing" ? "the T3 token file is missing" : "T3 rejected the token"
      : `the T3 token expires in ${expiry.daysRemaining} days (${expiry.expiresAt})`;
    this.#log({
      level: severe ? "error" : "warn",
      event: "t3.token.expiring",
      outcome: reason,
      detail: `${what}; rotate it with \`${command}\``,
    });
  }

  /**
   * Revokes replaced tokens whose grace period is over; returns how many clients were revoked. An
   * entry leaves the state once its revoke is confirmed (or its client is already gone); an
   * unconfirmed revoke is retried with backoff and, after `MAX_REVOKE_ATTEMPTS`, left to expire.
   */
  async revokeRetired(signal?: AbortSignal): Promise<number> {
    const { stateFile, admin, baseUrl } = this.#options;
    if (stateFile === undefined || admin === undefined) return 0;
    const graceMs = (this.#options.rotation?.revokeGraceMinutes ?? 15) * 60_000;
    const nowMs = this.#now().getTime();
    const isDue = (entry: Retired) => revokeDueAt(entry, graceMs) <= nowMs;
    if (!(await readT3CredentialState(stateFile)).retired.some(isDue)) return 0;
    try {
      return await this.#withLock(signal, async () => {
        const current = await readT3CredentialState(stateFile);
        const due = current.retired.filter(isDue);
        if (due.length === 0) return 0;
        // Tokens minted outside Agent Tag cannot be identified safely; they expire on their own.
        const unlabeled = due.filter((entry) => entry.label === undefined || !entry.label.startsWith(T3_ORCHESTRATION_LABEL_PREFIX));
        const labeled = due.filter((entry) => !unlabeled.includes(entry));
        if (unlabeled.length > 0) {
          this.#log({
            level: "warn",
            event: "t3.token.revoke_skipped",
            count: unlabeled.length,
            detail: `replaced token was not minted by Agent Tag, so it cannot be identified; it expires on its own${unlabeled[0]?.expiresAt === undefined ? "" : ` at ${unlabeled[0].expiresAt}`}`,
          });
        }
        let revoked = 0;
        let retry: Retired[] = [];
        let failed = false;
        if (labeled.length > 0) {
          try {
            await this.#withAdmin(admin, ADMIN_REVOKE_LABEL, signal, async (administrativeToken) => {
              const clients = await listT3AuthClients({ baseUrl, administrativeToken, signal: deadline(signal) });
              if (clients === undefined) {
                this.#log({
                  level: "warn",
                  event: "t3.token.revoke_skipped",
                  count: labeled.length,
                  detail: "GET /api/auth/clients returned a shape Agent Tag does not recognize; replaced tokens expire on their own",
                });
                return;
              }
              for (const entry of labeled) {
                let confirmed = true;
                for (const client of clients.filter((candidate) => isRetiredT3Client(candidate, entry, current.currentLabel))) {
                  const ok = await revokeT3AuthClient({ baseUrl, administrativeToken, sessionId: client.sessionId, signal: deadline(signal) })
                    .catch(() => false);
                  if (ok) revoked += 1;
                  else confirmed = false;
                }
                if (!confirmed) retry.push(entry);
              }
            });
          } catch (error) {
            // The admin session or T3 failed: every labeled entry is retried on a later pass.
            retry = labeled;
            failed = true;
            this.#log({ level: "warn", event: "t3.token.revoke_skipped", errorCode: errorName(error), detail: errorMessage(error) });
          }
        }
        // Backoff counts from this attempt, not from retirement, so a late pass cannot burn every retry at once.
        const failedAtMs = this.#now().getTime();
        const retried = retry.map((entry) => {
          const attempts = (entry.attempts ?? 0) + 1;
          return { ...entry, attempts, nextAttemptAt: new Date(failedAtMs + revokeBackoffMs(attempts)).toISOString() };
        });
        const exhausted = retried.filter((entry) => entry.attempts >= MAX_REVOKE_ATTEMPTS);
        // A failure was already logged above; repeat only when giving up.
        if (retry.length > 0 && (!failed || exhausted.length > 0)) {
          this.#log({
            level: "warn",
            event: "t3.token.revoke_skipped",
            count: retry.length,
            detail: exhausted.length > 0
              ? `T3 did not confirm revoking ${exhausted.length} replaced token(s) after ${MAX_REVOKE_ATTEMPTS} attempts; they expire on their own`
              : "T3 did not confirm the revoke; retrying with backoff",
          });
        }
        const latest = await readT3CredentialState(stateFile);
        await this.#writeState({
          ...latest,
          retired: [
            ...latest.retired.filter((entry) => !due.some((done) => sameRetired(done, entry))),
            ...retried.filter((entry) => entry.attempts < MAX_REVOKE_ATTEMPTS),
          ],
        });
        if (revoked > 0) this.#log({ level: "info", event: "t3.token.revoked", count: revoked });
        return revoked;
      });
    } catch (error) {
      // The lock or the state file failed; nothing changed, so a later pass retries.
      this.#log({ level: "warn", event: "t3.token.revoke_skipped", errorCode: errorName(error), detail: errorMessage(error) });
      return 0;
    }
  }

  /** The replaced token's label (from state) and expiry (best effort), for later revocation. */
  async #previousToken(signal?: AbortSignal): Promise<Retired | undefined> {
    const state = this.#options.stateFile === undefined ? EMPTY_STATE : await readT3CredentialState(this.#options.stateFile);
    let expiresAt: string | undefined;
    let exists = state.currentLabel !== null;
    try {
      const token = await readSecretFile(this.#options.tokenFile);
      exists = true;
      expiresAt = (await inspectT3Session({ baseUrl: this.#options.baseUrl, token, signal: deadline(signal) })).expiresAt;
    } catch {
      expiresAt = undefined;
    }
    if (!exists) return undefined;
    return {
      ...(state.currentLabel === null ? {} : { label: state.currentLabel }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      retiredAt: this.#now().toISOString(),
    };
  }

  async #recordRotation(label: string, reason: T3RotationReason, previous: Retired | undefined): Promise<void> {
    const { stateFile } = this.#options;
    if (stateFile === undefined) return;
    const state = await readT3CredentialState(stateFile);
    const identifiable = previous !== undefined && (previous.label !== undefined || previous.expiresAt !== undefined);
    await this.#writeState({
      version: 1,
      currentLabel: label,
      rotatedAt: this.#now().toISOString(),
      rotationReason: reason,
      retired: identifiable ? [...state.retired, previous] : state.retired,
    });
  }

  async #writeState(state: T3CredentialState): Promise<void> {
    const { stateFile } = this.#options;
    if (stateFile === undefined) return;
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    // Not a secret, but the same atomic 0600 replace keeps a crash from leaving half a file.
    await replaceSecretFile({ path: stateFile, secret: new SecretString(JSON.stringify(stateSchema.parse(state))) });
  }

  async #withAdmin<A>(
    admin: T3AdminSource,
    label: string,
    signal: AbortSignal | undefined,
    use: (token: SecretString) => Promise<A>,
  ): Promise<A> {
    if (admin.kind === "token") return use(admin.token);
    const issued = await issueT3AdminSession({ t3Bin: admin.t3Bin, baseDir: admin.baseDir, label, run: admin.run, signal: deadline(signal) });
    try {
      return await use(issued.token);
    } finally {
      try {
        // Cleanup gets its own deadline, so it still runs (bounded) when the caller was aborted.
        await revokeT3AdminSession({
          t3Bin: admin.t3Bin, baseDir: admin.baseDir, sessionId: issued.sessionId, run: admin.run, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        this.#log({
          level: "warn",
          event: "t3.token.admin_revoke_failed",
          errorCode: errorName(error),
          detail: `admin session ${issued.sessionId} expires on its own in 10 minutes`,
        });
      }
    }
  }

  /**
   * Serializes rotation and revocation across processes (the service and `agent-tag t3 rotate`). The
   * lock file is published complete with `link(2)`, so it always names its owner; a lock whose owner
   * is dead is reclaimed by renaming it aside, and only the owner removes it.
   */
  async #withLock<A>(signal: AbortSignal | undefined, work: () => Promise<A>): Promise<A> {
    const { stateFile } = this.#options;
    if (stateFile === undefined) return work();
    const lockPath = `${stateFile}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(8).toString("hex");
    const owner = `${process.pid}:${nonce}`;
    const draft = `${lockPath}.${nonce}.tmp`;
    await writeFile(draft, owner, { mode: 0o600, flag: "wx" });
    const deadlineAt = Date.now() + LOCK_TIMEOUT_MS;
    try {
      while (true) {
        try {
          await link(draft, lockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const content = await readFile(lockPath, "utf8").catch(() => undefined);
        if (content === undefined) continue;
        signal?.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new Error(`another Agent Tag process (pid ${content.split(":")[0]}) is rotating the T3 token`);
        if (lockOwnerAlive(content)) await Bun.sleep(100);
        else await reclaimStaleLock(lockPath, content, draft);
      }
    } finally {
      await rm(draft, { force: true });
    }
    try {
      return await work();
    } finally {
      if ((await readFile(lockPath, "utf8").catch(() => undefined)) === owner) await rm(lockPath, { force: true });
    }
  }

  #log(record: Omit<ServiceLogRecord, "at">): void {
    this.#options.logger({ ...record, at: this.#now().toISOString() } as ServiceLogRecord);
  }
}

/** Whether a lock file's `pid:nonce` owner is a running process. */
function lockOwnerAlive(content: string): boolean {
  const pid = Number(content.split(":")[0]);
  return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
}

/**
 * Removes `path` only while it still holds `content`, whose owner is dead. Removal is guarded by an
 * exclusive slot keyed on that content: owners are unique (`pid:nonce`), so of several waiters that
 * read the same stale lock exactly one may remove it, and a lock taken since is never touched. A slot
 * left by a reclaimer that died is reclaimed the same way. Exported for tests.
 */
export async function reclaimStaleLock(path: string, content: string, draft: string, depth = 0): Promise<void> {
  const slot = `${path}.reclaim-${content.replace(/[^A-Za-z0-9]/g, "_")}`;
  while (true) {
    try {
      await link(draft, slot);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readFile(slot, "utf8").catch(() => undefined);
    if (holder === undefined) continue;
    // A live waiter is reclaiming it already; the caller retries the lock.
    if (lockOwnerAlive(holder) || depth >= 4) return;
    await reclaimStaleLock(slot, holder, draft, depth + 1);
  }
  try {
    if ((await readFile(path, "utf8").catch(() => undefined)) === content) await rm(path, { force: true });
  } finally {
    await rm(slot, { force: true });
  }
}

/**
 * Maintenance worker for the credential lifecycle. It talks to T3, so it sits out while the gate is
 * closed: a token is never presented to a server that failed the version or protocol check.
 */
export function createT3CredentialWorker(input: { readonly credentials: T3CredentialLifecycle }): ServiceWorker {
  return {
    requiresT3: true,
    processNext: async (signal) => ({ kind: await input.credentials.maintain(signal) }),
  };
}

/** The managed runtime's credential lifecycle: admin sessions via the installed binary, state in `runtimeDir`. */
export function managedT3Credentials(input: {
  readonly t3: Extract<ResolvedT3Config, { readonly mode: "managed" }>;
  readonly binary: string;
  readonly logger: ServiceLogger;
  readonly now?: () => Date;
  readonly run?: CommandRunner;
}): T3CredentialLifecycle {
  const { managed } = input.t3;
  return new T3CredentialLifecycle({
    mode: "managed",
    baseUrl: input.t3.baseUrl,
    tokenFile: input.t3.tokenFile,
    rotation: managed.rotation,
    admin: { kind: "cli", t3Bin: input.binary, baseDir: managed.homeDir, run: input.run ?? runCommand },
    stateFile: join(managed.runtimeDir, T3_CREDENTIAL_STATE_FILE),
    logger: input.logger,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export interface T3TokenStatus {
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly label: string | null;
  readonly rotatedAt: string | null;
  readonly pendingRevocations: number;
  readonly problem: string | null;
}

/**
 * The `token` part of `t3 status`. Call it only after the server passed the descriptor check, since
 * it presents the restricted token. Never includes the token.
 */
export async function inspectT3TokenStatus(input: {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly stateFile?: string;
  readonly now?: () => Date;
}): Promise<T3TokenStatus> {
  const now = input.now ?? (() => new Date());
  let state = EMPTY_STATE;
  let problem: string | null = null;
  if (input.stateFile !== undefined) {
    try {
      state = await readT3CredentialState(input.stateFile);
    } catch (error) {
      problem = errorMessage(error);
    }
  }
  const recorded = { label: state.currentLabel, rotatedAt: state.rotatedAt, pendingRevocations: state.retired.length };
  try {
    const token = await readSecretFile(input.tokenFile);
    const session = await inspectT3Session({ baseUrl: input.baseUrl, token, signal: AbortSignal.timeout(5_000) });
    assertRestrictedOrchestrationSession(session);
    return { ...t3TokenExpiry(session.expiresAt, now()), ...recorded, problem };
  } catch (error) {
    return { expiresAt: null, daysRemaining: null, ...recorded, problem: problem ?? errorMessage(error) };
  }
}
