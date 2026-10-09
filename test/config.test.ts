import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema } from "../src/config.ts";

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
