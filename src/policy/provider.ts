import type { AgentTagConfig } from "../config.ts";
import type { T3ServerInfo } from "../t3/gateway.ts";

export interface ValidatedProviderSelection {
  readonly profileId: string;
  readonly instanceId: string;
  readonly model: string;
}

export type ProviderSelectionErrorCode =
  | "provider-missing"
  | "provider-disabled"
  | "provider-not-ready"
  | "provider-unauthenticated"
  | "model-missing";

export class ProviderSelectionError extends Error {
  readonly code: ProviderSelectionErrorCode;
  readonly profileId: string;

  constructor(input: {
    readonly code: ProviderSelectionErrorCode;
    readonly profileId: string;
    readonly detail: string;
  }) {
    super(`profile ${input.profileId}: ${input.detail}`);
    this.name = "ProviderSelectionError";
    this.code = input.code;
    this.profileId = input.profileId;
  }
}

export interface ProviderEntry {
  readonly instanceId: string;
  readonly model: string;
}

/** Whether T3 can run `entry` right now: `null` when it can, else why not. */
export function checkProviderEntry(server: T3ServerInfo, entry: ProviderEntry): ProviderSelectionErrorCode | null {
  const provider = server.providers.find((candidate) => candidate.instanceId === entry.instanceId);
  if (provider === undefined) return "provider-missing";
  if (!provider.enabled || !provider.installed) return "provider-disabled";
  if (provider.status !== "ready") return "provider-not-ready";
  if (provider.auth.status !== "authenticated") return "provider-unauthenticated";
  if (!provider.models.some((model) => model.slug === entry.model)) return "model-missing";
  return null;
}

function selectionDetail(entry: ProviderEntry, code: ProviderSelectionErrorCode, server: T3ServerInfo): string {
  const provider = server.providers.find((candidate) => candidate.instanceId === entry.instanceId);
  const detail: Record<ProviderSelectionErrorCode, string> = {
    "provider-missing": `provider ${entry.instanceId} is not in the T3 catalog`,
    "provider-disabled": `provider ${entry.instanceId} is not enabled and installed`,
    "provider-not-ready": `provider ${entry.instanceId} reports ${provider?.status ?? "unknown"}`,
    "provider-unauthenticated": `provider ${entry.instanceId} is not authenticated`,
    "model-missing": `model ${entry.model} is not offered by provider ${entry.instanceId}`,
  };
  return detail[code];
}

/**
 * Strict startup check: every profile default and every route default must be runnable, else this
 * throws for the first one that is not. `allowedModels` entries are never checked here; see
 * {@link reportAllowedModels}.
 */
export function validateConfiguredProviders(
  config: AgentTagConfig,
  server: T3ServerInfo,
): ReadonlyArray<ValidatedProviderSelection> {
  const selections = config.profiles.map((profile) => {
    const entry = { instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel };
    const code = checkProviderEntry(server, entry);
    if (code !== null) {
      throw new ProviderSelectionError({ code, profileId: profile.id, detail: selectionDetail(entry, code, server) });
    }
    return { profileId: profile.id, ...entry };
  });
  for (const route of config.routes) {
    if (route.defaultModel === undefined) continue;
    const code = checkProviderEntry(server, route.defaultModel);
    if (code !== null) {
      throw new ProviderSelectionError({
        code,
        profileId: route.profileId,
        detail: `route ${route.conversationId} defaultModel: ${selectionDetail(route.defaultModel, code, server)}`,
      });
    }
  }
  return selections;
}

export type ModelSource = "profile-default" | "route-default" | "allowed";

export interface AllowedModelReport {
  readonly profileId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly source: ModelSource;
  /** `available`, `unchecked` when T3 was not inspected, or why T3 cannot run the model. */
  readonly status: "available" | "unchecked" | ProviderSelectionErrorCode;
}

/**
 * Every model each profile may run: its default, the defaults of routes that use it, and its
 * `allowedModels`, once each. Reports status per entry and never throws, so an unavailable allowlist
 * entry only warns. Pass `server: null` when T3 could not be inspected.
 */
export function reportAllowedModels(
  config: AgentTagConfig,
  server: T3ServerInfo | null,
): ReadonlyArray<AllowedModelReport> {
  const reports: AllowedModelReport[] = [];
  for (const profile of config.profiles) {
    const seen = new Set<string>();
    const add = (entry: ProviderEntry, source: ModelSource): void => {
      const key = `${entry.instanceId}\u0000${entry.model}`;
      if (seen.has(key)) return;
      seen.add(key);
      const configured = profile.allowedModels.find(
        (candidate) => candidate.instanceId === entry.instanceId && candidate.model === entry.model,
      );
      reports.push({
        profileId: profile.id,
        instanceId: entry.instanceId,
        model: entry.model,
        label: configured?.label ?? entry.model,
        source,
        status: server === null ? "unchecked" : (checkProviderEntry(server, entry) ?? "available"),
      });
    };
    add({ instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel }, "profile-default");
    for (const route of config.routes) {
      if (route.profileId === profile.id && route.defaultModel !== undefined) add(route.defaultModel, "route-default");
    }
    for (const entry of profile.allowedModels) add(entry, "allowed");
  }
  return reports;
}
