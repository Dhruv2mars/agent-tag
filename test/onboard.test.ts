import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArguments } from "../src/cli-args.ts";
import { onboardOptionsFromArguments, resolveConfigPath } from "../src/cli-commands.ts";
import type { CommandResult } from "../src/command.ts";
import { agentTagConfigSchema } from "../src/config.ts";
import {
  defaultT3BaseDir,
  detectT3Runtime,
  type OnboardDependencies,
  type OnboardOptions,
  parseSlackIdList,
  runOnboard,
  SLACK_APP_TOKEN_ENV,
  SLACK_BOT_TOKEN_ENV,
  slackManifestUrl,
  t3BaseDirMismatch,
} from "../src/onboard.ts";
import { nonInteractivePrompter, parseYesNo, type Prompter } from "../src/prompt.ts";
import { SecretString } from "../src/security/secret-file.ts";
import type { ServiceStatusReport } from "../src/service-manager.ts";
import type { T3ServerInfo } from "../src/t3/gateway.ts";

const root = join(import.meta.dir, "..");
const template: unknown = await Bun.file(join(root, "config", "agent-tag.example.json")).json();
const manifest: unknown = await Bun.file(join(root, "config", "slack-manifest.example.json")).json();

const APP_TOKEN = "xapp-1-fixture-app-token";
const BOT_TOKEN = "xoxb-fixture-bot-token";
const ADMIN_TOKEN = "t3-fixture-admin-session";
const RESTRICTED_TOKEN = "t3-fixture-restricted-token";
const ADMIN_SESSION_ID = "session-fixture-1";

const server: T3ServerInfo = {
  environment: { environmentId: "env", capabilities: {} },
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
      models: [{ slug: "claude-x", name: "Claude", capabilities: null }],
    },
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "gpt-a", name: "A", capabilities: null },
        { slug: "gpt-default", name: "Default", isDefault: true, capabilities: null },
      ],
    },
  ],
};

interface Harness {
  readonly directory: string;
  readonly home: string;
  readonly repo: string;
  readonly t3BaseDir: string;
  readonly output: string[];
  readonly commands: string[];
  readonly enrolled: string[];
  readonly installs: string[];
  deps: OnboardDependencies;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-onboard-"));
  const repo = join(directory, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const t3BaseDir = join(directory, "t3");
  await mkdir(join(t3BaseDir, "userdata"), { recursive: true });
  await writeFile(
    join(t3BaseDir, "userdata", "server-runtime.json"),
    JSON.stringify({ version: 1, pid: 1, host: "127.0.0.1", port: 3774, origin: "http://127.0.0.1:3774" }),
  );
  const harness: Harness = {
    directory,
    home: join(directory, "agent-tag-home"),
    repo,
    t3BaseDir,
    output: [],
    commands: [],
    enrolled: [],
    installs: [],
    deps: undefined as unknown as OnboardDependencies,
  };
  harness.deps = {
    prompter: nonInteractivePrompter(),
    print: (line) => harness.output.push(line),
    env: { [SLACK_APP_TOKEN_ENV]: APP_TOKEN, [SLACK_BOT_TOKEN_ENV]: BOT_TOKEN },
    homeDirectory: directory,
    cwd: directory,
    fetch: async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:3774/.well-known/t3/environment") {
        return json({ serverVersion: "0.0.42", orchestrationProtocolVersion: 1 });
      }
      if (url === "https://slack.com/api/auth.test") {
        return json({ ok: true, team_id: "T0FIXTURE", team: "Fixture", user: "agent-tag" });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    runCommand: async (command): Promise<CommandResult> => {
      harness.commands.push(command.join(" "));
      if (command[3] === "revoke") return { exitCode: 0, stdout: `Revoked session ${ADMIN_SESSION_ID}.\n`, stderr: "" };
      const issued = { sessionId: ADMIN_SESSION_ID, token: ADMIN_TOKEN, method: "bearer-access-token", scopes: ["access:write"] };
      return { exitCode: 0, stdout: `${JSON.stringify(issued, null, 2)}\n`, stderr: "" };
    },
    enrollT3: async ({ administrativeToken }) => {
      harness.enrolled.push(administrativeToken.exposeToBoundary());
      return new SecretString(RESTRICTED_TOKEN);
    },
    listT3Providers: async () => server,
    installService: async (configPath): Promise<ServiceStatusReport> => {
      harness.installs.push(configPath);
      return { manager: "systemd", unitPath: "/units/agent-tag.service", installed: true, loaded: true, running: true, hints: ["enable linger"] };
    },
    template,
    manifest,
  };
  return harness;
}

function flags(harness: Harness, extra: Partial<OnboardOptions> = {}): OnboardOptions {
  return {
    interactive: false,
    acceptRisk: true,
    force: false,
    skipSlackCheck: false,
    t3IssueToken: true,
    home: harness.home,
    t3BaseDir: harness.t3BaseDir,
    repositoryRoots: harness.repo,
    allowedUserIds: "U0ALICE, U0BOB",
    allowedChannelIds: "C0ENG,G0PRIVATE",
    ...extra,
  };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("agent-tag onboard (non-interactive)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await rm(harness.directory, { recursive: true, force: true });
  });

  test("writes a valid config, private secrets, and enrolls T3 from flags alone", async () => {
    const result = await runOnboard(flags(harness, { installService: true }), harness.deps);
    const configPath = join(harness.home, "agent-tag.json");
    expect(result.configPath).toBe(configPath);
    expect(result.secrets).toEqual({ slackAppToken: "created", slackBotToken: "created", t3Token: "created" });

    const config = agentTagConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    expect(config.dataDir).toBe(join(harness.home, "data"));
    expect(config.slack.workspaceId).toBe("T0FIXTURE");
    expect(config.t3).toEqual({
      baseUrl: "http://127.0.0.1:3774",
      tokenFile: join(harness.home, "secrets", "t3-token"),
      watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 },
    });
    expect(config.access).toEqual({ allowedUserIds: ["U0ALICE", "U0BOB"], allowedChannelIds: ["C0ENG", "G0PRIVATE"] });
    expect(config.profiles[0]).toMatchObject({
      id: "default",
      repositoryRoots: [harness.repo],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-default",
      runtimeMode: "approval-required",
      externalWrites: { mode: "approval-required", allowedTools: [] },
    });
    expect(config.profiles[0]?.ambient.enabled).toBe(false);
    expect(config.routes.map((route) => route.conversationId)).toEqual(["C0ENG", "G0PRIVATE"]);

    expect(await mode(harness.home)).toBe(0o700);
    expect(await mode(join(harness.home, "data"))).toBe(0o700);
    expect(await mode(join(harness.home, "secrets"))).toBe(0o700);
    expect(await mode(configPath)).toBe(0o600);
    for (const [name, value] of [["slack-app-token", APP_TOKEN], ["slack-bot-token", BOT_TOKEN], ["t3-token", RESTRICTED_TOKEN]] as const) {
      const path = join(harness.home, "secrets", name);
      expect(await mode(path)).toBe(0o600);
      expect((await readFile(path, "utf8")).trim()).toBe(value);
    }

    expect(harness.commands).toEqual([
      `t3 auth session issue --base-dir ${harness.t3BaseDir} --ttl 10m --label agent-tag-onboard --json`,
      `t3 auth session revoke --base-dir ${harness.t3BaseDir} ${ADMIN_SESSION_ID}`,
    ]);
    expect(harness.enrolled).toEqual([ADMIN_TOKEN]);
    expect(harness.installs).toEqual([configPath]);

    const printed = harness.output.join("\n");
    expect(printed).toContain(slackManifestUrl(manifest));
    expect(printed).toContain('"socket_mode_enabled": true');
    expect(printed).toContain("detected a running T3 server at http://127.0.0.1:3774");
    for (const secret of [APP_TOKEN, BOT_TOKEN, ADMIN_TOKEN, RESTRICTED_TOKEN]) expect(printed).not.toContain(secret);
  });

  test("is idempotent with --force: keeps existing secrets and does not re-enroll", async () => {
    await runOnboard(flags(harness), harness.deps);
    harness.enrolled.length = 0;
    await expect(runOnboard(flags(harness), harness.deps)).rejects.toThrow("pass --force");
    const second = await runOnboard(
      flags(harness, { force: true, model: "gpt-a", runtimeMode: "auto-accept-edits", installService: false }),
      { ...harness.deps, env: {} },
    );
    expect(second.secrets).toEqual({ slackAppToken: "kept", slackBotToken: "kept", t3Token: "kept" });
    expect(harness.enrolled).toEqual([]);
    expect(second.config.profiles[0]).toMatchObject({ defaultModel: "gpt-a", runtimeMode: "auto-accept-edits" });
    expect(harness.installs).toEqual([]);
  });

  test("requires --accept-risk, tokens, and access lists", async () => {
    await expect(runOnboard(flags(harness, { acceptRisk: false }), harness.deps)).rejects.toThrow("--accept-risk");
    await expect(runOnboard(flags(harness), { ...harness.deps, env: {} })).rejects.toThrow(SLACK_APP_TOKEN_ENV);

    const { allowedUserIds: _users, ...withoutUsers } = flags(harness);
    await expect(runOnboard(withoutUsers, harness.deps)).rejects.toThrow("missing --users");
  });

  test("rejects malformed inputs with the offending flag", async () => {
    await expect(
      runOnboard(flags(harness), { ...harness.deps, env: { [SLACK_APP_TOKEN_ENV]: BOT_TOKEN, [SLACK_BOT_TOKEN_ENV]: BOT_TOKEN } }),
    ).rejects.toThrow("must start with xapp-");
    await rm(harness.home, { recursive: true, force: true });
    await expect(runOnboard(flags(harness, { allowedChannelIds: "D0DM" }), harness.deps)).rejects.toThrow(
      "--channels: D0DM is a DM",
    );
    await rm(harness.home, { recursive: true, force: true });
    await expect(runOnboard(flags(harness, { t3BaseUrl: "http://10.0.0.5:3773" }), harness.deps)).rejects.toThrow(
      "--t3-url: T3 must use a loopback",
    );
    await rm(harness.home, { recursive: true, force: true });
    await expect(runOnboard(flags(harness, { workspaceId: "T0OTHER" }), harness.deps)).rejects.toThrow(
      "belongs to T0FIXTURE",
    );
    await rm(harness.home, { recursive: true, force: true });
    await expect(runOnboard(flags(harness, { repositoryRoots: join(harness.directory, "missing") }), harness.deps)).rejects.toThrow(
      "is not a directory",
    );
  });

  test("continues without a T3 token when T3 is down, and fails when enrollment was requested", async () => {
    const offline: OnboardDependencies = {
      ...harness.deps,
      fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) return json({ ok: true, team_id: "T0FIXTURE" });
        throw new Error("connect ECONNREFUSED");
      },
    };
    await expect(runOnboard(flags(harness), offline)).rejects.toThrow("T3 is not reachable");

    const result = await runOnboard(flags(harness, { t3IssueToken: false, force: true }), offline);
    expect(result.secrets.t3Token).toBe("missing");
    expect(result.config.profiles[0]?.defaultProviderInstanceId).toBe("codex");
    expect(harness.output.join("\n")).toContain("bun run enroll:t3");
  });

  test("treats a T3 server doctor would fail as incompatible: no token, no providers, no service", async () => {
    const protocolTwo: OnboardDependencies = {
      ...harness.deps,
      fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) return json({ ok: true, team_id: "T0FIXTURE" });
        return json({ serverVersion: "0.0.46-nightly", orchestrationProtocolVersion: 2 });
      },
      listT3Providers: async () => {
        throw new Error("providers must not be listed on an incompatible server");
      },
    };
    await expect(runOnboard(flags(harness), protocolTwo)).rejects.toThrow(
      "cannot enroll a T3 token: T3 0.0.46-nightly speaks orchestration protocol 2; Agent Tag requires 1 (run the T3 version pinned in t3.lock.json)",
    );
    expect(harness.commands).toEqual([]);

    const result = await runOnboard(flags(harness, { t3IssueToken: false, force: true }), protocolTwo);
    expect(result.secrets.t3Token).toBe("missing");
    expect(harness.commands).toEqual([]);
    expect(harness.enrolled).toEqual([]);
    expect(harness.output.join("\n")).toContain("run the T3 version pinned in t3.lock.json, then `bun run enroll:t3`");

    await expect(
      runOnboard(flags(harness, { t3IssueToken: false, force: true, installService: true }), protocolTwo),
    ).rejects.toThrow("service not installed: T3 0.0.46-nightly speaks orchestration protocol 2");
    expect(harness.installs).toEqual([]);
  });

  test("rejects a legacy T3 server without the environment endpoint, as the runtime gate does", async () => {
    const legacy: OnboardDependencies = {
      ...harness.deps,
      fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) return json({ ok: true, team_id: "T0FIXTURE" });
        return new Response("not found", { status: 404 });
      },
      listT3Providers: async () => {
        throw new Error("providers must not be listed on a server the runtime rejects");
      },
    };
    await expect(runOnboard(flags(harness), legacy)).rejects.toThrow(
      "cannot enroll a T3 token: T3 at http://127.0.0.1:3774 does not publish /.well-known/t3/environment; " +
        "Agent Tag requires T3 0.0.42–0.0.45 (run the T3 version pinned in t3.lock.json)",
    );
    expect(harness.commands).toEqual([]);
    expect(harness.enrolled).toEqual([]);

    await expect(
      runOnboard(flags(harness, { t3IssueToken: false, force: true, installService: true }), legacy),
    ).rejects.toThrow("service not installed: T3 at http://127.0.0.1:3774 does not publish /.well-known/t3/environment");
    expect(harness.installs).toEqual([]);
  });

  test("derives the model default from the selected provider, not the first one or the template", async () => {
    const twoReady: T3ServerInfo = {
      ...server,
      providers: [
        server.providers[1]!,
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            { slug: "claude-a", name: "A", capabilities: null },
            { slug: "claude-default", name: "Default", isDefault: true, capabilities: null },
          ],
        },
        { ...server.providers[1]!, instanceId: "bare", models: [] },
      ],
    };
    const deps: OnboardDependencies = { ...harness.deps, listT3Providers: async () => twoReady };

    const second = await runOnboard(flags(harness, { providerInstanceId: "claudeAgent" }), deps);
    expect(second.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "claudeAgent", defaultModel: "claude-default" });

    const first = await runOnboard(flags(harness, { force: true }), deps);
    expect(first.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "codex", defaultModel: "gpt-default" });

    for (const providerInstanceId of ["bare", "unlisted"]) {
      await expect(runOnboard(flags(harness, { force: true, providerInstanceId }), deps)).rejects.toThrow(
        `missing --model: T3 reports no default model for ${providerInstanceId}; pass the model for ${providerInstanceId}`,
      );
    }
    const explicit = await runOnboard(flags(harness, { force: true, providerInstanceId: "bare", model: "bare-model" }), deps);
    expect(explicit.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "bare", defaultModel: "bare-model" });
  });

  test("uses the template model only with the template provider when T3 cannot list providers", async () => {
    const offline: OnboardDependencies = {
      ...harness.deps,
      fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) return json({ ok: true, team_id: "T0FIXTURE" });
        throw new Error("connect ECONNREFUSED");
      },
    };
    const templated = await runOnboard(flags(harness, { t3IssueToken: false }), offline);
    expect(templated.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "codex", defaultModel: "gpt-5.6-sol" });
    await expect(
      runOnboard(flags(harness, { t3IssueToken: false, force: true, providerInstanceId: "claudeAgent" }), offline),
    ).rejects.toThrow("missing --model: T3 did not list providers and the template's model belongs to codex");
  });

  test("finds the T3 base dir through T3CODE_HOME", async () => {
    const { t3BaseDir: _flag, ...withoutBaseDir } = flags(harness);
    const result = await runOnboard(withoutBaseDir, {
      ...harness.deps,
      env: { ...harness.deps.env, T3CODE_HOME: harness.t3BaseDir },
    });
    expect(result.secrets.t3Token).toBe("created");
    expect(result.config.t3.baseUrl).toBe("http://127.0.0.1:3774");
    expect(harness.commands[0]).toContain(`--base-dir ${harness.t3BaseDir} `);
  });

  test("refuses to issue an admin session from a base dir that belongs to another T3 instance", async () => {
    const anyT3: OnboardDependencies = {
      ...harness.deps,
      fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) return json({ ok: true, team_id: "T0FIXTURE" });
        return json({ serverVersion: "0.0.42", orchestrationProtocolVersion: 1 });
      },
    };
    const isolated = { t3BaseUrl: "http://127.0.0.1:3999" };
    await expect(runOnboard(flags(harness, isolated), anyT3)).rejects.toThrow(
      `cannot issue a T3 admin session: ${harness.t3BaseDir} belongs to the T3 server at http://127.0.0.1:3774, not http://127.0.0.1:3999`,
    );
    expect(harness.commands).toEqual([]);

    const result = await runOnboard(flags(harness, { ...isolated, t3IssueToken: false, force: true }), anyT3);
    expect(result.secrets.t3Token).toBe("missing");
    expect(harness.commands).toEqual([]);
    expect(harness.output.join("\n")).toContain("pass --t3-base-dir for the T3 instance at http://127.0.0.1:3999");

    const adminTokenFile = join(harness.directory, "admin-token");
    await writeFile(adminTokenFile, ADMIN_TOKEN, { mode: 0o600 });
    const withFile = await runOnboard(flags(harness, { ...isolated, t3IssueToken: false, force: true, t3AdminTokenFile: adminTokenFile }), anyT3);
    expect(withFile.secrets.t3Token).toBe("created");
    expect(harness.enrolled).toEqual([ADMIN_TOKEN]);
  });

  test("revokes the onboarding admin session even when enrollment fails, and warns if revoke fails", async () => {
    const enrollFails: OnboardDependencies = {
      ...harness.deps,
      enrollT3: async () => {
        throw new Error("T3 pairing endpoint returned HTTP 401");
      },
    };
    await expect(runOnboard(flags(harness), enrollFails)).rejects.toThrow("HTTP 401");
    expect(harness.commands.at(-1)).toBe(`t3 auth session revoke --base-dir ${harness.t3BaseDir} ${ADMIN_SESSION_ID}`);

    const revokeFails: OnboardDependencies = {
      ...harness.deps,
      runCommand: async (command) => {
        if (command[3] === "revoke") return { exitCode: 1, stdout: "", stderr: "database is locked" };
        return harness.deps.runCommand(command);
      },
    };
    const result = await runOnboard(flags(harness, { force: true }), revokeFails);
    expect(result.secrets.t3Token).toBe("created");
    const printed = harness.output.join("\n");
    expect(printed).toContain(`could not revoke the onboarding T3 admin session ${ADMIN_SESSION_ID} (exit code 1: database is locked); it expires in 10m`);
    expect(printed).toContain(`revoke it now with: t3 auth session revoke --base-dir ${harness.t3BaseDir} ${ADMIN_SESSION_ID}`);
    expect(printed).not.toContain(ADMIN_TOKEN);
  });

  test("unrecognized t3 issue output is rejected without echoing it", async () => {
    const plain: OnboardDependencies = {
      ...harness.deps,
      runCommand: async () => ({ exitCode: 0, stdout: ADMIN_TOKEN, stderr: "" }),
    };
    const failure = await runOnboard(flags(harness), plain).catch((error: unknown) => error);
    expect(String(failure)).toContain("printed output Agent Tag does not recognize");
    expect(String(failure)).not.toContain(ADMIN_TOKEN);
    expect(harness.enrolled).toEqual([]);
  });

  test("a failed t3 CLI is reported without echoing its output", async () => {
    const failing: OnboardDependencies = {
      ...harness.deps,
      runCommand: async () => ({ exitCode: 2, stdout: ADMIN_TOKEN, stderr: "no session\nmore" }),
    };
    await expect(runOnboard(flags(harness), failing)).rejects.toThrow("failed with exit code 2: no session");
    expect(harness.output.join("\n")).not.toContain(ADMIN_TOKEN);
  });

  test("uses --skip-slack-check with an explicit workspace", async () => {
    const result = await runOnboard(
      flags(harness, { skipSlackCheck: true, workspaceId: "T0EXPLICIT" }),
      { ...harness.deps, fetch: async (input) => {
        if (String(input).startsWith("https://slack.com/")) throw new Error("slack must not be called");
        return json({ orchestrationProtocolVersion: 1 });
      } },
    );
    expect(result.config.slack.workspaceId).toBe("T0EXPLICIT");
  });

  test("an install failure surfaces the doctor hint and fails the run", async () => {
    const failing: OnboardDependencies = {
      ...harness.deps,
      installService: async () => {
        throw new Error("Agent Tag doctor failed with exit code 1");
      },
    };
    await expect(runOnboard(flags(harness, { installService: true }), failing)).rejects.toThrow("doctor failed");
    expect(harness.output.join("\n")).toContain("--fix");
  });
});

class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  readonly #answers: string[];

  constructor(answers: string[]) {
    this.#answers = answers;
  }

  #next(question: string): string {
    this.asked.push(question);
    const answer = this.#answers.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
    return answer;
  }

  readonly ask = async (question: string, defaultValue?: string): Promise<string> => {
    const answer = this.#next(question);
    return answer === "" && defaultValue !== undefined ? defaultValue : answer;
  };
  readonly secret = async (question: string): Promise<string> => this.#next(question);
  readonly confirm = async (question: string, defaultValue: boolean): Promise<boolean> =>
    parseYesNo(this.#next(question), defaultValue) ?? defaultValue;
  readonly close = (): void => {};
}

test("interactive onboarding re-asks invalid answers and accepts defaults", async () => {
  const harness = await createHarness();
  try {
    const prompter = new ScriptedPrompter([
      "y", // trusted same-user execution
      harness.home, // directory
      "bad-token", // app token (rejected)
      APP_TOKEN,
      BOT_TOKEN,
      "", // workspace: detected default
      "", // T3 URL: detected default
      "y", // issue T3 admin session
      harness.repo, // repositories
      "", // base branch
      "", // provider
      "", // model
      "", // runtime mode
      "", // profile
      "alice", // users (rejected)
      "U0ALICE",
      "C0ENG",
      "", // max concurrent tasks
      "n", // install service
    ]);
    const result = await runOnboard(
      { interactive: true, acceptRisk: false, force: false, skipSlackCheck: false, t3IssueToken: false, t3BaseDir: harness.t3BaseDir },
      { ...harness.deps, env: {}, prompter },
    );
    expect(result.config.slack.workspaceId).toBe("T0FIXTURE");
    expect(result.config.profiles[0]?.defaultModel).toBe("gpt-default");
    expect(result.config.limits.maxConcurrentTasks).toBe(2);
    expect(harness.installs).toEqual([]);
    expect(harness.output).toContain("  Slack app-level token must start with xapp-");
    expect(harness.output.some((line) => line.includes("\"alice\" is not a Slack ID"))).toBe(true);
    expect(harness.output.join("\n")).not.toContain(APP_TOKEN);
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

test("interactive onboarding offers the selected provider's model and asks when it has none", async () => {
  const harness = await createHarness();
  try {
    const twoReady: T3ServerInfo = {
      ...server,
      providers: [
        server.providers[1]!,
        { ...server.providers[1]!, instanceId: "claudeAgent", models: [{ slug: "claude-default", name: "D", isDefault: true, capabilities: null }] },
        { ...server.providers[1]!, instanceId: "bare", models: [] },
      ],
    };
    const answers = (provider: string, model: string[]): string[] => [
      "y", harness.home, APP_TOKEN, BOT_TOKEN, "", "", "y", harness.repo, "",
      provider, ...model,
      "", "", "U0ALICE", "C0ENG", "", "n",
    ];
    const run = async (prompter: ScriptedPrompter) =>
      runOnboard(
        { interactive: true, acceptRisk: false, force: true, skipSlackCheck: false, t3IssueToken: false, t3BaseDir: harness.t3BaseDir },
        { ...harness.deps, env: {}, prompter, listT3Providers: async () => twoReady },
      );

    const selected = await run(new ScriptedPrompter(answers("claudeAgent", [""])));
    expect(selected.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "claudeAgent", defaultModel: "claude-default" });

    await rm(harness.home, { recursive: true, force: true }); // ask for the same secrets again
    const prompter = new ScriptedPrompter(answers("bare", ["", "bare-model"]));
    const bare = await run(prompter);
    expect(bare.config.profiles[0]).toMatchObject({ defaultProviderInstanceId: "bare", defaultModel: "bare-model" });
    expect(prompter.asked.filter((question) => question === "Model for bare")).toHaveLength(2);
    expect(harness.output).toContain("  T3 reports no default model for bare; enter the model to use with bare");
    expect(harness.output).toContain("  model is required");
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
});

describe("onboarding helpers", () => {
  test("builds a Slack create-from-manifest link that round-trips the manifest", () => {
    const url = new URL(slackManifestUrl(manifest));
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(manifest);
  });

  test("parses Slack ID lists", () => {
    expect(parseSlackIdList(" U1A, U2B U1A ", "users")).toEqual(["U1A", "U2B"]);
    expect(() => parseSlackIdList("", "users")).toThrow("at least one");
    expect(() => parseSlackIdList("u123", "users")).toThrow("not a Slack ID");
  });

  test("detects a loopback T3 runtime and ignores missing or remote ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-t3-runtime-"));
    try {
      expect(await detectT3Runtime(directory)).toBeUndefined();
      await mkdir(join(directory, "userdata"));
      const file = join(directory, "userdata", "server-runtime.json");
      await writeFile(file, JSON.stringify({ host: "127.0.0.1", port: 4000 }));
      expect(await detectT3Runtime(directory)).toBe("http://127.0.0.1:4000");
      await writeFile(file, JSON.stringify({ origin: "http://192.168.1.4:3773" }));
      expect(await detectT3Runtime(directory)).toBeUndefined();
      await writeFile(file, "{not json");
      expect(await detectT3Runtime(directory)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resolves the T3 base dir like T3 and matches it to the configured URL", () => {
    expect(defaultT3BaseDir({ T3CODE_HOME: "/srv/t3" }, "/home/u")).toBe("/srv/t3");
    expect(defaultT3BaseDir({ T3_HOME: "/srv/wrong" }, "/home/u")).toBe("/home/u/.t3");
    expect(defaultT3BaseDir({ T3CODE_HOME: " " }, "/home/u")).toBe("/home/u/.t3");

    const baseDir = "/srv/t3";
    expect(t3BaseDirMismatch({ baseUrl: "http://127.0.0.1:3773", baseDir, detected: "http://127.0.0.1:3773" })).toBeUndefined();
    expect(t3BaseDirMismatch({ baseUrl: "http://localhost:3773", baseDir, detected: "http://127.0.0.1:3773" })).toBeUndefined();
    expect(t3BaseDirMismatch({ baseUrl: "http://127.0.0.1:3773", baseDir, detected: "http://127.0.0.1:3774" })).toContain(
      "belongs to the T3 server at http://127.0.0.1:3774",
    );
    expect(t3BaseDirMismatch({ baseUrl: "http://127.0.0.1:3773", baseDir, detected: undefined })).toContain("no running T3 server");
  });

  test("maps CLI flags to wizard options", () => {
    const options = onboardOptionsFromArguments(
      ["--yes", "--accept-risk", "--dir", "/srv/at", "--users=U1,U2", "--channels", "C1", "--repo", "/srv/r", "--t3-issue-token", "--no-install-service"],
      true,
    );
    expect(options).toMatchObject({
      interactive: false,
      acceptRisk: true,
      home: "/srv/at",
      allowedUserIds: "U1,U2",
      allowedChannelIds: "C1",
      repositoryRoots: "/srv/r",
      t3IssueToken: true,
      installService: false,
    });
    expect(onboardOptionsFromArguments([], false).interactive).toBe(false);
    expect(onboardOptionsFromArguments([], true).interactive).toBe(true);
    expect(() => onboardOptionsFromArguments(["--slack-bot-token", "xoxb-1"], true)).toThrow("unknown option");
    expect(() => onboardOptionsFromArguments(["--install-service", "--no-install-service"], true)).toThrow("mutually exclusive");
  });

  test("parses arguments strictly", () => {
    const parsed = parseArguments(["doctor.json", "--fix", "--lines=5", "--", "--literal"], {
      booleans: ["fix"],
      values: ["lines"],
    });
    expect(parsed.positionals).toEqual(["doctor.json", "--literal"]);
    expect(parsed.flags.has("fix")).toBe(true);
    expect(parsed.values.get("lines")).toBe("5");
    expect(() => parseArguments(["--lines"], { booleans: [], values: ["lines"] })).toThrow("requires a value");
    expect(() => parseArguments(["--fix=yes"], { booleans: ["fix"], values: [] })).toThrow("does not take a value");
  });

  test("resolves the config path from argument, environment, or onboarding default", () => {
    expect(resolveConfigPath("/a/b.json", {}, "/home/u")).toBe("/a/b.json");
    expect(resolveConfigPath(undefined, { AGENT_TAG_CONFIG: "/c/d.json" }, "/home/u")).toBe("/c/d.json");
    expect(resolveConfigPath(undefined, { AGENT_TAG_HOME: "/srv/at" }, "/home/u")).toBe("/srv/at/agent-tag.json");
    expect(resolveConfigPath(undefined, {}, "/home/u")).toBe("/home/u/.agent-tag/agent-tag.json");
  });
});
