import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema } from "../src/config.ts";
import {
  checkProviderEntry,
  ProviderSelectionError,
  reportAllowedModels,
  validateConfiguredProviders,
} from "../src/policy/provider.ts";
import { type T3ServerInfo, t3ServerConfigSchema } from "../src/t3/gateway.ts";

const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 1 },
});

function catalog(input: {
  readonly status?: "ready" | "warning" | "error" | "disabled";
  readonly authenticated?: boolean;
  readonly models?: ReadonlyArray<string>;
} = {}): T3ServerInfo {
  return {
    environment: { environmentId: "fixture", capabilities: {} },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: input.status ?? "ready",
        auth: { status: input.authenticated === false ? "unauthenticated" : "authenticated" },
        models: (input.models ?? ["gpt-5.6-sol"]).map((slug) => ({
          slug,
          name: slug,
          capabilities: null,
        })),
      },
    ],
  };
}

describe("provider selection policy", () => {
  test("accepts an explicit ready authenticated provider and model", () => {
    expect(validateConfiguredProviders(config, catalog())).toEqual([
      { profileId: "engineering", instanceId: "codex", model: "gpt-5.6-sol" },
    ]);
  });

  test("fails clearly before dispatch when provider state or model is unsupported", () => {
    const cases: ReadonlyArray<{
      readonly server: T3ServerInfo;
      readonly code: ProviderSelectionError["code"];
    }> = [
      { server: catalog({ status: "warning" }), code: "provider-not-ready" },
      { server: catalog({ authenticated: false }), code: "provider-unauthenticated" },
      { server: catalog({ models: ["different-model"] }), code: "model-missing" },
    ];
    for (const { server, code } of cases) {
      try {
        validateConfiguredProviders(config, server);
        throw new Error("expected provider validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderSelectionError);
        if (!(error instanceof ProviderSelectionError)) throw error;
        expect(error.code).toBe(code);
        expect(error.profileId).toBe("engineering");
      }
    }
  });
});

const fixture: T3ServerInfo = t3ServerConfigSchema.parse(
  await Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json(),
);

describe("allowed model policy", () => {
  const policyConfig = agentTagConfigSchema.parse({
    ...config,
    profiles: [
      {
        ...config.profiles[0],
        allowedModels: [
          { instanceId: "codex", model: "gpt-5.6-mini", aliases: ["mini"] },
          { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5" },
          { instanceId: "claudeAgent", model: "claude-haiku-5" },
          { instanceId: "opencode", model: "big-pickle" },
          { instanceId: "pi", model: "pi-1" },
        ],
      },
    ],
    routes: [{ ...config.routes[0], defaultModel: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }],
  });

  test("checkProviderEntry names why T3 cannot run an entry", () => {
    expect(checkProviderEntry(fixture, { instanceId: "codex", model: "gpt-5.6-mini" })).toBeNull();
    expect(checkProviderEntry(fixture, { instanceId: "pi", model: "pi-1" })).toBe("provider-missing");
    expect(checkProviderEntry(fixture, { instanceId: "opencode", model: "big-pickle" })).toBe("provider-disabled");
    expect(checkProviderEntry(fixture, { instanceId: "claudeAgent", model: "claude-haiku-5" })).toBe("model-missing");
  });

  test("reports every allowed model with its source and status, without throwing", () => {
    expect(reportAllowedModels(policyConfig, fixture)).toEqual([
      { profileId: "engineering", instanceId: "codex", model: "gpt-5.6-sol", label: "gpt-5.6-sol", source: "profile-default", status: "available" },
      { profileId: "engineering", instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", source: "route-default", status: "available" },
      { profileId: "engineering", instanceId: "codex", model: "gpt-5.6-mini", label: "gpt-5.6-mini", source: "allowed", status: "available" },
      { profileId: "engineering", instanceId: "claudeAgent", model: "claude-haiku-5", label: "claude-haiku-5", source: "allowed", status: "model-missing" },
      { profileId: "engineering", instanceId: "opencode", model: "big-pickle", label: "big-pickle", source: "allowed", status: "provider-disabled" },
      { profileId: "engineering", instanceId: "pi", model: "pi-1", label: "pi-1", source: "allowed", status: "provider-missing" },
    ]);
    expect(reportAllowedModels(policyConfig, null).map((entry) => entry.status)).toEqual(Array(6).fill("unchecked"));
  });

  test("unavailable allowlist entries never fail strict validation", () => {
    expect(validateConfiguredProviders(policyConfig, fixture)).toEqual([
      { profileId: "engineering", instanceId: "codex", model: "gpt-5.6-sol" },
    ]);
  });

  test("route defaults are validated strictly", () => {
    const broken: T3ServerInfo = {
      ...fixture,
      providers: fixture.providers.map((provider) =>
        provider.instanceId === "claudeAgent" ? { ...provider, status: "error" as const } : provider,
      ),
    };
    try {
      validateConfiguredProviders(policyConfig, broken);
      throw new Error("expected route default validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSelectionError);
      if (!(error instanceof ProviderSelectionError)) throw error;
      expect(error.code).toBe("provider-not-ready");
      expect(error.message).toBe("profile engineering: route C1 defaultModel: provider claudeAgent reports error");
    }
  });
});

