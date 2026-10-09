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

  describe("model policy", () => {
    type Input = Record<string, any>;
    const withModels = (profile: Input = {}, route: Input = {}): Input => {
      const input: Input = structuredClone(baseConfig);
      Object.assign(input.profiles[0], profile);
      Object.assign(input.routes[0], route);
      return input;
    };
    const issues = (input: Input): ReadonlyArray<{ readonly path: string; readonly message: string }> => {
      const result = agentTagConfigSchema.safeParse(input);
      if (result.success) return [];
      return result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    };
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", aliases: ["opus"] };
    const mini = { instanceId: "codex", model: "gpt-5.6-mini", aliases: ["mini"] };

    test("a config without the new keys parses with defaults that allow only the default model", () => {
      const parsed = agentTagConfigSchema.parse(baseConfig);
      expect(parsed.profiles[0]!.allowedModels).toEqual([]);
      expect(parsed.profiles[0]!.modelSwitch).toEqual({ enabled: true, crossProvider: "before-first-turn" });
      expect(parsed.routes[0]!.defaultModel).toBeUndefined();
      // Defaults round-trip: parsing the parsed config is a fixed point.
      expect(agentTagConfigSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    test("the shipped example config parses with its codex and claudeAgent allowlist entries", async () => {
      const example = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();
      const parsed = agentTagConfigSchema.parse(example);
      expect(parsed.profiles[0]!.allowedModels).toEqual([
        { instanceId: "codex", model: "gpt-5.6-mini", label: "GPT-5.6 mini", aliases: ["mini"] },
        { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", aliases: ["opus"] },
      ]);
      expect(parsed.profiles[0]!.modelSwitch).toEqual({ enabled: true, crossProvider: "before-first-turn" });
    });

    test("accepts allowed models, aliases, labels and a route default from the allowed set", () => {
      const parsed = agentTagConfigSchema.parse(
        withModels(
          { allowedModels: [opus, mini], modelSwitch: { crossProvider: "deny" } },
          { defaultModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
        ),
      );
      expect(parsed.profiles[0]!.allowedModels).toEqual([opus, { ...mini }]);
      expect(parsed.profiles[0]!.modelSwitch).toEqual({ enabled: true, crossProvider: "deny" });
      expect(parsed.routes[0]!.defaultModel).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
      // The profile default may be listed to give it a label and aliases.
      expect(issues(withModels({ allowedModels: [{ instanceId: "codex", model: "gpt-5.6-sol", label: "Sol", aliases: ["sol"] }] }))).toEqual([]);
      // A route default may equal the profile default.
      expect(issues(withModels({}, { defaultModel: { instanceId: "codex", model: "gpt-5.6-sol" } }))).toEqual([]);
      // A label may repeat the entry's own alias.
      expect(issues(withModels({ allowedModels: [{ ...opus, label: "OPUS" }] }))).toEqual([]);
    });

    test("rejects malformed entries", () => {
      for (const entry of [
        { instanceId: "claude agent", model: "x" },
        { instanceId: "codex", model: "" },
        { instanceId: "codex", model: "x", aliases: ["Upper"] },
        { instanceId: "codex", model: "x", aliases: ["has space"] },
        { instanceId: "codex", model: "x", label: " " },
        { instanceId: "codex", model: "x", label: "x".repeat(41) },
        { instanceId: "codex", model: "x", provider: "codex" },
        { instanceId: "codex", model: "x", aliases: Array.from({ length: 9 }, (_, index) => `a${index}`) },
      ]) {
        expect(issues(withModels({ allowedModels: [entry] })).length).toBeGreaterThan(0);
      }
      const tooMany = Array.from({ length: 21 }, (_, index) => ({ instanceId: "codex", model: `m${index}` }));
      expect(issues(withModels({ allowedModels: tooMany })).length).toBeGreaterThan(0);
      expect(issues(withModels({ modelSwitch: { crossProvider: "restart-session" } })).length).toBeGreaterThan(0);
      expect(issues(withModels({ modelSwitch: { enabled: true, extra: 1 } })).length).toBeGreaterThan(0);
      expect(issues(withModels({}, { defaultModel: { instanceId: "codex" } })).length).toBeGreaterThan(0);
    });

    test("rejects duplicate entries, names and slug collisions with precise paths", () => {
      expect(issues(withModels({ allowedModels: [mini, { ...mini, aliases: [] }] }))).toEqual([
        { path: "profiles.0.allowedModels.1", message: "allowedModels entries must be unique" },
      ]);
      expect(issues(withModels({ allowedModels: [opus, { ...mini, label: " opus  5.5 " }] }))).toEqual([
        { path: "profiles.0.allowedModels.1.label", message: "labels and aliases must be unique within a profile" },
      ]);
      expect(issues(withModels({ allowedModels: [opus, { ...mini, aliases: ["fast", "opus"] }] }))).toEqual([
        { path: "profiles.0.allowedModels.1.aliases.1", message: "labels and aliases must be unique within a profile" },
      ]);
      // A label in one entry collides with an alias in another, case-insensitively.
      expect(issues(withModels({ allowedModels: [opus, { ...mini, label: "Mini" }, { instanceId: "codex", model: "o4", label: "MINI" }] }))).toEqual([
        { path: "profiles.0.allowedModels.2.label", message: "labels and aliases must be unique within a profile" },
      ]);
      expect(issues(withModels({ allowedModels: [{ ...mini, aliases: ["mini", "mini"] }] }))).toEqual([
        { path: "profiles.0.allowedModels.0.aliases.1", message: "aliases must be unique" },
      ]);
      expect(issues(withModels({ allowedModels: [opus, { ...mini, aliases: ["claude-opus-5-5"] }] }))).toEqual([
        { path: "profiles.0.allowedModels.1.aliases.0", message: "alias collides with another model's slug" },
      ]);
      // The profile default's slug is reserved too.
      expect(issues(withModels({ allowedModels: [{ ...opus, label: "GPT-5.6-SOL" }] }))).toEqual([
        { path: "profiles.0.allowedModels.0.label", message: "label collides with another model's slug" },
      ]);
    });

    test("rejects a route default outside the profile's allowed set, including a provider instance mismatch", () => {
      const message = "route defaultModel must be the profile default or one of its allowedModels";
      expect(issues(withModels({ allowedModels: [mini] }, { defaultModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" } })))
        .toEqual([{ path: "routes.0.defaultModel", message }]);
      // Same slug on another provider instance is a different model.
      expect(issues(withModels({ allowedModels: [mini] }, { defaultModel: { instanceId: "codex-work", model: "gpt-5.6-mini" } })))
        .toEqual([{ path: "routes.0.defaultModel", message }]);
      expect(issues(withModels({}, { defaultModel: { instanceId: "claudeAgent", model: "gpt-5.6-sol" } })))
        .toEqual([{ path: "routes.0.defaultModel", message }]);
    });
  });
});
