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

  test("validates the status message keys", () => {
    const withUi = (ui: unknown) =>
      agentTagConfigSchema.safeParse({ ...baseConfig, slack: { ...baseConfig.slack, ui } });
    expect(withUi({ statusProgress: false }).data?.slack.ui).toEqual({
      ackReaction: "eyes",
      statusProgress: false,
      statusUpdateIntervalMs: 2_000,
      statusUpdatesPerMinute: 40,
    });
    expect(withUi({ statusUpdateIntervalMs: 999 }).success).toBe(false);
    expect(withUi({ statusUpdateIntervalMs: 5_000 }).data?.slack.ui.statusUpdateIntervalMs).toBe(5_000);
    expect(withUi({ statusUpdatesPerMinute: 0 }).success).toBe(false);
    expect(withUi({ statusMessage: true }).success).toBe(false);
  });

  test("defaults and validates the ack reaction", () => {
    expect(agentTagConfigSchema.parse(baseConfig).slack.ui).toEqual({ ackReaction: "eyes", statusProgress: true, statusUpdateIntervalMs: 2_000, statusUpdatesPerMinute: 40 });
    const withAck = (ackReaction: unknown) =>
      agentTagConfigSchema.safeParse({ ...baseConfig, slack: { ...baseConfig.slack, ui: { ackReaction } } });
    expect(withAck(null).data?.slack.ui.ackReaction).toBeNull();
    expect(withAck("white_check_mark").data?.slack.ui.ackReaction).toBe("white_check_mark");
    expect(withAck("thumbsup::skin-tone-3").success).toBe(true);
    for (const invalid of [":eyes:", "", "Eyes", "eyes and more", "x".repeat(101)]) {
      expect(withAck(invalid).success).toBe(false);
    }
    expect(
      agentTagConfigSchema.safeParse({ ...baseConfig, slack: { ...baseConfig.slack, ui: { unknownKey: true } } }).success,
    ).toBe(false);
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
        { path: "profiles.0.allowedModels.1.aliases.0", message: "alias collides with another model's slug or instance/model" },
      ]);
      // The profile default's slug is reserved too.
      expect(issues(withModels({ allowedModels: [{ ...opus, label: "GPT-5.6-SOL" }] }))).toEqual([
        { path: "profiles.0.allowedModels.0.label", message: "label collides with another model's slug or instance/model" },
      ]);
      // A label equal to another model's `instance/model` would resolve to that model first.
      expect(issues(withModels({ allowedModels: [{ ...opus, label: "Codex/GPT-5.6-sol" }] }))).toEqual([
        { path: "profiles.0.allowedModels.0.label", message: "label collides with another model's slug or instance/model" },
      ]);
      // Its own qualified name is harmless.
      expect(issues(withModels({ allowedModels: [{ ...opus, label: "claudeAgent/claude-opus-5-5" }] }))).toEqual([]);
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

  describe("thread context", () => {
    const validThreadContext = {
      enabled: true,
      maxMessages: 30,
      maxChars: 12_000,
      maxMessageChars: 2_000,
      includeBotMessages: "root-only",
      includeNonAllowedUsers: true,
    };
    // Overrides merge over a fully valid block so each test fails only on the key under test.
    const withThreadContext = (overrides: Record<string, unknown>) => {
      const input = structuredClone(baseConfig);
      Object.assign(input.profiles[0]!, { threadContext: { ...validThreadContext, ...overrides } });
      return input;
    };

    test("a profile without threadContext gets the defaults", () => {
      expect(agentTagConfigSchema.parse(baseConfig).profiles[0]!.threadContext).toEqual({
        enabled: true,
        maxMessages: 30,
        maxChars: 12_000,
        maxMessageChars: 2_000,
        includeBotMessages: "root-only",
        includeNonAllowedUsers: true,
      });
    });

    test("rejects maxMessageChars above maxChars at the threadContext path", () => {
      const result = agentTagConfigSchema.safeParse(
        withThreadContext({ maxChars: 1_000, maxMessageChars: 10_000 }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["profiles", 0, "threadContext", "maxMessageChars"],
          message: "threadContext.maxMessageChars must not exceed maxChars",
        }),
      );
      // Equal limits are allowed.
      expect(
        agentTagConfigSchema.safeParse(withThreadContext({ maxChars: 2_000, maxMessageChars: 2_000 })).success,
      ).toBe(true);
    });

    test("rejects out-of-range maxMessages", () => {
      for (const maxMessages of [0, 201]) {
        expect(agentTagConfigSchema.safeParse(withThreadContext({ maxMessages })).success).toBe(false);
      }
      expect(agentTagConfigSchema.safeParse(withThreadContext({ maxMessages: 200 })).success).toBe(true);
    });

    test("accepts includeBotMessages set to all", () => {
      const parsed = agentTagConfigSchema.parse(withThreadContext({ includeBotMessages: "all" }));
      expect(parsed.profiles[0]!.threadContext.includeBotMessages).toBe("all");
      expect(parsed.profiles[0]!.threadContext.maxMessages).toBe(30);
    });
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
      watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 },
    });
  });

  test("managed mode derives the loopback baseUrl and data-dir defaults", () => {
    const { t3 } = agentTagConfigSchema.parse(withT3(managedBase));
    expect(t3).toEqual({
      mode: "managed",
      baseUrl: "http://127.0.0.1:37841",
      tokenFile: "/secrets/t3",
      watch: { enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 },
      managed: {
        port: 37841,
        homeDir: "/var/lib/agent-tag/t3/home",
        runtimeDir: "/var/lib/agent-tag/t3/runtime",
        autoInstall: true,
        rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
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
      rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 15 },
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

  describe("managed rotation", () => {
    const withRotation = (rotation: Record<string, unknown>) => withT3({ ...managedBase, rotation });
    const rotationAccepts = (rotation: Record<string, unknown>) =>
      agentTagConfigSchema.safeParse(withRotation(rotation)).success;

    test("defaults to rotating 7 days before expiry with a 15 minute revoke grace when omitted", () => {
      expect(managedOf(agentTagConfigSchema.parse(withT3(managedBase)).t3).rotation).toEqual({
        rotateBeforeDays: 7,
        revokeGraceMinutes: 15,
      });
    });

    test("resolves a custom rotation and fills the key that is left out", () => {
      expect(managedOf(agentTagConfigSchema.parse(withRotation({ rotateBeforeDays: 3, revokeGraceMinutes: 60 })).t3).rotation)
        .toEqual({ rotateBeforeDays: 3, revokeGraceMinutes: 60 });
      expect(managedOf(agentTagConfigSchema.parse(withRotation({ rotateBeforeDays: 3 })).t3).rotation)
        .toEqual({ rotateBeforeDays: 3, revokeGraceMinutes: 15 });
    });

    test("accepts the inclusive range bounds", () => {
      expect(rotationAccepts({ rotateBeforeDays: 1, revokeGraceMinutes: 1 })).toBe(true);
      expect(rotationAccepts({ rotateBeforeDays: 25, revokeGraceMinutes: 1_440 })).toBe(true);
    });

    test("rejects out-of-range values, non-integers, and unknown keys", () => {
      for (const rotation of [
        { rotateBeforeDays: 0 },
        { rotateBeforeDays: 26 },
        { rotateBeforeDays: 1.5 },
        { revokeGraceMinutes: 0 },
        { revokeGraceMinutes: 1_441 },
        { rotateBeforeDays: 7, unknown: true },
      ]) {
        expect(rotationAccepts(rotation)).toBe(false);
      }
    });
  });
});
