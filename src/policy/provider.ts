import type { AgentTagConfig } from "../config.ts";
import type { T3ServerInfo } from "../t3/gateway.ts";

export interface ValidatedProviderSelection {
  readonly profileId: string;
  readonly instanceId: string;
  readonly model: string;
}

export class ProviderSelectionError extends Error {
  readonly code:
    | "provider-missing"
    | "provider-disabled"
    | "provider-not-ready"
    | "provider-unauthenticated"
    | "model-missing";
  readonly profileId: string;

  constructor(input: {
    readonly code: ProviderSelectionError["code"];
    readonly profileId: string;
    readonly detail: string;
  }) {
    super(`profile ${input.profileId}: ${input.detail}`);
    this.name = "ProviderSelectionError";
    this.code = input.code;
    this.profileId = input.profileId;
  }
}

export function validateConfiguredProviders(
  config: AgentTagConfig,
  server: T3ServerInfo,
): ReadonlyArray<ValidatedProviderSelection> {
  return config.profiles.map((profile) => {
    const provider = server.providers.find(
      (candidate) => candidate.instanceId === profile.defaultProviderInstanceId,
    );
    if (provider === undefined) {
      throw new ProviderSelectionError({
        code: "provider-missing",
        profileId: profile.id,
        detail: `provider ${profile.defaultProviderInstanceId} is not in the T3 catalog`,
      });
    }
    if (!provider.enabled || !provider.installed) {
      throw new ProviderSelectionError({
        code: "provider-disabled",
        profileId: profile.id,
        detail: `provider ${provider.instanceId} is not enabled and installed`,
      });
    }
    if (provider.status !== "ready") {
      throw new ProviderSelectionError({
        code: "provider-not-ready",
        profileId: profile.id,
        detail: `provider ${provider.instanceId} reports ${provider.status}`,
      });
    }
    if (provider.auth.status !== "authenticated") {
      throw new ProviderSelectionError({
        code: "provider-unauthenticated",
        profileId: profile.id,
        detail: `provider ${provider.instanceId} is not authenticated`,
      });
    }
    if (!provider.models.some((model) => model.slug === profile.defaultModel)) {
      throw new ProviderSelectionError({
        code: "model-missing",
        profileId: profile.id,
        detail: `model ${profile.defaultModel} is not offered by provider ${provider.instanceId}`,
      });
    }
    return {
      profileId: profile.id,
      instanceId: provider.instanceId,
      model: profile.defaultModel,
    };
  });
}
