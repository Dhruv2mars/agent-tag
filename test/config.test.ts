import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema, type ResolvedT3Config } from "../src/config.ts";

const baseConfig = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/secrets/t3" },
  slack: {
    workspaceId: "T123",
    appTokenFile: "/secrets/slack-app",
    botTokenFile: "/secrets/slack-bot",
  },
  access: { allowedUserIds: ["U123"], allowedChannelIds: ["C123"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/repos/example"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "approval-required", allowedTools: ["github"] },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [
    { conversationId: "C123", profileId: "engineering", repositoryRoot: "/repos/example" },
  ],
  limits: { maxConcurrentTasks: 2 },
};

describe("Agent Tag config", () => {
  test("defaults and validates the stalled-turn policy", () => {
    expect(agentTagConfigSchema.parse(baseConfig).limits.stalledTurn).toEqual({
      timeoutSeconds: 300,
      retryDelaySeconds: 30,
      maxAttempts: 5,
      maxTurnSeconds: 21_600,
    });
    expect(() =>
      agentTagConfigSchema.parse({
        ...baseConfig,
        limits: {
          ...baseConfig.limits,
          stalledTurn: { timeoutSeconds: 0, retryDelaySeconds: 30, maxAttempts: 5 },
        },
      }),
    ).toThrow();
  });

  test("defaults and validates the routine auto-disable policy", () => {
    expect(agentTagConfigSchema.parse(baseConfig).routines).toEqual({
      autoDisable: { consecutiveFailures: 3, minFailureSpanSeconds: 3_600 },
    });
    expect(
      agentTagConfigSchema.parse({ ...baseConfig, routines: { autoDisable: { consecutiveFailures: 5 } } }).routines,
    ).toEqual({ autoDisable: { consecutiveFailures: 5, minFailureSpanSeconds: 3_600 } });
    for (const autoDisable of [
      { consecutiveFailures: 0 },
      { consecutiveFailures: 51 },
      { minFailureSpanSeconds: -1 },
      { minFailureSpanSeconds: 604_801 },
      { unknown: true },
    ]) {
      expect(() => agentTagConfigSchema.parse({ ...baseConfig, routines: { autoDisable } })).toThrow();
    }
  });

  test("defaults and validates the turn ceiling and interaction expiry", () => {
    const parsed = agentTagConfigSchema.parse(baseConfig);
    expect(parsed.limits.interactionExpirySeconds).toBe(86_400);
    const withLimits = (limits: Record<string, unknown>) => ({
      ...baseConfig,
      limits: { ...baseConfig.limits, ...limits },
    });
    // An explicit stalledTurn without the newer key still gets the 6h ceiling.
    expect(
      agentTagConfigSchema.parse(
        withLimits({ stalledTurn: { timeoutSeconds: 120, retryDelaySeconds: 30, maxAttempts: 5 } }),
      ).limits.stalledTurn.maxTurnSeconds,
    ).toBe(21_600);
    // A pre-ceiling config with a stall timeout above 6h stays valid; the ceiling follows the timeout.
    expect(
      agentTagConfigSchema.parse(
        withLimits({ stalledTurn: { timeoutSeconds: 86_400, retryDelaySeconds: 30, maxAttempts: 5 } }),
      ).limits.stalledTurn.maxTurnSeconds,
    ).toBe(86_400);
    expect(() =>
      agentTagConfigSchema.parse(
        withLimits({ stalledTurn: { timeoutSeconds: 600, retryDelaySeconds: 30, maxAttempts: 5, maxTurnSeconds: 300 } }),
      ),
    ).toThrow("maxTurnSeconds must be at least timeoutSeconds");
    expect(() => agentTagConfigSchema.parse(withLimits({ interactionExpirySeconds: 59 }))).toThrow();
    expect(() => agentTagConfigSchema.parse(withLimits({ interactionExpirySeconds: 1.5 }))).toThrow();
    expect(agentTagConfigSchema.parse(withLimits({ interactionExpirySeconds: 3_600 })).limits.interactionExpirySeconds)
      .toBe(3_600);
  });

  test("rejects a remote T3 endpoint", () => {
    const input = structuredClone(baseConfig);
    input.t3.baseUrl = "https://t3.example.com";
    expect(() => agentTagConfigSchema.parse(input)).toThrow("T3 must use a loopback URL");
  });

  test("rejects a route outside the profile repository allowlist", () => {
    const input = structuredClone(baseConfig);
    input.routes[0]!.repositoryRoot = "/repos/other";
    expect(() => agentTagConfigSchema.parse(input)).toThrow(
      "route repositoryRoot is outside the profile allowlist",
    );
  });

  test("rejects a route to a channel outside the access list", () => {
    const input = structuredClone(baseConfig);
    input.routes[0]!.conversationId = "C999";
    expect(() => agentTagConfigSchema.parse(input)).toThrow(
      "route conversation is not in access.allowedChannelIds",
    );
  });

  test("requires DM routes to bind an allowed owner and a private-memory profile", () => {
    const profile = baseConfig.profiles[0];
    if (profile === undefined) throw new Error("base profile is missing");
    expect(() =>
      agentTagConfigSchema.parse({
        ...baseConfig,
        access: { ...baseConfig.access, allowedChannelIds: ["D123"] },
        routes: [
          {
            conversationId: "D123",
            conversationType: "dm",
            ownerUserId: "U123",
            profileId: "engineering",
            repositoryRoot: "/repos/example",
          },
        ],
      }),
    ).toThrow("DM route profile must enable privateDm memory isolation");
    expect(() =>
      agentTagConfigSchema.parse({
        ...baseConfig,
        access: { ...baseConfig.access, allowedChannelIds: ["D123"] },
        profiles: [{ ...profile, memory: { ...profile.memory, privateDm: true } }],
        routes: [
          {
            conversationId: "D123",
            conversationType: "dm",
            ownerUserId: "U999",
            profileId: "engineering",
            repositoryRoot: "/repos/example",
          },
        ],
      }),
    ).toThrow("DM route owner is not in access.allowedUserIds");
  });

  test("rejects ambiguous duplicate conversation routes", () => {
    expect(() =>
      agentTagConfigSchema.parse({
        ...baseConfig,
        routes: [...baseConfig.routes, ...baseConfig.routes],
      }),
    ).toThrow("route conversation ids must be unique");
  });
});

describe("t3 config", () => {
  const managedBase = { mode: "managed", tokenFile: "/secrets/t3" };
  const withT3 = (t3: Record<string, unknown>) => ({ ...baseConfig, t3 });
  const managedOf = (t3: ResolvedT3Config) => {
    if (t3.mode !== "managed") throw new Error(`expected managed t3, got ${t3.mode}`);
    return t3.managed;
  };

  test("a legacy t3 block without mode parses as external", () => {
    expect(agentTagConfigSchema.parse(baseConfig).t3).toEqual({
      mode: "external",
      baseUrl: "http://127.0.0.1:37841",
      tokenFile: "/secrets/t3",
    });
  });

  test("managed mode derives the loopback baseUrl and data-dir defaults", () => {
    const { t3 } = agentTagConfigSchema.parse(withT3(managedBase));
    expect(t3).toEqual({
      mode: "managed",
      baseUrl: "http://127.0.0.1:37841",
      tokenFile: "/secrets/t3",
      managed: {
        port: 37841,
        homeDir: "/var/lib/agent-tag/t3/home",
        runtimeDir: "/var/lib/agent-tag/t3/runtime",
        autoInstall: true,
      },
    });
    expect(managedOf(t3)).not.toHaveProperty("downloadBaseUrl");
  });

  test("managed mode derives baseUrl from a custom port and keeps explicit dirs", () => {
    const { t3 } = agentTagConfigSchema.parse(
      withT3({
        ...managedBase,
        port: 40_000,
        homeDir: "/srv/t3/home",
        runtimeDir: "/srv/t3/runtime",
      }),
    );
    expect(t3.baseUrl).toBe("http://127.0.0.1:40000");
    expect(managedOf(t3)).toEqual({
      port: 40_000,
      homeDir: "/srv/t3/home",
      runtimeDir: "/srv/t3/runtime",
      autoInstall: true,
    });
  });

  test("rejects a managed homeDir equal to the desktop ~/.t3 base dir", () => {
    const result = agentTagConfigSchema.safeParse(
      withT3({ ...managedBase, homeDir: join(homedir(), ".t3") }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["t3", "homeDir"] }));
  });

  test("rejects a managed homeDir equal to $T3CODE_HOME", async () => {
    const previous = process.env.T3CODE_HOME;
    const dir = await mkdtemp(join(tmpdir(), "agent-tag-t3-home-"));
    process.env.T3CODE_HOME = dir;
    try {
      const result = agentTagConfigSchema.safeParse(withT3({ ...managedBase, homeDir: dir }));
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["t3", "homeDir"] }));
    } finally {
      if (previous === undefined) delete process.env.T3CODE_HOME;
      else process.env.T3CODE_HOME = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validates the managed download mirror", () => {
    const parse = (downloadBaseUrl: string) =>
      agentTagConfigSchema.safeParse(withT3({ ...managedBase, downloadBaseUrl }));
    expect(parse("http://mirror.example").success).toBe(false);

    const accepted = parse("https://mirror.example/releases");
    expect(accepted.success).toBe(true);
    if (!accepted.success) throw new Error("https mirror should parse");
    expect(managedOf(accepted.data.t3).downloadBaseUrl).toBe("https://mirror.example/releases");

    // parseT3DownloadBaseUrl strips trailing slashes from an accepted mirror.
    const trailing = parse("https://mirror.example/releases/");
    expect(trailing.success).toBe(true);
    if (!trailing.success) throw new Error("https mirror with trailing slash should parse");
    expect(managedOf(trailing.data.t3).downloadBaseUrl).toBe("https://mirror.example/releases");
  });

  test("rejects a managed homeDir equal to runtimeDir", () => {
    const result = agentTagConfigSchema.safeParse(
      withT3({ ...managedBase, homeDir: "/srv/t3/shared", runtimeDir: "/srv/t3/shared" }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["t3", "runtimeDir"], message: "t3.runtimeDir must differ from t3.homeDir" }),
    );
  });

  test("rejects a managed port below 1024 and a non-loopback external baseUrl", () => {
    expect(agentTagConfigSchema.safeParse(withT3({ ...managedBase, port: 80 })).success).toBe(false);
    expect(
      agentTagConfigSchema.safeParse(
        withT3({ mode: "external", baseUrl: "http://192.168.1.10:37841", tokenFile: "/secrets/t3" }),
      ).success,
    ).toBe(false);
  });

  test("rejects an unknown t3 mode", () => {
    expect(
      agentTagConfigSchema.safeParse(
        withT3({ mode: "remote", baseUrl: "http://127.0.0.1:37841", tokenFile: "/secrets/t3" }),
      ).success,
    ).toBe(false);
  });
});
