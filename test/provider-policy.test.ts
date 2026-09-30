import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema } from "../src/config.ts";
import {
  ProviderSelectionError,
  validateConfiguredProviders,
} from "../src/policy/provider.ts";
import type { T3ServerInfo } from "../src/t3/gateway.ts";

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
