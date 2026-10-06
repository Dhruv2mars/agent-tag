import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkBunVersion,
  compareVersions,
  type DoctorCheck,
  type DoctorDependencies,
  type DoctorReport,
  formatDoctorReport,
  runDoctor,
} from "../src/doctor.ts";
import type { ServiceManager, ServiceStatusReport, ServiceUnitState } from "../src/service-manager.ts";
import type { T3Session } from "../src/t3/auth.ts";
import type { T3ServerInfo } from "../src/t3/gateway.ts";
import { parseT3Pin } from "../src/t3/pin.ts";

const pin = parseT3Pin(await Bun.file(join(import.meta.dir, "..", "t3.lock.json")).json());
const NOW = new Date("2026-10-06T00:00:00.000Z");
const APP_TOKEN = "xapp-1-fixture-app-token";
const BOT_TOKEN = "xoxb-fixture-bot-token";
const T3_TOKEN = "t3-fixture-restricted-token";

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly dataDir: string;
  readonly secretsDir: string;
}

async function createFixture(root: string): Promise<Fixture> {
  const dataDir = join(root, "data");
  const secretsDir = join(root, "secrets");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(secretsDir, { mode: 0o700 });
  for (const [name, value] of [["slack-app-token", APP_TOKEN], ["slack-bot-token", BOT_TOKEN], ["t3-token", T3_TOKEN]] as const) {
    await writeFile(join(secretsDir, name), `${value}\n`, { mode: 0o600 });
  }
  const configPath = join(root, "agent-tag.json");
  const repository = join(root, "repo");
  await mkdir(repository);
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      dataDir,
      t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: join(secretsDir, "t3-token") },
      slack: {
        workspaceId: "T0FIXTURE",
        appTokenFile: join(secretsDir, "slack-app-token"),
        botTokenFile: join(secretsDir, "slack-bot-token"),
      },
      access: { allowedUserIds: ["U0FIXTURE"], allowedChannelIds: ["C0FIXTURE"] },
      profiles: [
        {
          id: "default",
          repositoryRoots: [repository],
          defaultProviderInstanceId: "codex",
          defaultModel: "gpt-5.6-sol",
          runtimeMode: "approval-required",
          isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
          externalWrites: { mode: "deny" },
          memory: { shared: true, privateDm: false, retentionDays: 30 },
        },
      ],
      routes: [{ conversationId: "C0FIXTURE", profileId: "default" }],
      limits: { maxConcurrentTasks: 1 },
    }),
  );
  return { root, configPath, dataDir, secretsDir };
}

const readyServer: T3ServerInfo = {
  environment: { environmentId: "env-fixture", capabilities: {} },
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "gpt-5.6-sol", name: "GPT", capabilities: null }],
    },
  ],
};

class FakeService implements ServiceManager {
  readonly kind = "systemd" as const;
  unit: ServiceUnitState = {
    unitPath: "/units/agent-tag.service",
    installed: true,
    current: true,
    sameConfig: true,
    sameCheckout: true,
    sameBun: true,
    installedCheckout: "/srv/agent-tag",
    installedBunPath: "/usr/local/bin/bun",
  };
  running = true;
  readonly calls: string[] = [];

  readonly status = async (): Promise<ServiceStatusReport> => ({
    manager: "systemd",
    unitPath: this.unit.unitPath,
    installed: this.unit.installed,
    loaded: this.unit.installed,
    running: this.running,
    hints: [],
  });
  readonly install = async (): Promise<ServiceStatusReport> => this.status();
  readonly upgrade = async (configPath: string): Promise<ServiceStatusReport> => {
    this.calls.push(`upgrade ${configPath}`);
    this.unit = { ...this.unit, current: true };
    this.running = true;
    return this.status();
  };
  readonly uninstall = async (): Promise<ServiceStatusReport> => this.status();
  readonly restart = async (): Promise<ServiceStatusReport> => {
    this.calls.push("restart");
    this.running = true;
    return this.status();
  };
  readonly unitState = async (): Promise<ServiceUnitState> => this.unit;
  readonly logsCommand = (): string[] => ["true"];
}

interface FakeWorld {
  environment: Response | Error;
  session: T3Session | Error;
  slackAuth: unknown;
  slackApp: unknown;
  server: T3ServerInfo;
  readonly seenAuthorization: string[];
  /** Every authenticated T3 call (session inspection, provider/model listing); each one carries the token. */
  readonly t3TokenRequests: string[];
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function dependencies(world: FakeWorld, service: ServiceManager | undefined): DoctorDependencies {
  return {
    fetch: async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== null) world.seenAuthorization.push(authorization);
      if (url.endsWith("/.well-known/t3/environment")) {
        if (world.environment instanceof Error) throw world.environment;
        return world.environment.clone();
      }
      if (url === "https://slack.com/api/auth.test") return json(world.slackAuth);
      if (url === "https://slack.com/api/apps.connections.open") return json(world.slackApp);
      throw new Error(`unexpected fetch ${url}`);
    },
    bunVersion: "1.3.13",
    uid: process.getuid?.(),
    now: () => NOW,
    pin,
    bunRequirement: { minimum: "1.2.0", pinned: "1.3.13" },
    inspectSession: async ({ token }) => {
      world.t3TokenRequests.push("session");
      expect(token.exposeToBoundary()).toBe(T3_TOKEN);
      if (world.session instanceof Error) throw world.session;
      return world.session;
    },
    inspectT3: async () => {
      world.t3TokenRequests.push("providers");
      return world.server;
    },
    storeDiagnostics: async () => ({ tasks: 2, operations: 3 }),
    service,
  };
}

function healthyWorld(): FakeWorld {
  return {
    environment: json({ serverVersion: pin.version, orchestrationProtocolVersion: 1 }),
    session: {
      authenticated: true,
      scopes: ["orchestration:read", "orchestration:operate"],
      sessionMethod: "bearer-access-token",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
    slackAuth: { ok: true, team_id: "T0FIXTURE", user_id: "U0BOT" },
    slackApp: { ok: true, url: "wss://example.invalid" },
    server: readyServer,
    seenAuthorization: [],
    t3TokenRequests: [],
  };
}

function check(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}

describe("agent-tag doctor", () => {
  let fixture: Fixture;
  let world: FakeWorld;
  let service: FakeService;

  beforeEach(async () => {
    fixture = await createFixture(await mkdtemp(join(tmpdir(), "agent-tag-doctor-")));
    world = healthyWorld();
    service = new FakeService();
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const run = (fix = false): Promise<DoctorReport> =>
    runDoctor({ configPath: fixture.configPath, fix, dependencies: dependencies(world, service) });

  test("passes every check on a healthy install without printing secrets", async () => {
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.checks.map((item) => [item.id, item.status])).toEqual([
      ["bun-version", "pass"],
      ["config", "pass"],
      ["data-dir", "pass"],
      ["secret:slack-app-token", "pass"],
      ["secret:slack-bot-token", "pass"],
      ["secret:t3-token", "pass"],
      ["store", "pass"],
      ["t3-environment", "pass"],
      ["t3-version", "pass"],
      ["t3-session", "pass"],
      ["t3-providers", "pass"],
      ["slack-bot-auth", "pass"],
      ["slack-app-auth", "pass"],
      ["service", "pass"],
    ]);
    expect(world.seenAuthorization).toEqual([`Bearer ${BOT_TOKEN}`, `Bearer ${APP_TOKEN}`]);
    const output = `${formatDoctorReport(report)}\n${JSON.stringify(report)}`;
    for (const secret of [APP_TOKEN, BOT_TOKEN, T3_TOKEN]) expect(output).not.toContain(secret);
    expect(formatDoctorReport(report)).toContain("14 passed, 0 warning(s), 0 failed, 0 skipped");
  });

  test("stops after an invalid config", async () => {
    await writeFile(fixture.configPath, JSON.stringify({ version: 1 }));
    const report = await run();
    expect(report.ok).toBe(false);
    expect(check(report, "config").status).toBe("fail");
    expect(check(report, "config").summary).toContain("dataDir");
    expect(report.checks).toHaveLength(2);
  });

  test("reports permissive secrets and data dir, and --fix repairs them", async () => {
    await chmod(fixture.dataDir, 0o755);
    await chmod(join(fixture.secretsDir, "slack-bot-token"), 0o644);
    const before = await run();
    expect(before.ok).toBe(false);
    expect(check(before, "data-dir")).toMatchObject({ status: "fail" });
    expect(check(before, "data-dir").summary).toContain("0755");
    expect(check(before, "secret:slack-bot-token").status).toBe("fail");
    expect(check(before, "store").status).toBe("skip");
    expect(check(before, "slack-bot-auth").status).toBe("skip");

    const after = await run(true);
    expect(after.ok).toBe(true);
    expect(check(after, "data-dir").fixed).toContain("chmod 0700");
    expect(check(after, "secret:slack-bot-token").fixed).toContain("chmod 0600");
    expect((await stat(fixture.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.secretsDir, "slack-bot-token"))).mode & 0o777).toBe(0o600);
  });

  test("--fix creates a missing data dir but cannot invent a missing token", async () => {
    await rm(fixture.dataDir, { recursive: true });
    await rm(join(fixture.secretsDir, "t3-token"));
    const report = await run(true);
    expect(check(report, "data-dir")).toMatchObject({ status: "pass", fixed: "created with mode 0700" });
    expect(check(report, "secret:t3-token").status).toBe("fail");
    expect(check(report, "secret:t3-token").hint).toContain("enroll:t3");
    expect(check(report, "t3-session").status).toBe("skip");
    expect(report.ok).toBe(false);
  });

  test("detects swapped Slack tokens without revealing them", async () => {
    await writeFile(join(fixture.secretsDir, "slack-app-token"), `${BOT_TOKEN}\n`, { mode: 0o600 });
    const report = await run();
    const swapped = check(report, "secret:slack-app-token");
    expect(swapped.status).toBe("fail");
    expect(swapped.summary).toContain("xapp-");
    expect(JSON.stringify(report)).not.toContain(BOT_TOKEN);
  });

  test("fails when T3 is unreachable and skips dependent checks", async () => {
    world.environment = new Error("connect ECONNREFUSED");
    const report = await run();
    expect(check(report, "t3-environment").status).toBe("fail");
    expect(check(report, "t3-session").status).toBe("skip");
    expect(check(report, "t3-providers").status).toBe("skip");
    expect(check(report, "t3-version").status).toBe("skip");
  });

  test("enforces orchestration protocol 1, treating a missing field as 1", async () => {
    world.environment = json({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2 });
    expect(check(await run(), "t3-environment").status).toBe("fail");

    world.environment = json({ serverVersion: pin.version });
    expect(check(await run(), "t3-environment")).toMatchObject({ status: "pass" });

    world.environment = new Response("not found", { status: 404 });
    expect(check(await run(), "t3-environment").status).toBe("warn");
  });

  test("never sends the T3 token to a server that fails the environment check", async () => {
    for (const environment of [
      json({ serverVersion: "0.1.0", orchestrationProtocolVersion: 2 }),
      json({ orchestrationProtocolVersion: "one" }),
      new Response("<html>not json</html>", { status: 200 }),
    ]) {
      world = healthyWorld();
      world.environment = environment;
      const report = await run();
      expect(check(report, "t3-environment").status).toBe("fail");
      for (const id of ["t3-session", "t3-providers"]) {
        expect(check(report, id).status).toBe("skip");
        expect(check(report, id).summary).toContain("environment check failed");
      }
      expect(world.t3TokenRequests).toEqual([]);
      expect(world.seenAuthorization.some((value) => value.includes(T3_TOKEN))).toBe(false);
      expect(report.ok).toBe(false);
    }

    // An older server without the endpoint warns and implies protocol 1, so the authenticated checks still run.
    world = healthyWorld();
    world.environment = new Response("not found", { status: 404 });
    const legacy = await run();
    expect(check(legacy, "t3-environment").status).toBe("warn");
    expect(check(legacy, "t3-session").status).toBe("pass");
    expect(check(legacy, "t3-providers").status).toBe("pass");
    expect(world.t3TokenRequests).toEqual(["session", "providers"]);
  });

  test("warns when T3 differs from t3.lock.json", async () => {
    world.environment = json({ serverVersion: "0.0.45-nightly.20261002.2584", orchestrationProtocolVersion: 1 });
    const report = await run();
    expect(check(report, "t3-version").status).toBe("warn");
    expect(check(report, "t3-version").summary).toContain(pin.version);
    expect(report.ok).toBe(true);
  });

  test("warns about a token close to expiry and fails an expired or over-scoped token", async () => {
    world.session = { ...(world.session as T3Session), expiresAt: "2026-10-08T00:00:00.000Z" };
    expect(check(await run(), "t3-session").status).toBe("warn");

    world.session = { ...(world.session as T3Session), expiresAt: "2026-10-01T00:00:00.000Z" };
    expect(check(await run(), "t3-session").status).toBe("fail");

    world.session = {
      ...(world.session as T3Session),
      expiresAt: "2026-12-01T00:00:00.000Z",
      scopes: ["orchestration:read", "orchestration:operate", "access:write"],
    };
    const report = await run();
    expect(check(report, "t3-session").status).toBe("fail");
    expect(check(report, "t3-providers").status).toBe("skip");
  });

  test("fails an unauthenticated provider", async () => {
    world.server = {
      ...readyServer,
      providers: readyServer.providers.map((provider) => ({ ...provider, auth: { status: "unauthenticated" as const } })),
    };
    expect(check(await run(), "t3-providers").summary).toContain("not authenticated");
  });

  test("fails Slack auth errors and wrong-workspace bots", async () => {
    world.slackAuth = { ok: false, error: "invalid_auth" };
    world.slackApp = { ok: false, error: "invalid_auth" };
    let report = await run();
    expect(check(report, "slack-bot-auth").summary).toContain("invalid_auth");
    expect(check(report, "slack-app-auth").status).toBe("fail");

    world.slackAuth = { ok: true, team_id: "T0OTHER", user_id: "U0BOT" };
    report = await run();
    expect(check(report, "slack-bot-auth").summary).toContain("T0OTHER");
  });

  test("service: warns when missing, repairs stale units and stopped services with --fix", async () => {
    service.unit = { ...service.unit, installed: false };
    expect(check(await run(), "service")).toMatchObject({ status: "warn" });

    service.unit = { ...service.unit, installed: true, current: false };
    const stale = await run();
    expect(check(stale, "service").status).toBe("warn");
    expect(service.calls).toEqual([]);
    const repaired = await run(true);
    expect(check(repaired, "service")).toMatchObject({ status: "pass", fixed: "regenerated the service unit and restarted it" });
    expect(service.calls).toEqual([`upgrade ${fixture.configPath}`]);

    service.running = false;
    const restarted = await run(true);
    expect(check(restarted, "service")).toMatchObject({ status: "pass", fixed: "restarted the service" });
  });

  test("service: does not touch a unit for a different config or while other checks fail", async () => {
    service.unit = { ...service.unit, sameConfig: false, current: false };
    expect(check(await run(true), "service").summary).toContain("different config");

    service.unit = { ...service.unit, sameConfig: true, current: false };
    world.slackAuth = { ok: false, error: "invalid_auth" };
    const report = await run(true);
    expect(check(report, "service").hint).toContain("resolve the failed checks");
    expect(service.calls).toEqual([]);
  });

  test("service: --fix never moves a unit that runs another checkout or another Bun", async () => {
    service.unit = { ...service.unit, current: false, sameCheckout: false, installedCheckout: "/srv/live-checkout" };
    const otherCheckout = await run(true);
    expect(check(otherCheckout, "service")).toMatchObject({ status: "warn" });
    expect(check(otherCheckout, "service").summary).toContain("different Agent Tag checkout (/srv/live-checkout)");
    expect(check(otherCheckout, "service").hint).toContain("from the checkout it should run");
    expect(check(otherCheckout, "service").fixed).toBeUndefined();

    service.running = false;
    await run(true);
    expect(service.calls).toEqual([]);

    service.unit = { ...service.unit, sameCheckout: true, sameBun: false, installedBunPath: "/opt/other/bun" };
    const otherBun = await run(true);
    expect(check(otherBun, "service").summary).toContain("different Bun (/opt/other/bun)");
    expect(service.calls).toEqual([]);
  });

  test("service is skipped on unsupported platforms", async () => {
    const report = await runDoctor({
      configPath: fixture.configPath,
      fix: false,
      dependencies: dependencies(world, undefined),
    });
    expect(check(report, "service").status).toBe("skip");
  });
});

describe("version checks", () => {
  test("compares dotted versions and ignores prerelease suffixes", () => {
    expect(compareVersions("1.3.13", "1.2.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.3.13")).toBe(-1);
    expect(compareVersions("v0.0.42", "0.0.42")).toBe(0);
    expect(compareVersions("0.0.45-nightly.1", "0.0.45")).toBe(0);
  });

  test("fails old Bun and warns on an unverified newer Bun", () => {
    const requirement = { minimum: "1.2.0", pinned: "1.3.13" };
    expect(checkBunVersion({ bunVersion: "1.1.9", bunRequirement: requirement }).status).toBe("fail");
    expect(checkBunVersion({ bunVersion: "1.4.0", bunRequirement: requirement }).status).toBe("warn");
    expect(checkBunVersion({ bunVersion: "1.3.13", bunRequirement: requirement }).status).toBe("pass");
  });
});
