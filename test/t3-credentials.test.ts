import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRunner } from "../src/command.ts";
import type { AgentTagConfig, ResolvedT3Config } from "../src/config.ts";
import { checkT3TokenRotation } from "../src/doctor.ts";
import { SecretString } from "../src/security/secret-file.ts";
import type { ServiceLogRecord } from "../src/service.ts";
import { REQUIRED_T3_SCOPES } from "../src/t3/auth.ts";
import {
  createT3CredentialWorker,
  inspectT3TokenStatus,
  isRetiredT3Client,
  managedT3Credentials,
  readT3CredentialState,
  reclaimStaleLock,
  T3_CREDENTIAL_STATE_FILE,
  T3CredentialLifecycle,
  t3OrchestrationLabel,
  t3TokenExpiry,
} from "../src/t3/credentials.ts";
import type { T3InstallStatus } from "../src/t3/install.ts";
import { PINNED_T3 } from "../src/t3/lock.ts";
import { runT3Rotate } from "../src/t3/operator.ts";
import type { EnvironmentFetch } from "../src/t3/protocol.ts";

const DAY_MS = 86_400_000;
const LABEL_AT_START = /^agent-tag-orchestration-20261010T120000Z-[0-9a-f]{6}$/;
const START = Date.parse("2026-10-10T12:00:00.000Z");
const ADMIN_SCOPES = [
  "orchestration:read", "orchestration:operate", "terminal:operate", "review:write",
  "access:read", "access:write", "relay:read", "relay:write",
];

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function privateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-tag-t3-credentials-"));
  await chmod(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

interface FakeSession {
  readonly sessionId: string;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly label: string | undefined;
  revoked: boolean;
}

/**
 * A fake T3 auth surface: session, pairing-token, oauth/token, clients and clients/revoke, plus a
 * `CommandRunner` standing in for `t3 auth session issue|revoke`. Every token it issues is recorded
 * so a test can assert none leaks into logs, output or errors.
 */
function fakeT3(clock: { now: number }) {
  const sessions: FakeSession[] = [];
  const pairings = new Map<string, string>();
  const commands: string[][] = [];
  const failures = {
    pairing: false,
    clients: "ok" as "ok" | "unparseable" | "error",
    adminRevoke: false,
    issue: false,
    /** `{revoked:false}` for every client revoke. */
    revokeUnconfirmed: false,
    /** `t3 auth session issue` never exits unless its abort signal fires. */
    hangIssue: false,
  };
  /** Admin sessions issued and not yet revoked, and the most that were ever open at once. */
  const admins = { open: 0, maxOpen: 0 };
  let counter = 0;
  const secret = (kind: string) => `${kind}-secret-${++counter}-${crypto.randomUUID()}`;

  function add(input: { scopes: readonly string[]; expiresAt: string; label?: string }): FakeSession {
    const session: FakeSession = {
      sessionId: `session-${++counter}`,
      token: secret("token"),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      label: input.label,
      revoked: false,
    };
    sessions.push(session);
    return session;
  }

  function bearer(request: Request): FakeSession | undefined {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const session = sessions.find((candidate) => candidate.token === token);
    if (session === undefined || session.revoked || Date.parse(session.expiresAt) <= clock.now) return undefined;
    return session;
  }

  const isAdmin = (session: FakeSession | undefined) => session !== undefined && session.scopes.includes("access:write");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const caller = bearer(request);
      if (url.pathname === "/api/auth/session") {
        if (caller === undefined) return Response.json({ authenticated: false });
        return Response.json({
          authenticated: true,
          scopes: caller.scopes,
          sessionMethod: "bearer-access-token",
          expiresAt: caller.expiresAt,
        });
      }
      if (url.pathname === "/api/auth/pairing-token" && request.method === "POST") {
        if (!isAdmin(caller)) return new Response("forbidden", { status: caller === undefined ? 401 : 403 });
        if (failures.pairing) return new Response("boom", { status: 500 });
        const body = await request.json() as { label: string };
        const credential = secret("pairing");
        pairings.set(credential, body.label);
        return Response.json({ id: `pairing-${counter}`, credential, expiresAt: new Date(clock.now + 300_000).toISOString() });
      }
      if (url.pathname === "/oauth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const label = pairings.get(form.get("subject_token") ?? "");
        if (label === undefined) return new Response("bad", { status: 400 });
        pairings.delete(form.get("subject_token") ?? "");
        const session = add({ scopes: REQUIRED_T3_SCOPES, expiresAt: new Date(clock.now + 30 * DAY_MS).toISOString(), label });
        return Response.json({
          access_token: session.token,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 30 * 86_400,
          scope: REQUIRED_T3_SCOPES.join(" "),
        });
      }
      if (url.pathname === "/api/auth/clients" && request.method === "GET") {
        if (caller === undefined) return new Response("unauthorized", { status: 401 });
        if (!isAdmin(caller)) return new Response("forbidden", { status: 403 });
        if (failures.clients === "error") return new Response("boom", { status: 500 });
        if (failures.clients === "unparseable") return Response.json({ clients: [] });
        return Response.json(sessions.filter((session) => !session.revoked).map((session) => ({
          sessionId: session.sessionId,
          subject: "one-time-token",
          scopes: session.scopes,
          method: "bearer-access-token",
          client: { ...(session.label === undefined ? {} : { label: session.label }), deviceType: "desktop" },
          expiresAt: session.expiresAt,
          connected: false,
          current: session === caller,
        })));
      }
      if (url.pathname === "/api/auth/clients/revoke" && request.method === "POST") {
        if (!isAdmin(caller)) return new Response("forbidden", { status: 403 });
        const { sessionId } = await request.json() as { sessionId: string };
        const target = sessions.find((session) => session.sessionId === sessionId);
        if (target === undefined || failures.revokeUnconfirmed) return Response.json({ revoked: false });
        target.revoked = true;
        return Response.json({ revoked: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);

  const run: CommandRunner = async (command, options) => {
    commands.push([...command]);
    const action = command.slice(1, 4).join(" ");
    if (action === "auth session issue") {
      if (failures.hangIssue) {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { exitCode: 137, stdout: "", stderr: "killed" };
      }
      if (failures.issue) return { exitCode: 1, stdout: "", stderr: "issue failed" };
      // Yield so overlapping lock holders would interleave here.
      await Bun.sleep(5);
      admins.open += 1;
      admins.maxOpen = Math.max(admins.maxOpen, admins.open);
      const label = command[command.indexOf("--label") + 1];
      const admin = add({ scopes: ADMIN_SCOPES, expiresAt: new Date(clock.now + 600_000).toISOString(), ...(label === undefined ? {} : { label }) });
      return { exitCode: 0, stdout: JSON.stringify({ sessionId: admin.sessionId, token: admin.token, scopes: ADMIN_SCOPES }), stderr: "" };
    }
    if (action === "auth session revoke") {
      if (failures.adminRevoke) return { exitCode: 1, stdout: "", stderr: "revoke failed" };
      const target = sessions.find((session) => session.sessionId === command.at(-1));
      if (target !== undefined) target.revoked = true;
      admins.open -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 2, stdout: "", stderr: "unknown command" };
  };

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    sessions,
    commands,
    failures,
    admins,
    run,
    add,
    issued: () => commands.filter((command) => command[3] === "issue").length,
    adminSessions: () => sessions.filter((session) => session.scopes.includes("access:write")),
    restricted: () => sessions.filter((session) => !session.scopes.includes("access:write")),
    secrets: () => [...sessions.map((session) => session.token), ...pairings.keys()],
  };
}

type Fake = ReturnType<typeof fakeT3>;

async function setup(input: { mode?: "managed" | "external"; admin?: boolean; stateFile?: boolean } = {}) {
  const dir = await privateDir();
  const clock = { now: START };
  const t3 = fakeT3(clock);
  const logs: ServiceLogRecord[] = [];
  const tokenFile = join(dir, "secrets", "t3-token");
  const stateFile = join(dir, "runtime", T3_CREDENTIAL_STATE_FILE);
  const mode = input.mode ?? "managed";
  const lifecycle = (now: () => Date = () => new Date(clock.now)) => new T3CredentialLifecycle({
    mode,
    baseUrl: t3.baseUrl,
    tokenFile,
    rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
    ...(input.admin === false ? {} : { admin: { kind: "cli" as const, t3Bin: "/fake/t3", baseDir: join(dir, "home"), run: t3.run } }),
    ...(input.stateFile === false ? {} : { stateFile }),
    rotateCommand: "agent-tag t3 rotate CONFIG --admin-token-file FILE",
    logger: (record) => logs.push(record),
    now,
  });
  async function seedToken(session: FakeSession): Promise<void> {
    await mkdir(join(dir, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, session.token, { mode: 0o600 });
  }
  /** Seeds a token minted by Agent Tag: the token file plus its label recorded as current in state. */
  async function seedCurrent(daysLeft: number, label = `agent-tag-orchestration-20261001T000000Z-${crypto.randomUUID().slice(0, 6)}`): Promise<FakeSession> {
    const session = restrictedSession(t3, daysLeft, clock.now, label);
    await seedToken(session);
    await mkdir(join(dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, JSON.stringify({
      version: 1, currentLabel: label, rotatedAt: new Date(clock.now - DAY_MS).toISOString(), rotationReason: "missing", retired: [],
    }), { mode: 0o600 });
    return session;
  }
  function expectNoSecrets(...extra: unknown[]): void {
    const text = JSON.stringify([logs, ...extra.map((item) => item instanceof Error ? `${item.name} ${item.message} ${item.stack}` : item)]);
    for (const value of t3.secrets()) expect(text).not.toContain(value);
  }
  return { dir, clock, t3, logs, tokenFile, stateFile, lifecycle, seedToken, seedCurrent, expectNoSecrets };
}

const events = (logs: readonly ServiceLogRecord[]) => logs.map((record) => record.event);

function restrictedSession(t3: Fake, daysLeft: number, now: number, label?: string): FakeSession {
  return t3.add({ scopes: REQUIRED_T3_SCOPES, expiresAt: new Date(now + daysLeft * DAY_MS).toISOString(), ...(label === undefined ? {} : { label }) });
}

describe("labels and expiry", () => {
  test("labels are agent-tag-orchestration- plus a UTC timestamp to the second", () => {
    expect(t3OrchestrationLabel(new Date("2026-10-10T03:05:12.345Z"), "1a2b3c")).toBe("agent-tag-orchestration-20261010T030512Z-1a2b3c");
    const now = new Date(START);
    expect(t3OrchestrationLabel(now)).toMatch(/^agent-tag-orchestration-20261010T120000Z-[0-9a-f]{6}$/);
    expect(t3OrchestrationLabel(now)).not.toBe(t3OrchestrationLabel(now));
  });

  test("daysRemaining is rounded to one decimal", () => {
    expect(t3TokenExpiry(new Date(START + 3.04 * DAY_MS).toISOString(), new Date(START))).toEqual({
      expiresAt: new Date(START + 3.04 * DAY_MS).toISOString(),
      daysRemaining: 3,
    });
  });
});

describe("ensureToken", () => {
  test("a missing token enrolls a restricted token, written 0600, and revokes the admin session", async () => {
    const world = await setup();
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
    const [minted] = world.t3.restricted();
    expect(minted?.label).toMatch(LABEL_AT_START);
    expect((await readFile(world.tokenFile, "utf8")).trim()).toBe(minted?.token ?? "");
    expect((await stat(world.tokenFile)).mode & 0o777).toBe(0o600);
    expect(world.t3.adminSessions().every((session) => session.revoked)).toBe(true);
    expect(world.t3.commands.map((command) => command.slice(1, 4).join(" "))).toEqual(["auth session issue", "auth session revoke"]);
    const state = await readT3CredentialState(world.stateFile);
    expect(state).toMatchObject({ currentLabel: minted?.label, rotationReason: "missing", retired: [] });
    expect(events(world.logs)).toEqual(["t3.token.rotated"]);
    world.expectNoSecrets();
  });

  test("the admin session is revoked even when minting throws, and no token file is written", async () => {
    const world = await setup();
    world.t3.failures.pairing = true;
    const error = await world.lifecycle().ensureToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(world.t3.adminSessions()).toHaveLength(1);
    expect(world.t3.adminSessions()[0]?.revoked).toBe(true);
    expect(await stat(world.tokenFile).catch(() => null)).toBeNull();
    expect(events(world.logs)).toEqual(["t3.token.rotate_failed"]);
    world.expectNoSecrets(error);
  });

  test("a failed admin-session revoke is logged without failing the rotation", async () => {
    const world = await setup();
    world.t3.failures.adminRevoke = true;
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
    expect(events(world.logs)).toEqual(["t3.token.admin_revoke_failed", "t3.token.rotated"]);
    world.expectNoSecrets();
  });

  test("a valid restricted token is kept without issuing an admin session", async () => {
    const world = await setup();
    await world.seedToken(restrictedSession(world.t3, 20, START));
    expect(await world.lifecycle().ensureToken()).toBe("kept");
    expect(world.t3.issued()).toBe(0);
  });

  test("a revoked token is replaced", async () => {
    const world = await setup();
    const old = restrictedSession(world.t3, 20, START);
    old.revoked = true;
    await world.seedToken(old);
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
    expect((await readFile(world.tokenFile, "utf8")).trim()).not.toBe(old.token);
    expect((await readT3CredentialState(world.stateFile)).rotationReason).toBe("rejected");
  });

  test("an unreachable T3 throws and never mints", async () => {
    const world = await setup();
    await world.seedToken(restrictedSession(world.t3, 20, START));
    const lifecycle = new T3CredentialLifecycle({
      mode: "managed",
      baseUrl: "http://127.0.0.1:1",
      tokenFile: world.tokenFile,
      admin: { kind: "cli", t3Bin: "/fake/t3", baseDir: world.dir, run: world.t3.run },
      logger: (record) => world.logs.push(record),
    });
    await expect(lifecycle.ensureToken()).rejects.toThrow();
    expect(world.t3.issued()).toBe(0);
  });
});

describe("maintain", () => {
  test("managed: rotates when 3 days are left, and not at 10 days", async () => {
    const world = await setup();
    await world.seedToken(restrictedSession(world.t3, 10, START, "agent-tag-orchestration-old"));
    const lifecycle = world.lifecycle();
    expect(await lifecycle.maintain()).toBe("idle");
    expect(world.t3.issued()).toBe(0);
    world.clock.now = START + 7 * DAY_MS + 1; // past the 6 h re-check, 3 days left
    expect(await lifecycle.maintain()).toBe("t3-token-rotated");
    const state = await readT3CredentialState(world.stateFile);
    expect(state.rotationReason).toBe("expiring");
    expect(state.retired).toHaveLength(1);
    expect(state.retired[0]?.expiresAt).toBe(new Date(START + 10 * DAY_MS).toISOString());
    world.expectNoSecrets();
  });

  test("external: warns at 3 days left with the rotate command, logs an error under a day, never rotates", async () => {
    const world = await setup({ mode: "external", admin: false, stateFile: false });
    await world.seedToken(restrictedSession(world.t3, 3, START));
    const lifecycle = world.lifecycle();
    expect(await lifecycle.maintain()).toBe("t3-token-expiring");
    expect(world.logs[0]).toMatchObject({ level: "warn", event: "t3.token.expiring", outcome: "expiring" });
    expect(world.logs[0]?.detail).toContain("agent-tag t3 rotate CONFIG --admin-token-file FILE");
    expect(world.logs[0]?.detail).toContain("expires in 3 days");
    world.clock.now = START + 2.5 * DAY_MS;
    expect(await lifecycle.maintain()).toBe("t3-token-expiring");
    expect(world.logs[1]).toMatchObject({ level: "error", event: "t3.token.expiring" });
    expect(world.t3.issued()).toBe(0);
    world.expectNoSecrets();
  });

  test("external: no warning at 10 days left", async () => {
    const world = await setup({ mode: "external", admin: false, stateFile: false });
    await world.seedToken(restrictedSession(world.t3, 10, START));
    expect(await world.lifecycle().maintain()).toBe("idle");
    expect(world.logs).toEqual([]);
  });

  test("a rejection reported by the connection rotates at once, rate-limited to one per 5 minutes", async () => {
    const world = await setup();
    const first = restrictedSession(world.t3, 20, START);
    await world.seedToken(first);
    const lifecycle = world.lifecycle();
    expect(await lifecycle.maintain()).toBe("idle");

    first.revoked = true;
    lifecycle.noteRejected();
    world.clock.now = START + 60_000;
    expect(await lifecycle.maintain()).toBe("t3-token-rotated");
    expect(world.t3.issued()).toBe(1);

    // The new token is rejected too (e.g. T3 lost its auth state): no second rotation within 5 minutes.
    for (const session of world.t3.restricted()) session.revoked = true;
    lifecycle.noteRejected();
    world.clock.now = START + 120_000;
    expect(await lifecycle.maintain()).toBe("idle");
    expect(world.t3.issued()).toBe(1);

    world.clock.now = START + 60_000 + 5 * 60_000;
    expect(await lifecycle.maintain()).toBe("t3-token-rotated");
    expect(world.t3.issued()).toBe(2);
    world.expectNoSecrets();
  });

  test("an unreachable T3 never rotates and is re-checked after 5 minutes", async () => {
    const world = await setup();
    await world.seedToken(restrictedSession(world.t3, 1, START));
    const lifecycle = new T3CredentialLifecycle({
      mode: "managed",
      baseUrl: "http://127.0.0.1:1",
      tokenFile: world.tokenFile,
      rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
      admin: { kind: "cli", t3Bin: "/fake/t3", baseDir: world.dir, run: world.t3.run },
      logger: (record) => world.logs.push(record),
      now: () => new Date(world.clock.now),
    });
    expect(await lifecycle.maintain()).toBe("idle");
    expect(world.t3.issued()).toBe(0);
  });

  test("a hung admin command is killed when the service stops, so maintain returns promptly", async () => {
    const world = await setup();
    world.t3.failures.hangIssue = true;
    const controller = new AbortController();
    const worker = createT3CredentialWorker({ credentials: world.lifecycle() });
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    expect(await worker.processNext(controller.signal)).toEqual({ kind: "t3-token-rotate-failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(world.t3.admins.open).toBe(0);
    expect(await stat(`${world.stateFile}.lock`).catch(() => null)).toBeNull();
  });

  test("the worker requires the T3 gate and reports the maintenance outcome", async () => {
    const world = await setup();
    await world.seedToken(restrictedSession(world.t3, 20, START));
    const worker = createT3CredentialWorker({ credentials: world.lifecycle() });
    expect(worker.requiresT3).toBe(true);
    expect(await worker.processNext(new AbortController().signal)).toEqual({ kind: "idle" });
  });
});

describe("revocation after the grace period", () => {
  test("revokes only the replaced token, after revokeGraceMinutes", async () => {
    const world = await setup();
    const old = restrictedSession(world.t3, 20, START, "agent-tag-orchestration-20261001T000000Z");
    const unrelatedOrchestration = restrictedSession(world.t3, 20, START, "agent-tag-orchestration-20260901T000000Z");
    const browser = restrictedSession(world.t3, 20, START, "my-browser");
    await world.seedToken(old);
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(world.stateFile, JSON.stringify({
      version: 1, currentLabel: old.label, rotatedAt: new Date(START - DAY_MS).toISOString(), rotationReason: "missing", retired: [],
    }), { mode: 0o600 });

    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    const current = world.t3.restricted().at(-1);
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([
      { label: old.label, expiresAt: old.expiresAt, retiredAt: new Date(START).toISOString() },
    ]);

    world.clock.now = START + 14 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(old.revoked).toBe(false);

    world.clock.now = START + 15 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(1);
    expect(old.revoked).toBe(true);
    expect(unrelatedOrchestration.revoked).toBe(false);
    expect(browser.revoked).toBe(false);
    expect(current?.revoked).toBe(false);
    expect(world.t3.adminSessions().every((session) => session.revoked)).toBe(true);
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([]);
    expect(events(world.logs)).toEqual(["t3.token.rotated", "t3.token.revoked"]);
    world.expectNoSecrets();
  });

  test("an unlabeled legacy token is never revoked: it is logged as revoke_skipped and left to expire", async () => {
    const world = await setup();
    const legacy = restrictedSession(world.t3, 20, START);
    // Another bot whose token has the same expiry and restricted scopes must not be mistaken for it.
    const lookalike = world.t3.add({ scopes: REQUIRED_T3_SCOPES, expiresAt: legacy.expiresAt, label: "other-bot" });
    await world.seedToken(legacy);
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([
      { expiresAt: legacy.expiresAt, retiredAt: new Date(START).toISOString() },
    ]);
    world.clock.now = START + 16 * 60_000;
    const issuedBefore = world.t3.issued();
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(legacy.revoked).toBe(false);
    expect(lookalike.revoked).toBe(false);
    expect(world.t3.issued()).toBe(issuedBefore);
    expect(world.logs.at(-1)).toMatchObject({ level: "warn", event: "t3.token.revoke_skipped", count: 1 });
    expect(world.logs.at(-1)?.detail).toContain(`expires on its own at ${legacy.expiresAt}`);
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([]);
  });

  test("two rotations in the same second get distinct labels and the first replacement is still revoked", async () => {
    const world = await setup();
    const original = restrictedSession(world.t3, 20, START, "agent-tag-orchestration-20261001T000000Z-aaaaaa");
    await world.seedToken(original);
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(world.stateFile, JSON.stringify({
      version: 1, currentLabel: original.label, rotatedAt: new Date(START - DAY_MS).toISOString(), rotationReason: "missing", retired: [],
    }), { mode: 0o600 });
    const lifecycle = world.lifecycle();
    const first = await lifecycle.rotate("manual");
    const second = await lifecycle.rotate("manual");
    expect(first.label).not.toBe(second.label);
    const [middle, latest] = world.t3.restricted().slice(-2);
    world.clock.now = START + 15 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(2);
    expect(original.revoked).toBe(true);
    expect(middle?.revoked).toBe(true);
    expect(latest?.revoked).toBe(false);
  });

  test("an unconfirmed revoke ({revoked:false}) keeps the entry, retries with backoff, then gives up", async () => {
    const world = await setup();
    const old = restrictedSession(world.t3, 20, START, "agent-tag-orchestration-20261001T000000Z-bbbbbb");
    await world.seedToken(old);
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(world.stateFile, JSON.stringify({
      version: 1, currentLabel: old.label, rotatedAt: new Date(START - DAY_MS).toISOString(), rotationReason: "missing", retired: [],
    }), { mode: 0o600 });
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.t3.failures.revokeUnconfirmed = true;
    const grace = START + 15 * 60_000;
    world.clock.now = grace;
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(world.logs.at(-1)).toMatchObject({ event: "t3.token.revoke_skipped", count: 1 });
    expect((await readT3CredentialState(world.stateFile)).retired).toMatchObject([{ label: old.label, attempts: 1 }]);
    // Backoff: not due again until a minute later.
    const issued = world.t3.issued();
    world.clock.now = grace + 30_000;
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(world.t3.issued()).toBe(issued);
    // Attempts 2..6 each wait 1, 2, 4, 8, 16 minutes after the previous attempt.
    let attemptAt = grace;
    for (const step of [1, 2, 4, 8, 16]) {
      const before = world.t3.issued();
      world.clock.now = attemptAt + step * 60_000 - 1_000;
      await lifecycle.revokeRetired();
      expect(world.t3.issued()).toBe(before);
      attemptAt += step * 60_000;
      world.clock.now = attemptAt;
      await lifecycle.revokeRetired();
      expect(world.t3.issued()).toBeGreaterThan(before);
    }
    expect(world.logs.at(-1)?.detail).toContain("after 6 attempts; they expire on their own");
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([]);
    expect(old.revoked).toBe(false);
  });

  test("a pass that runs long after the grace period makes one attempt, not all six", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.t3.failures.revokeUnconfirmed = true;
    world.clock.now = START + 2 * 60 * 60_000;
    for (let pass = 0; pass < 6; pass += 1) await lifecycle.revokeRetired();
    const state = await readT3CredentialState(world.stateFile);
    expect(state.retired).toMatchObject([{ attempts: 1, nextAttemptAt: new Date(world.clock.now + 60_000).toISOString() }]);
  });

  test("a revoke confirmed on a later attempt clears the entry", async () => {
    const world = await setup();
    const old = restrictedSession(world.t3, 20, START, "agent-tag-orchestration-20261001T000000Z-cccccc");
    await world.seedToken(old);
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(world.stateFile, JSON.stringify({
      version: 1, currentLabel: old.label, rotatedAt: new Date(START - DAY_MS).toISOString(), rotationReason: "missing", retired: [],
    }), { mode: 0o600 });
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.t3.failures.revokeUnconfirmed = true;
    world.clock.now = START + 15 * 60_000;
    await lifecycle.revokeRetired();
    world.t3.failures.revokeUnconfirmed = false;
    world.clock.now = START + 16 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(1);
    expect(old.revoked).toBe(true);
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([]);
  });

  test("an unparseable /clients answer logs revoke_skipped and drops the entries", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.t3.failures.clients = "unparseable";
    world.clock.now = START + 20 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(world.logs.at(-1)).toMatchObject({ level: "warn", event: "t3.token.revoke_skipped", count: 1 });
    expect((await readT3CredentialState(world.stateFile)).retired).toEqual([]);
    expect(world.t3.adminSessions().every((session) => session.revoked)).toBe(true);
    world.expectNoSecrets();
  });

  test("a failing /clients call logs revoke_skipped and keeps the entries for a later pass", async () => {
    const world = await setup();
    const old = await world.seedCurrent(20);
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.t3.failures.clients = "error";
    world.clock.now = START + 20 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(0);
    expect(world.logs.at(-1)).toMatchObject({ event: "t3.token.revoke_skipped", errorCode: "T3HttpError" });
    expect((await readT3CredentialState(world.stateFile)).retired).toHaveLength(1);
    world.t3.failures.clients = "ok";
    world.clock.now = START + 21 * 60_000;
    expect(await lifecycle.revokeRetired()).toBe(1);
    expect(old.revoked).toBe(true);
  });

  test("maintain revokes at most once a minute", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    const lifecycle = world.lifecycle();
    await lifecycle.rotate("manual");
    world.clock.now = START + 60_000;
    expect(await lifecycle.maintain()).toBe("idle");
    const issuedBefore = world.t3.issued();
    world.clock.now = START + 15 * 60_000 + 30_000;
    expect(await lifecycle.maintain()).toBe("t3-token-revoked");
    expect(world.t3.issued()).toBe(issuedBefore + 1);
  });

  test("never matches the current session or label", () => {
    const retired = { label: "agent-tag-orchestration-a", retiredAt: new Date(START).toISOString() };
    expect(isRetiredT3Client({ sessionId: "s", current: true, client: { label: "agent-tag-orchestration-a" } }, retired, null)).toBe(false);
    expect(isRetiredT3Client({ sessionId: "s", client: { label: "agent-tag-orchestration-a" } }, retired, "agent-tag-orchestration-a")).toBe(false);
    expect(isRetiredT3Client({ sessionId: "s", client: { label: "agent-tag-orchestration-a" } }, retired, "agent-tag-orchestration-b")).toBe(true);
    expect(isRetiredT3Client({ sessionId: "s", client: { label: "agent-tag-orchestration-c" } }, retired, null)).toBe(false);
    expect(isRetiredT3Client({ sessionId: "s", expiresAt: "x", scopes: [...REQUIRED_T3_SCOPES] }, { retiredAt: retired.retiredAt }, null)).toBe(false);
  });
});

describe("credential state", () => {
  test("concurrent rotations are serialized by the lock and both replaced tokens are recorded", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    const [a, b] = await Promise.all([
      world.lifecycle(() => new Date(START)).rotate("manual"),
      world.lifecycle(() => new Date(START + 1_000)).rotate("manual"),
    ]);
    expect(a.label).not.toBe(b.label);
    const state = await readT3CredentialState(world.stateFile);
    const token = (await readFile(world.tokenFile, "utf8")).trim();
    const winner = world.t3.restricted().find((session) => session.token === token);
    expect(state.currentLabel).toBe(winner?.label ?? "");
    expect(state.retired).toHaveLength(2);
    expect(await stat(`${world.stateFile}.lock`).catch(() => null)).toBeNull();
    expect((await stat(world.stateFile)).mode & 0o777).toBe(0o600);
  });

  test("six concurrent rotations never overlap: one admin session at a time, every replacement recorded", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    const results = await Promise.all(Array.from({ length: 6 }, () => world.lifecycle().rotate("manual")));
    expect(new Set(results.map((result) => result.label)).size).toBe(6);
    expect(world.t3.admins.maxOpen).toBe(1);
    const state = await readT3CredentialState(world.stateFile);
    expect(state.retired).toHaveLength(6);
    expect(new Set(state.retired.map((entry) => entry.label)).size).toBe(6);
    const token = (await readFile(world.tokenFile, "utf8")).trim();
    expect(state.currentLabel).toBe(world.t3.restricted().find((session) => session.token === token)?.label ?? "");
  });

  test("a lock held by a live owner is never removed by a waiter, and the wait honours abort", async () => {
    const world = await setup();
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    const held = `${process.pid}:someone-else`;
    await writeFile(`${world.stateFile}.lock`, held);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    await expect(world.lifecycle().rotate("manual", controller.signal)).rejects.toThrow();
    expect(await readFile(`${world.stateFile}.lock`, "utf8")).toBe(held);
    expect(world.t3.issued()).toBe(0);
  });

  test("an empty or garbage lock file (no live owner) is reclaimed", async () => {
    const world = await setup();
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(`${world.stateFile}.lock`, "");
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
    expect(await stat(`${world.stateFile}.lock`).catch(() => null)).toBeNull();
  });

  test("a stale lock left by a dead process is taken over", async () => {
    const world = await setup();
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(`${world.stateFile}.lock`, "999999999");
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
  });

  test("waiters racing to reclaim the same stale lock never let two rotations overlap", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    await writeFile(`${world.stateFile}.lock`, "999999999:dead");
    const results = await Promise.all(Array.from({ length: 8 }, () => world.lifecycle().rotate("manual")));
    expect(new Set(results.map((result) => result.label)).size).toBe(8);
    expect(world.t3.admins.maxOpen).toBe(1);
    expect((await readT3CredentialState(world.stateFile)).retired).toHaveLength(8);
    expect(await stat(`${world.stateFile}.lock`).catch(() => null)).toBeNull();
  });

  test("a waiter reclaiming a stale lock that another waiter already replaced never frees the live lock", async () => {
    const world = await setup();
    const lock = join(world.dir, "race.lock");
    const live = `${process.pid}:live`;
    await writeFile(lock, live);
    await writeFile(join(world.dir, "late.tmp"), `${process.pid}:late`);
    await writeFile(join(world.dir, "thief.tmp"), `${process.pid}:thief`);
    let stolen = false;
    let done = false;
    const thief = (async () => {
      while (!done && !stolen) {
        stolen = await link(join(world.dir, "thief.tmp"), lock).then(() => true, () => false);
      }
    })();
    // The late waiter still holds its snapshot of the dead owner's lock.
    for (let round = 0; round < 50 && !stolen; round += 1) {
      await reclaimStaleLock(lock, "999999999:dead", join(world.dir, "late.tmp"));
    }
    done = true;
    await thief;
    expect(stolen).toBe(false);
    expect(await readFile(lock, "utf8")).toBe(live);
  });

  test("a reclaim slot left by a reclaimer that died does not wedge the lock", async () => {
    const world = await setup();
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(`${world.stateFile}.lock`, "999999999:dead");
    await writeFile(`${world.stateFile}.lock.reclaim-999999999_dead`, "999999998:alsodead");
    expect(await world.lifecycle().ensureToken()).toBe("enrolled");
    expect(await stat(`${world.stateFile}.lock`).catch(() => null)).toBeNull();
  });

  test("a corrupt state file is an actionable error", async () => {
    const world = await setup();
    await mkdir(join(world.dir, "runtime"), { recursive: true, mode: 0o700 });
    await writeFile(world.stateFile, "{not json");
    await expect(readT3CredentialState(world.stateFile)).rejects.toThrow("delete it to start over");
  });
});

describe("inspectT3TokenStatus", () => {
  test("reports expiry, label, last rotation and pending revocations without the token", async () => {
    const world = await setup();
    await world.seedCurrent(20);
    await world.lifecycle().rotate("manual");
    world.clock.now = START + DAY_MS;
    const status = await inspectT3TokenStatus({
      baseUrl: world.t3.baseUrl,
      tokenFile: world.tokenFile,
      stateFile: world.stateFile,
      now: () => new Date(world.clock.now),
    });
    expect(status).toEqual({
      expiresAt: new Date(START + 30 * DAY_MS).toISOString(),
      daysRemaining: 29,
      label: expect.stringMatching(LABEL_AT_START),
      rotatedAt: new Date(START).toISOString(),
      pendingRevocations: 1,
      problem: null,
    });
    world.expectNoSecrets(status);
  });

  test("a missing token is reported as a problem with null expiry", async () => {
    const world = await setup();
    const status = await inspectT3TokenStatus({ baseUrl: world.t3.baseUrl, tokenFile: world.tokenFile });
    expect(status).toMatchObject({ expiresAt: null, daysRemaining: null, label: null, pendingRevocations: 0 });
    expect(status.problem).not.toBeNull();
  });
});

function managedT3(dir: string, baseUrl: string): Extract<ResolvedT3Config, { mode: "managed" }> {
  return {
    mode: "managed",
    baseUrl,
    tokenFile: join(dir, "secrets", "t3-token"),
    watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 },
    managed: {
      port: Number(new URL(baseUrl).port),
      homeDir: join(dir, "home"),
      runtimeDir: join(dir, "runtime"),
      autoInstall: true,
      rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
    },
  };
}

describe("runT3Rotate", () => {
  const descriptor = (serverVersion: string): EnvironmentFetch => async () => Response.json({ serverVersion, orchestrationProtocolVersion: 1 });

  test("external with --admin-token-file prints the rotation JSON and never prints a token", async () => {
    const world = await setup();
    const admin = world.t3.add({ scopes: ADMIN_SCOPES, expiresAt: new Date(START + DAY_MS).toISOString() });
    const adminFile = join(world.dir, "admin-token");
    await writeFile(adminFile, admin.token, { mode: 0o600 });
    const printed: string[] = [];
    const code = await runT3Rotate({
      t3: { mode: "external", baseUrl: world.t3.baseUrl, tokenFile: world.tokenFile, watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 } },
      pin: PINNED_T3,
      run: world.t3.run,
      logger: (record) => world.logs.push(record),
      print: (line) => printed.push(line),
      external: { adminTokenFile: adminFile },
      fetch: descriptor(PINNED_T3.version),
      now: () => new Date(START),
    });
    expect(code).toBe(0);
    expect(JSON.parse(printed.join("\n"))).toEqual({
      mode: "external",
      tokenFile: world.tokenFile,
      label: expect.stringMatching(LABEL_AT_START),
      expiresAt: new Date(START + 30 * DAY_MS).toISOString(),
      daysRemaining: 30,
      previousToken: "not revoked; it expires on its own",
    });
    // An operator-supplied admin token is never revoked by Agent Tag.
    expect(admin.revoked).toBe(false);
    world.expectNoSecrets(printed);
  });

  test("external refuses to send the admin credential to a server failing the protocol gate", async () => {
    const world = await setup();
    const adminFile = join(world.dir, "admin-token");
    await writeFile(adminFile, "admin-secret", { mode: 0o600 });
    await expect(runT3Rotate({
      t3: { mode: "external", baseUrl: world.t3.baseUrl, tokenFile: world.tokenFile, watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 } },
      pin: PINNED_T3,
      run: world.t3.run,
      logger: () => {},
      print: () => {},
      external: { adminTokenFile: adminFile },
      fetch: async () => Response.json({ serverVersion: "0.0.45", orchestrationProtocolVersion: 99 }),
    })).rejects.toThrow("refusing to rotate");
    expect(world.t3.sessions).toHaveLength(0);
  });

  test("external without admin flags names them", async () => {
    const world = await setup();
    await expect(runT3Rotate({
      t3: { mode: "external", baseUrl: world.t3.baseUrl, tokenFile: world.tokenFile, watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 } },
      pin: PINNED_T3,
      run: world.t3.run,
      logger: () => {},
      print: () => {},
    })).rejects.toThrow("--admin-token-file");
  });

  test("managed rejects external flags and refuses when the runtime is not running", async () => {
    const world = await setup();
    const t3 = managedT3(world.dir, world.t3.baseUrl);
    const base = { t3, pin: PINNED_T3, run: world.t3.run, logger: () => {}, print: () => {} };
    await expect(runT3Rotate({ ...base, external: { adminTokenFile: "/x" } })).rejects.toThrow("only apply to t3.mode external");
    const verified: T3InstallStatus = {
      pinnedVersion: PINNED_T3.version, target: `${process.platform}-${process.arch}`, supported: true,
      runtimeDir: t3.managed.runtimeDir, installed: true, version: PINNED_T3.version, binary: "/fake/t3",
      binarySha256: null, binarySha256Verified: true, filesVerified: true, installedAt: null, problem: null,
    };
    await expect(runT3Rotate({ ...base, inspectInstall: async () => verified, fetch: async () => Promise.reject(new TypeError("fetch failed")) }))
      .rejects.toThrow("not running and ready");
    expect(world.t3.issued()).toBe(0);
  });

  test("managed rotates through the installed binary when the runtime is ready", async () => {
    const world = await setup();
    const t3 = managedT3(world.dir, world.t3.baseUrl);
    await mkdir(join(t3.managed.homeDir, "userdata"), { recursive: true });
    await writeFile(join(t3.managed.homeDir, "userdata", "server-runtime.json"), JSON.stringify({ pid: process.pid }));
    const verified: T3InstallStatus = {
      pinnedVersion: PINNED_T3.version, target: `${process.platform}-${process.arch}`, supported: true,
      runtimeDir: t3.managed.runtimeDir, installed: true, version: PINNED_T3.version, binary: "/fake/t3",
      binarySha256: null, binarySha256Verified: true, filesVerified: true, installedAt: null, problem: null,
    };
    const printed: string[] = [];
    expect(await runT3Rotate({
      t3, pin: PINNED_T3, run: world.t3.run, logger: (record) => world.logs.push(record), print: (line) => printed.push(line),
      inspectInstall: async () => verified, fetch: descriptor(PINNED_T3.version), now: () => new Date(START),
    })).toBe(0);
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ mode: "managed", previousToken: "revoked by the running service after 15 minutes" });
    expect(world.t3.commands[0]?.slice(0, 6)).toEqual(["/fake/t3", "auth", "session", "issue", "--base-dir", t3.managed.homeDir]);
    expect((await readT3CredentialState(join(t3.managed.runtimeDir, T3_CREDENTIAL_STATE_FILE))).rotationReason).toBe("manual");
    world.expectNoSecrets(printed);
  });
});

describe("managedT3Credentials", () => {
  test("keeps state in runtimeDir and issues admin sessions against homeDir", async () => {
    const world = await setup();
    const t3 = managedT3(world.dir, world.t3.baseUrl);
    const lifecycle = managedT3Credentials({ t3, binary: "/fake/t3", logger: () => {}, run: world.t3.run, now: () => new Date(START) });
    expect(await lifecycle.ensureToken()).toBe("enrolled");
    expect((await readT3CredentialState(join(t3.managed.runtimeDir, T3_CREDENTIAL_STATE_FILE))).currentLabel).not.toBeNull();
    expect(world.t3.commands[0]).toContain(t3.managed.homeDir);
  });
});

describe("doctor t3-token-rotation", () => {
  const configFor = (t3: ResolvedT3Config) => ({ t3 }) as unknown as AgentTagConfig;

  test("skips external mode with the rotate command", async () => {
    const world = await setup();
    const check = await checkT3TokenRotation(
      configFor({ mode: "external", baseUrl: world.t3.baseUrl, tokenFile: world.tokenFile, watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 } }),
      new Date(START),
    );
    expect(check).toMatchObject({ id: "t3-token-rotation", status: "skip" });
  });

  test("passes with no rotation yet, reports the last rotation, and warns on overdue revocations", async () => {
    const world = await setup();
    const t3 = managedT3(world.dir, world.t3.baseUrl);
    expect((await checkT3TokenRotation(configFor(t3), new Date(START))).status).toBe("pass");
    await mkdir(t3.managed.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(join(t3.managed.runtimeDir, T3_CREDENTIAL_STATE_FILE), JSON.stringify({
      version: 1, currentLabel: "agent-tag-orchestration-x", rotatedAt: new Date(START).toISOString(), rotationReason: "expiring",
      retired: [{ label: "agent-tag-orchestration-w", retiredAt: new Date(START).toISOString() }],
    }));
    const fresh = await checkT3TokenRotation(configFor(t3), new Date(START + 10 * 60_000));
    expect(fresh.status).toBe("pass");
    expect(fresh.summary).toContain("1 replaced token(s) awaiting revocation");
    const overdue = await checkT3TokenRotation(configFor(t3), new Date(START + 2 * 3_600_000));
    expect(overdue.status).toBe("warn");
    expect(overdue.hint).toContain("revoke_skipped");
  });
});
