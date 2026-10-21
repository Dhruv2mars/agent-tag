import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema, type AgentTagConfig } from "../src/config.ts";
import { actionPurpose } from "../src/slack/actions.ts";
import {
  bindMembership,
  isSteeringAllowed,
  membershipFor,
  resolveRoute,
  UNKNOWN_MEMBERSHIP,
  type AccessDecision,
  type AccessPurpose,
  type AccessUserKind,
  type MembershipView,
} from "../src/policy/access.ts";

const example = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

// UA allowlisted; UM member; UG guest; UB bot user; UK member of unknown kind; UN not in the channel.
function buildConfig(
  mode: "allowlist" | "channel-members",
  overrides: {
    readonly directMessages?: Record<string, unknown>;
    readonly guests?: "deny" | "steer-only";
  } = {},
): AgentTagConfig {
  return agentTagConfigSchema.parse({
    ...example,
    slack: { workspaceId: "T1", appTokenFile: "/secrets/app", botTokenFile: "/secrets/bot" },
    access: {
      mode,
      allowedUserIds: ["UA"],
      allowedChannelIds: ["C1", "C2", "D1"],
      ...(overrides.guests === undefined ? {} : { membership: { guests: overrides.guests } }),
      ...(overrides.directMessages === undefined ? {} : { directMessages: overrides.directMessages }),
    },
    profiles: example.profiles.map((profile: { memory: object }) => ({ ...profile, memory: { ...profile.memory, privateDm: true } })),
    routes: [
      { conversationId: "C1", profileId: "engineering" },
      { conversationId: "C2", profileId: "engineering" },
      { conversationId: "D1", conversationType: "dm", ownerUserId: "UA", profileId: "engineering" },
    ],
  });
}

/** C1 has a good snapshot; C2 has none (never read, scope missing, or older than maxStaleSeconds). */
const membership: MembershipView = {
  lookup: (conversationId, userId) =>
    conversationId === "C1" ? (["UA", "UM", "UG", "UB", "UK"].includes(userId) ? "member" : "not-member") : "unknown",
  userKind: (userId): AccessUserKind =>
    ({ UA: "member", UM: "member", UG: "guest", UB: "bot", UN: "member" } as Record<string, AccessUserKind>)[userId] ?? "unknown",
};

type Expected = "allowlist" | "member" | "dm-owner" | Exclude<AccessDecision, { allowed: true }>["reason"];

interface Case {
  readonly mode: "allowlist" | "channel-members";
  readonly conversation: string;
  readonly user: string;
  readonly purpose: AccessPurpose;
  readonly expected: Expected;
  readonly guests?: "deny" | "steer-only";
  readonly directMessages?: Record<string, unknown>;
  readonly dmOwnerUserId?: string;
  readonly workspace?: string;
}

const CM = "channel-members" as const;
const AL = "allowlist" as const;
const AUTO = { mode: "auto-route", autoRouteProfileId: "engineering" };

const cases: ReadonlyArray<Case> = [
  // Allowlisted users are always allowed in allowed channels, in both modes, for every purpose.
  ...(["steer", "approve", "answer", "cancel", "schedule", "execute", "memory"] as const).flatMap((purpose) => [
    { mode: CM, conversation: "C1", user: "UA", purpose, expected: "allowlist" as const },
    { mode: AL, conversation: "C1", user: "UA", purpose, expected: "allowlist" as const },
  ]),
  // An allowlisted user needs no snapshot.
  { mode: CM, conversation: "C2", user: "UA", purpose: "steer", expected: "allowlist" },
  // channel-members: a non-guest member may do everything.
  ...(["steer", "approve", "answer", "cancel", "schedule", "execute", "memory"] as const).map((purpose) => (
    { mode: CM, conversation: "C1", user: "UM", purpose, expected: "member" as const }
  )),
  // allowlist mode: membership never matters.
  { mode: AL, conversation: "C1", user: "UM", purpose: "steer", expected: "user-denied" },
  { mode: AL, conversation: "C1", user: "UM", purpose: "approve", expected: "user-denied" },
  { mode: AL, conversation: "C1", user: "UM", purpose: "execute", expected: "user-denied" },
  // Not in the channel.
  { mode: CM, conversation: "C1", user: "UN", purpose: "steer", expected: "user-denied" },
  { mode: CM, conversation: "C1", user: "UN", purpose: "approve", expected: "user-denied" },
  { mode: CM, conversation: "C1", user: "UN", purpose: "execute", expected: "user-denied" },
  { mode: CM, conversation: "C1", user: "UN", purpose: "schedule", expected: "user-denied" },
  // Guests (default deny): never approve, answer or cancel; nothing else either.
  { mode: CM, conversation: "C1", user: "UG", purpose: "steer", expected: "guest-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "approve", expected: "approver-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "answer", expected: "approver-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "cancel", expected: "approver-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "schedule", expected: "guest-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "execute", expected: "guest-denied" },
  { mode: CM, conversation: "C1", user: "UG", purpose: "memory", expected: "guest-denied" },
  // Guests with steer-only: steer and run, still never approve.
  { mode: CM, guests: "steer-only", conversation: "C1", user: "UG", purpose: "steer", expected: "member" },
  { mode: CM, guests: "steer-only", conversation: "C1", user: "UG", purpose: "execute", expected: "member" },
  { mode: CM, guests: "steer-only", conversation: "C1", user: "UG", purpose: "approve", expected: "approver-denied" },
  { mode: CM, guests: "steer-only", conversation: "C1", user: "UG", purpose: "schedule", expected: "guest-denied" },
  // Bots never get access through membership.
  { mode: CM, conversation: "C1", user: "UB", purpose: "steer", expected: "user-denied" },
  { mode: CM, conversation: "C1", user: "UB", purpose: "approve", expected: "user-denied" },
  // Unknown account kind: may steer (as a member) but is treated as a guest for approvals (fail closed).
  { mode: CM, conversation: "C1", user: "UK", purpose: "steer", expected: "member" },
  { mode: CM, conversation: "C1", user: "UK", purpose: "execute", expected: "member" },
  { mode: CM, conversation: "C1", user: "UK", purpose: "approve", expected: "approver-denied" },
  { mode: CM, conversation: "C1", user: "UK", purpose: "cancel", expected: "approver-denied" },
  // No fresh snapshot: fail closed.
  { mode: CM, conversation: "C2", user: "UM", purpose: "steer", expected: "membership-unknown" },
  { mode: CM, conversation: "C2", user: "UM", purpose: "approve", expected: "membership-unknown" },
  { mode: CM, conversation: "C2", user: "UM", purpose: "execute", expected: "membership-unknown" },
  { mode: CM, conversation: "C2", user: "UN", purpose: "steer", expected: "membership-unknown" },
  // Channel and workspace gates come first.
  { mode: CM, conversation: "C9", user: "UA", purpose: "steer", expected: "channel-denied" },
  { mode: CM, conversation: "C9", user: "UM", purpose: "steer", expected: "channel-denied" },
  { mode: AL, conversation: "C9", user: "UA", purpose: "steer", expected: "channel-denied" },
  { mode: CM, conversation: "C1", user: "UA", purpose: "steer", workspace: "T2", expected: "workspace-denied" },
  // Routed DMs: the owner only; membership is never consulted.
  { mode: AL, conversation: "D1", user: "UA", purpose: "steer", expected: "dm-owner" },
  { mode: CM, conversation: "D1", user: "UA", purpose: "steer", expected: "dm-owner" },
  { mode: CM, conversation: "D1", user: "UA", purpose: "approve", expected: "dm-owner" },
  { mode: CM, conversation: "D1", user: "UM", purpose: "steer", expected: "dm-owner-denied" },
  { mode: CM, conversation: "D1", user: "UM", purpose: "approve", expected: "dm-owner-denied" },
  // directMessages: off denies every DM, routed or not.
  { mode: AL, directMessages: { mode: "off" }, conversation: "D1", user: "UA", purpose: "steer", expected: "dm-disabled" },
  { mode: CM, directMessages: { mode: "off" }, conversation: "D1", user: "UA", purpose: "execute", expected: "dm-disabled" },
  // routed-only (default): an unrouted DM is denied; channel-members never grants DMs.
  { mode: AL, conversation: "D5", user: "UA", purpose: "steer", expected: "channel-denied" },
  { mode: CM, conversation: "D5", user: "UM", purpose: "steer", expected: "channel-denied" },
  // auto-route: an allowlisted user's own DM; anyone else is denied.
  { mode: AL, directMessages: AUTO, conversation: "D5", user: "UA", purpose: "steer", expected: "dm-owner" },
  { mode: CM, directMessages: AUTO, conversation: "D5", user: "UA", purpose: "execute", expected: "dm-owner" },
  { mode: CM, directMessages: AUTO, conversation: "D5", user: "UM", purpose: "steer", expected: "channel-denied" },
  { mode: AL, directMessages: AUTO, conversation: "D5", user: "UM", purpose: "approve", dmOwnerUserId: "UA", expected: "dm-owner-denied" },
  { mode: AL, directMessages: AUTO, conversation: "D5", user: "UA", purpose: "execute", dmOwnerUserId: "UA", expected: "dm-owner" },
];

describe("isSteeringAllowed", () => {
  test("the table covers at least 40 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  for (const row of cases) {
    const label = [
      row.mode,
      row.guests === undefined ? null : `guests=${row.guests}`,
      row.directMessages === undefined ? null : `dm=${String(row.directMessages.mode)}`,
      row.workspace ?? null,
      `${row.user}@${row.conversation}`,
      row.dmOwnerUserId === undefined ? null : `owner=${row.dmOwnerUserId}`,
      row.purpose,
    ].filter((part) => part !== null).join(" ");
    test(`${label} -> ${row.expected}`, () => {
      const config = buildConfig(row.mode, {
        ...(row.guests === undefined ? {} : { guests: row.guests }),
        ...(row.directMessages === undefined ? {} : { directMessages: row.directMessages }),
      });
      const decision = isSteeringAllowed({
        config,
        membership,
        workspaceId: row.workspace ?? "T1",
        conversationId: row.conversation,
        userId: row.user,
        purpose: row.purpose,
        ...(row.dmOwnerUserId === undefined ? {} : { dmOwnerUserId: row.dmOwnerUserId }),
      });
      expect(decision).toEqual(
        row.expected === "allowlist" || row.expected === "member" || row.expected === "dm-owner"
          ? { allowed: true, basis: row.expected }
          : { allowed: false, reason: row.expected },
      );
    });
  }

  test("without a bound view, channel-members mode is allowlist-only (fail closed)", () => {
    const config = buildConfig(CM);
    expect(membershipFor(config)).toBe(UNKNOWN_MEMBERSHIP);
    const ask = (userId: string) =>
      isSteeringAllowed({ config, workspaceId: "T1", conversationId: "C1", userId, purpose: "steer" });
    expect(ask("UA")).toEqual({ allowed: true, basis: "allowlist" });
    expect(ask("UM")).toEqual({ allowed: false, reason: "membership-unknown" });
    bindMembership(config, membership);
    expect(ask("UM")).toEqual({ allowed: true, basis: "member" });
    // A view is bound to one config object; a parsed copy starts unbound.
    expect(membershipFor(buildConfig(CM))).toBe(UNKNOWN_MEMBERSHIP);
  });
});

describe("resolveRoute", () => {
  test("returns the configured route first", () => {
    const config = buildConfig(AL, { directMessages: AUTO });
    expect(resolveRoute(config, "D1", "UM")).toMatchObject({ conversationId: "D1", ownerUserId: "UA" });
    expect(resolveRoute(config, "C1")).toMatchObject({ conversationId: "C1", profileId: "engineering" });
  });

  test("synthesizes a DM route only in auto-route mode, for an allowlisted owner, on a D id", () => {
    const auto = buildConfig(AL, { directMessages: AUTO });
    expect(resolveRoute(auto, "D5", "UA")).toEqual({
      conversationId: "D5",
      conversationType: "dm",
      ownerUserId: "UA",
      profileId: "engineering",
    });
    expect(resolveRoute(auto, "D5", "UM")).toBeUndefined();
    expect(resolveRoute(auto, "D5")).toBeUndefined();
    expect(resolveRoute(auto, "C5", "UA")).toBeUndefined();
    expect(resolveRoute(buildConfig(AL), "D5", "UA")).toBeUndefined();
    expect(resolveRoute(buildConfig(AL, { directMessages: { mode: "off" } }), "D5", "UA")).toBeUndefined();
  });
});

describe("actionPurpose", () => {
  test.each([
    ["agent-tag.turn.stop", "cancel"],
    ["agent-tag.turn.cancel", "cancel"],
    ["agent-tag.approval.accept", "approve"],
    ["agent-tag.approval.decline", "approve"],
    ["agent-tag.input.submit", "answer"],
  ] as const)("%s is a %s click", (actionId, purpose) => {
    expect(actionPurpose(actionId)).toBe(purpose);
  });
});
