import { type AgentTagProfile, type AgentTagRoute, normalizeModelName } from "../config.ts";
import type { T3ModelSelection, T3Provider, T3ServerInfo } from "../t3/gateway.ts";
import { checkProviderEntry, type ModelSource } from "./provider.ts";

/**
 * Model policy: which models a thread may use, how a user's words name one, which selection a turn
 * should carry, and whether T3 0.0.45 can move a thread to it. Pure functions; nothing here talks to T3.
 */

export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly source: ModelSource;
}

function sameSelection(left: T3ModelSelection, right: T3ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function profileDefault(profile: AgentTagProfile): T3ModelSelection {
  return { instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel };
}

/**
 * The models a thread on `route` may use: the profile default, the route default, then the profile's
 * `allowedModels`, once each. A default that is also listed in `allowedModels` takes its label and aliases.
 */
export function allowedChoices(
  profile: AgentTagProfile,
  route: AgentTagRoute | null | undefined,
): ReadonlyArray<ModelChoice> {
  const choices: ModelChoice[] = [];
  const add = (selection: T3ModelSelection, source: ModelSource): void => {
    if (choices.some((choice) => sameSelection(choice, selection))) return;
    const configured = profile.allowedModels.find((entry) => sameSelection(entry, selection));
    choices.push({
      instanceId: selection.instanceId,
      model: selection.model,
      label: configured?.label ?? selection.model,
      aliases: configured?.aliases ?? [],
      source,
    });
  };
  add(profileDefault(profile), "profile-default");
  if (route?.defaultModel !== undefined) add(route.defaultModel, "route-default");
  for (const entry of profile.allowedModels) add(entry, "allowed");
  return choices;
}

export type ModelQueryResult =
  | { readonly kind: "match"; readonly choice: ModelChoice }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<ModelChoice> }
  | { readonly kind: "none" };

/**
 * Resolves what a user typed to one allowed choice. Tiers, first hit wins: exact `instance/model`,
 * model slug (case-insensitive), label (case- and whitespace-insensitive), alias (case-insensitive),
 * then a bare instance id when that instance has exactly one choice. Several hits in one tier are
 * ambiguous rather than guessed.
 */
export function resolveModelQuery(choices: ReadonlyArray<ModelChoice>, query: string): ModelQueryResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { kind: "none" };
  const key = normalizeModelName(trimmed);
  const tiers: ReadonlyArray<(choice: ModelChoice) => boolean> = [
    (choice) => `${choice.instanceId}/${choice.model}` === trimmed,
    (choice) => choice.model.toLowerCase() === key,
    (choice) => normalizeModelName(choice.label) === key,
    (choice) => choice.aliases.some((alias) => alias.toLowerCase() === key),
  ];
  for (const matches of tiers) {
    const hits = choices.filter(matches);
    if (hits.length === 1) return { kind: "match", choice: hits[0]! };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  }
  const byInstance = choices.filter((choice) => choice.instanceId.toLowerCase() === key);
  if (byInstance.length === 1) return { kind: "match", choice: byInstance[0]! };
  if (byInstance.length > 1) return { kind: "ambiguous", candidates: byInstance };
  return { kind: "none" };
}

function driverOf(catalog: T3ServerInfo | null | undefined, instanceId: string): string | undefined {
  return catalog?.providers.find((provider) => provider.instanceId === instanceId)?.driver;
}

/** Same driver per the catalog; without a catalog only the same instance is known to be. */
function sameDriver(catalog: T3ServerInfo | null | undefined, left: string, right: string): boolean {
  if (left === right) return true;
  const leftDriver = driverOf(catalog, left);
  return leftDriver !== undefined && leftDriver === driverOf(catalog, right);
}

export interface EffectiveSelection {
  readonly selection: T3ModelSelection;
  readonly reason: "desired" | "route-default" | "profile-default" | "sticky-applied";
  /** The task's desired selection is no longer allowed by config. */
  readonly revoked: boolean;
}

/**
 * The selection a task's next turn should carry, before checking T3 can switch to it.
 * - A desired selection that config still allows wins.
 * - Otherwise the route default, else the profile default.
 * - A default on another driver than the thread's applied selection would be refused by T3 on a
 *   started thread, so the thread stays on what it has (`sticky-applied`). `catalog` supplies drivers;
 *   without it only an equal instance id counts as the same driver.
 * A task with neither desired nor applied selection always gets the route or profile default.
 */
export function effectiveSelection(input: {
  readonly task: { readonly desired: T3ModelSelection | null; readonly applied: T3ModelSelection | null };
  readonly profile: AgentTagProfile;
  readonly route: AgentTagRoute | null | undefined;
  readonly catalog?: T3ServerInfo | null;
}): EffectiveSelection {
  const { desired, applied } = input.task;
  const choices = allowedChoices(input.profile, input.route);
  if (desired !== null && choices.some((choice) => sameSelection(choice, desired))) {
    return { selection: { instanceId: desired.instanceId, model: desired.model }, reason: "desired", revoked: false };
  }
  const revoked = desired !== null;
  const routeDefault = input.route?.defaultModel;
  const fallback: EffectiveSelection = routeDefault === undefined
    ? { selection: profileDefault(input.profile), reason: "profile-default", revoked }
    : { selection: { instanceId: routeDefault.instanceId, model: routeDefault.model }, reason: "route-default", revoked };
  if (applied !== null && !sameDriver(input.catalog, applied.instanceId, fallback.selection.instanceId)) {
    return { selection: { instanceId: applied.instanceId, model: applied.model }, reason: "sticky-applied", revoked };
  }
  return fallback;
}

export type SwitchRefusalCode =
  | "switch-disabled"
  | "not-allowed"
  | "unavailable"
  | "cross-provider-denied"
  | "cross-provider-started"
  | "requires-new-thread"
  | "incompatible-continuation"
  | "ambiguous";

export type SwitchPlan =
  | { readonly kind: "noop" }
  | { readonly kind: "in-place" }
  | { readonly kind: "pre-start" }
  | { readonly kind: "refused"; readonly code: SwitchRefusalCode; readonly detail?: string };

function provider(catalog: T3ServerInfo, instanceId: string): T3Provider | undefined {
  return catalog.providers.find((candidate) => candidate.instanceId === instanceId);
}

/**
 * Whether a thread on `current` can move to `target`, mirroring T3 0.0.45
 * `ProviderCommandReactor.ensureSessionForThread` for a started thread:
 * - either side `requiresNewThreadForModelChange` refuses any model change;
 * - another instance must share the driver (else "is bound to driver") and the continuation group key
 *   (else "provider resume state is incompatible"); a missing key on either side fails closed;
 * - otherwise the switch happens in place.
 * Before the first turn any allowed model can be chosen, unless `crossProvider` is `deny`.
 * With no catalog (T3 state unknown) a started thread may only change model on the same instance;
 * the coordinator re-plans against a live catalog anyway.
 */
export function planSwitch(input: {
  readonly current: T3ModelSelection;
  readonly target: ModelChoice;
  readonly threadStarted: boolean;
  readonly catalog: T3ServerInfo | null;
  readonly policy: AgentTagProfile["modelSwitch"];
}): SwitchPlan {
  const { current, target, catalog } = input;
  if (!input.policy.enabled) return { kind: "refused", code: "switch-disabled" };
  if (sameSelection(current, target)) return { kind: "noop" };
  const sameInstance = current.instanceId === target.instanceId;
  if (catalog !== null) {
    const unavailable = checkProviderEntry(catalog, target);
    if (unavailable !== null) return { kind: "refused", code: "unavailable", detail: unavailable };
  }
  const crossDriver = !sameInstance && !sameDriver(catalog, current.instanceId, target.instanceId);

  if (!input.threadStarted) {
    if (crossDriver && input.policy.crossProvider === "deny") {
      return { kind: "refused", code: "cross-provider-denied" };
    }
    return { kind: "pre-start" };
  }

  if (catalog === null) {
    return sameInstance ? { kind: "in-place" } : { kind: "refused", code: "unavailable", detail: "catalog-unavailable" };
  }
  const from = provider(catalog, current.instanceId);
  const to = provider(catalog, target.instanceId)!; // checkProviderEntry found it
  if (from?.requiresNewThreadForModelChange === true || to.requiresNewThreadForModelChange === true) {
    return { kind: "refused", code: "requires-new-thread" };
  }
  if (sameInstance) return { kind: "in-place" };
  if (from === undefined) {
    // The thread's provider is gone from the catalog, so neither driver nor resume state can be compared.
    return { kind: "refused", code: "incompatible-continuation", detail: "current-provider-missing" };
  }
  if (from.driver !== to.driver) return { kind: "refused", code: "cross-provider-started" };
  const fromKey = from.continuation?.groupKey;
  const toKey = to.continuation?.groupKey;
  if (fromKey === undefined || toKey === undefined || fromKey !== toKey) {
    return { kind: "refused", code: "incompatible-continuation" };
  }
  return { kind: "in-place" };
}
