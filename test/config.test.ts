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
