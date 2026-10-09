import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import {
  allowedChoices,
  effectiveSelection,
  type ModelChoice,
  planSwitch,
  resolveModelQuery,
} from "../src/policy/models.ts";
import { validateConfiguredProviders } from "../src/policy/provider.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { type T3Command, type T3ServerInfo, t3ServerConfigSchema, type T3ThreadSnapshot } from "../src/t3/gateway.ts";

// Real 0.0.45 `server.getConfig` shape; see test/t3-gateway.test.ts for where it was checked.
const catalog: T3ServerInfo = t3ServerConfigSchema.parse(
  await Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json(),
);
const example: unknown = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

function configWith(profile: Record<string, unknown> = {}, route: Record<string, unknown> = {}): AgentTagConfig {
  const input = structuredClone(example) as Record<string, any>;
  Object.assign(input.profiles[0], profile);
  Object.assign(input.routes[0], route);
  return agentTagConfigSchema.parse(input);
}

const policyConfig = configWith(
  {
    allowedModels: [
      { instanceId: "codex", model: "gpt-5.6-sol", label: "Sol", aliases: ["sol"] },
      { instanceId: "codex", model: "gpt-5.6-mini", label: "GPT Mini", aliases: ["mini", "fast"] },
      { instanceId: "codex-work", model: "gpt-5.6-sol", label: "Work Sol" },
      { instanceId: "claudeAgent", model: "claude-opus-5-5", label: "Opus 5.5", aliases: ["opus", "claude"] },
      { instanceId: "claudeAgent", model: "claude-sonnet-5", label: "Sonnet", aliases: ["sonnet"] },
      { instanceId: "grok", model: "grok-5", label: "Grok" },
      { instanceId: "grok", model: "grok-5-fast", label: "Grok Fast" },
    ],
  },
  { defaultModel: { instanceId: "codex", model: "gpt-5.6-mini" } },
);
const profile = policyConfig.profiles[0]!;
const route = policyConfig.routes[0]!;
const choices = allowedChoices(profile, route);
const choice = (instanceId: string, model: string): ModelChoice => {
  const found = choices.find((candidate) => candidate.instanceId === instanceId && candidate.model === model);
  if (found === undefined) throw new Error(`no choice ${instanceId}/${model}`);
  return found;
};

describe("allowed choices", () => {
  test("lists the profile default, route default and allowlist once each, labelled from the allowlist", () => {
    expect(choices.map((entry) => [`${entry.instanceId}/${entry.model}`, entry.label, entry.source])).toEqual([
      ["codex/gpt-5.6-sol", "Sol", "profile-default"],
      ["codex/gpt-5.6-mini", "GPT Mini", "route-default"],
      ["codex-work/gpt-5.6-sol", "Work Sol", "allowed"],
      ["claudeAgent/claude-opus-5-5", "Opus 5.5", "allowed"],
      ["claudeAgent/claude-sonnet-5", "Sonnet", "allowed"],
      ["grok/grok-5", "Grok", "allowed"],
      ["grok/grok-5-fast", "Grok Fast", "allowed"],
    ]);
    expect(choice("codex", "gpt-5.6-sol").aliases).toEqual(["sol"]);
  });

  test("an existing config allows only its default, labelled by slug", () => {
    // The example config without the P2a keys, as an existing install has it.
    const input = structuredClone(example) as Record<string, any>;
    delete input.profiles[0].allowedModels;
    const legacy = agentTagConfigSchema.parse(input);
    expect(allowedChoices(legacy.profiles[0]!, legacy.routes[0])).toEqual([
      { instanceId: "codex", model: "gpt-5.6-sol", label: "gpt-5.6-sol", aliases: [], source: "profile-default" },
    ]);
    expect(allowedChoices(legacy.profiles[0]!, null)).toHaveLength(1);
  });
});

describe("resolveModelQuery", () => {
  const match = (query: string): string | undefined => {
    const result = resolveModelQuery(choices, query);
    return result.kind === "match" ? `${result.choice.instanceId}/${result.choice.model}` : result.kind;
  };

  test("resolves each tier", () => {
    expect(match("codex-work/gpt-5.6-sol")).toBe("codex-work/gpt-5.6-sol");
    expect(match("CLAUDE-SONNET-5")).toBe("claudeAgent/claude-sonnet-5");
    expect(match("  opus   5.5 ")).toBe("claudeAgent/claude-opus-5-5");
    expect(match("Opus")).toBe("claudeAgent/claude-opus-5-5");
    expect(match("FAST")).toBe("codex/gpt-5.6-mini");
    expect(match("unknown")).toBe("none");
    expect(match("   ")).toBe("none");
  });

  test("an earlier tier wins over a later one", () => {
    // "gpt-5.6-sol" is a slug on two instances (ambiguous at the slug tier), but exact instance/model wins.
    expect(match("codex/gpt-5.6-sol")).toBe("codex/gpt-5.6-sol");
    const shadow: ModelChoice[] = [
      { instanceId: "a", model: "alpha", label: "beta", aliases: [], source: "allowed" },
      { instanceId: "b", model: "beta", label: "Beta model", aliases: ["alpha"], source: "allowed" },
    ];
    const resolve = (query: string) => {
      const result = resolveModelQuery(shadow, query);
      return result.kind === "match" ? result.choice.model : result.kind;
    };
    expect(resolve("beta")).toBe("beta"); // slug beats label
    expect(resolve("alpha")).toBe("alpha"); // slug beats alias
  });

  test("reports ambiguity instead of guessing", () => {
    const slug = resolveModelQuery(choices, "gpt-5.6-sol");
    expect(slug.kind).toBe("ambiguous");
    if (slug.kind === "ambiguous") {
      expect(slug.candidates.map((entry) => entry.instanceId)).toEqual(["codex", "codex-work"]);
    }
    // Bare instance ids resolve only when the instance has exactly one choice.
    expect(match("codex-work")).toBe("codex-work/gpt-5.6-sol");
    expect(match("claudeagent")).toBe("ambiguous");
  });
});

describe("effectiveSelection", () => {
  const sol = { instanceId: "codex", model: "gpt-5.6-sol" };
  const mini = { instanceId: "codex", model: "gpt-5.6-mini" };
  const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const run = (task: { desired: typeof sol | null; applied: typeof sol | null }, routeOverride = route) =>
    effectiveSelection({ task, profile, route: routeOverride, catalog });

  test("uses an allowed desired selection", () => {
    expect(run({ desired: opus, applied: null })).toEqual({ selection: opus, reason: "desired", revoked: false });
    expect(run({ desired: sol, applied: mini })).toEqual({ selection: sol, reason: "desired", revoked: false });
  });

  test("falls back to the route default, else the profile default", () => {
    expect(run({ desired: null, applied: null })).toEqual({ selection: mini, reason: "route-default", revoked: false });
    const plainRoute = { ...route, defaultModel: undefined };
    expect(run({ desired: null, applied: null }, plainRoute)).toEqual({ selection: sol, reason: "profile-default", revoked: false });
    expect(effectiveSelection({ task: { desired: null, applied: null }, profile, route: null }).reason).toBe("profile-default");
  });

  test("a revoked desired selection falls back on the same driver and sticks across drivers", () => {
    const revoked = { instanceId: "claudeAgent", model: "claude-haiku-5" };
    expect(run({ desired: revoked, applied: null })).toEqual({ selection: mini, reason: "route-default", revoked: true });
    // Applied on another codex instance: same driver, so the default applies.
    expect(run({ desired: revoked, applied: { instanceId: "codex-work", model: "gpt-5.6-sol" } }))
      .toEqual({ selection: mini, reason: "route-default", revoked: true });
    expect(run({ desired: revoked, applied: revoked })).toEqual({ selection: revoked, reason: "sticky-applied", revoked: true });
  });

  test("a default moved to another driver keeps a started thread on its applied selection", () => {
    expect(run({ desired: null, applied: opus })).toEqual({ selection: opus, reason: "sticky-applied", revoked: false });
    // Without a catalog only the same instance is known to be the same driver.
    expect(effectiveSelection({ task: { desired: null, applied: { instanceId: "codex-work", model: "gpt-5.6-sol" } }, profile, route }))
      .toEqual({ selection: { instanceId: "codex-work", model: "gpt-5.6-sol" }, reason: "sticky-applied", revoked: false });
  });
});

describe("planSwitch", () => {
  const policy = profile.modelSwitch;
  const sol = { instanceId: "codex", model: "gpt-5.6-sol" };
  const plan = (input: {
    current?: { instanceId: string; model: string };
    target: ModelChoice;
    threadStarted: boolean;
    catalog?: T3ServerInfo | null;
    policy?: typeof policy;
  }) => planSwitch({
    current: input.current ?? sol,
    target: input.target,
    threadStarted: input.threadStarted,
    catalog: input.catalog === undefined ? catalog : input.catalog,
    policy: input.policy ?? policy,
  });
  const withProvider = (instanceId: string, change: Record<string, unknown>): T3ServerInfo => ({
    ...catalog,
    providers: catalog.providers.map((provider) => provider.instanceId === instanceId ? { ...provider, ...change } : provider),
  });

  test("matrix over driver, thread state and catalog", () => {
    const cases: ReadonlyArray<readonly [string, Parameters<typeof plan>[0], ReturnType<typeof plan>]> = [
      ["same selection", { target: choice("codex", "gpt-5.6-sol"), threadStarted: true }, { kind: "noop" }],
      ["same instance, started", { target: choice("codex", "gpt-5.6-mini"), threadStarted: true }, { kind: "in-place" }],
      ["same instance, new thread", { target: choice("codex", "gpt-5.6-mini"), threadStarted: false }, { kind: "pre-start" }],
      ["other driver, new thread", { target: choice("claudeAgent", "claude-opus-5-5"), threadStarted: false }, { kind: "pre-start" }],
      ["other driver, started", { target: choice("claudeAgent", "claude-opus-5-5"), threadStarted: true }, { kind: "refused", code: "cross-provider-started" }],
      ["same driver, other group key", { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: true }, { kind: "refused", code: "incompatible-continuation" }],
      [
        "same driver, equal group key",
        { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: true, catalog: withProvider("codex-work", { continuation: { groupKey: "codex:home:/Users/fixture/.codex" } }) },
        { kind: "in-place" },
      ],
      [
        "same driver, group key missing on one side",
        { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: true, catalog: withProvider("codex", { continuation: undefined }) },
        { kind: "refused", code: "incompatible-continuation" },
      ],
      ["target requires a new thread", { current: { instanceId: "grok", model: "grok-5" }, target: choice("grok", "grok-5-fast"), threadStarted: true }, { kind: "refused", code: "requires-new-thread" }],
      ["current requires a new thread", { current: { instanceId: "grok", model: "grok-5" }, target: choice("codex", "gpt-5.6-sol"), threadStarted: true }, { kind: "refused", code: "requires-new-thread" }],
      ["requires a new thread, not started", { current: { instanceId: "grok", model: "grok-5" }, target: choice("grok", "grok-5-fast"), threadStarted: false }, { kind: "pre-start" }],
      ["current provider gone", { current: { instanceId: "retired", model: "x" }, target: choice("codex", "gpt-5.6-sol"), threadStarted: true }, { kind: "refused", code: "incompatible-continuation", detail: "current-provider-missing" }],
      ["target not runnable", { target: choice("claudeAgent", "claude-opus-5-5"), threadStarted: false, catalog: withProvider("claudeAgent", { auth: { status: "unauthenticated" } }) }, { kind: "refused", code: "unavailable", detail: "provider-unauthenticated" }],
      ["target model gone", { target: choice("codex", "gpt-5.6-mini"), threadStarted: true, catalog: withProvider("codex", { models: [] }) }, { kind: "refused", code: "unavailable", detail: "model-missing" }],
      ["no catalog, same instance, started", { target: choice("codex", "gpt-5.6-mini"), threadStarted: true, catalog: null }, { kind: "in-place" }],
      ["no catalog, other instance, started", { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: true, catalog: null }, { kind: "refused", code: "unavailable", detail: "catalog-unavailable" }],
      ["no catalog, new thread", { target: choice("claudeAgent", "claude-opus-5-5"), threadStarted: false, catalog: null }, { kind: "pre-start" }],
      ["deny, other driver, new thread", { target: choice("claudeAgent", "claude-opus-5-5"), threadStarted: false, policy: { enabled: true, crossProvider: "deny" } }, { kind: "refused", code: "cross-provider-denied" }],
      ["deny, same driver other instance, new thread", { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: false, policy: { enabled: true, crossProvider: "deny" } }, { kind: "pre-start" }],
      ["deny, no catalog, other instance", { target: choice("codex-work", "gpt-5.6-sol"), threadStarted: false, catalog: null, policy: { enabled: true, crossProvider: "deny" } }, { kind: "refused", code: "cross-provider-denied" }],
      ["switching disabled", { target: choice("codex", "gpt-5.6-mini"), threadStarted: false, policy: { enabled: false, crossProvider: "before-first-turn" } }, { kind: "refused", code: "switch-disabled" }],
    ];
    for (const [name, input, expected] of cases) {
      expect({ name, plan: plan(input) }).toEqual({ name, plan: expected });
    }
  });
});

describe("no runtime change for existing configs", () => {
  function startedSnapshot(threadId: string): T3ThreadSnapshot {
    const at = "2026-10-08T00:00:00.000Z";
    return {
      snapshotSequence: 3,
      thread: {
        id: threadId,
        projectId: "project-1",
        title: "Fixture",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: { turnId: "turn-1", state: "completed", requestedAt: at, startedAt: at, completedAt: at, assistantMessageId: "a-1" },
        messages: [{ id: "a-1", role: "assistant", text: "done", turnId: "turn-1", streaming: false, createdAt: at, updatedAt: at }],
        activities: [],
        session: null,
      },
    };
  }

  /** Runs one Slack request through the real coordinator and returns every selection it sent T3. */
  async function dispatchedSelections(config: AgentTagConfig): Promise<ReadonlyArray<unknown>> {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-model-regression-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const commands: T3Command[] = [];
    let threadId = "pending";
    try {
      const routeConfig = config.routes[0]!;
      const coordinator = new AgentTagCoordinator({
        config,
        store,
        t3: {
          dispatch: async (command) => {
            commands.push(command);
            if (command.type === "thread.turn.start") threadId = command.threadId;
            return { sequence: commands.length };
          },
          fetchThread: async () => startedSnapshot(threadId),
        },
        workerId: "worker-regression",
        now: () => new Date("2026-10-08T00:00:00.000Z"),
        sleep: async () => undefined,
      });
      store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: `${routeConfig.conversationId}:1000.000001`,
        workspaceId: config.slack.workspaceId,
        conversationId: routeConfig.conversationId,
        threadTs: "1000.000001",
        actorUserId: config.access.allowedUserIds[0]!,
        conversationType: "channel",
        profileId: routeConfig.profileId,
        repositoryRoot: routeConfig.repositoryRoot!,
        text: "request",
        receivedAt: "2026-10-08T00:00:00.000Z",
        sourceOrderKey: "1000.000001",
      });
      expect(await coordinator.processNext()).toMatchObject({ kind: "completed" });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
    expect(commands.some((command) => command.type === "thread.meta.update")).toBe(false);
    return commands.flatMap((command) => {
      if (command.type === "project.create") return [["project.create", command.defaultModelSelection]];
      if (command.type === "thread.turn.start") {
        return [["thread.turn.start", command.modelSelection, command.bootstrap?.createThread?.modelSelection]];
      }
      return [];
    });
  }

  test("the example config's selection is unchanged, and the policy layer agrees with the coordinator", async () => {
    const legacy = agentTagConfigSchema.parse(example);
    const legacyProfile = legacy.profiles[0]!;
    const selection = { instanceId: legacyProfile.defaultProviderInstanceId, model: legacyProfile.defaultModel };
    expect(selection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });

    expect(await dispatchedSelections(legacy)).toEqual([
      ["project.create", selection],
      ["thread.turn.start", selection, selection],
    ]);
    // P2b replaces the coordinator's hard-coded default with effectiveSelection; for an existing config and
    // a task with no recorded selections it must pick exactly what the coordinator sends today.
    expect(effectiveSelection({ task: { desired: null, applied: null }, profile: legacyProfile, route: legacy.routes[0], catalog }))
      .toEqual({ selection, reason: "profile-default", revoked: false });
    expect(validateConfiguredProviders(legacy, catalog)).toEqual([{ profileId: "engineering", ...selection }]);
  });

  test("P2a policy keys alone do not change what the coordinator sends", async () => {
    // Not yet wired: a route default and allowlist are accepted and reported, but turns keep the profile default.
    const selection = { instanceId: "codex", model: "gpt-5.6-sol" };
    expect(await dispatchedSelections(policyConfig)).toEqual([
      ["project.create", selection],
      ["thread.turn.start", selection, selection],
    ]);
  });
});
