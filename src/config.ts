import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { AGENT_COMMANDS } from "./commands/parse.ts";
import { parseT3DownloadBaseUrl } from "./t3/install.ts";

const absolutePath = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const profileId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const providerInstanceId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

/** One model on one T3 provider instance. The instance id is the T3 routing key; the driver is read from T3. */
const modelRefSchema = z.object({ instanceId: providerInstanceId, model: z.string().min(1) }).strict();
const modelAliasSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "aliases are lowercase slugs");
const allowedModelSchema = modelRefSchema.extend({
  /** Human name used in Slack replies, e.g. "Opus 5.5". Defaults to the model slug. */
  label: z.string().trim().min(1).max(40).optional(),
  aliases: z.array(modelAliasSchema).max(8).default([]),
});
const modelSwitchSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** A thread may move to another driver only before its first turn; T3 0.0.45 refuses it afterwards. */
    crossProvider: z.enum(["before-first-turn", "deny"]).default("before-first-turn"),
  })
  .strict()
  .default({ enabled: true, crossProvider: "before-first-turn" });

const isolationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("trusted-same-user"),
    acknowledgedSharedMachineAccess: z.literal(true),
  }),
  z.object({ mode: z.literal("os-account"), account: z.string().min(1) }),
  z.object({ mode: z.literal("container"), runtime: z.enum(["docker", "podman"]) }),
]);

const externalWritesSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("deny") }),
  z.object({
    mode: z.literal("approval-required"),
    allowedTools: z.array(z.string().min(1)).default([]),
  }),
]);

/**
 * A turn is stalled when T3 reports no progress (snapshot sequence, activity, or message updates)
 * for `timeoutSeconds`. A turn that keeps progressing runs until it settles or its active polling
 * time reaches the `maxTurnSeconds` backstop.
 */
const stalledTurnSchema = z
  .object({
    timeoutSeconds: z.number().int().positive().max(86_400),
    retryDelaySeconds: z.number().int().positive().max(3_600),
    maxAttempts: z.number().int().positive().max(10),
    maxTurnSeconds: z.number().int().positive().max(604_800).optional(),
  })
  // An omitted ceiling defaults to 6h, raised to the stall timeout so older configs stay valid.
  .transform(({ maxTurnSeconds, ...policy }) => ({
    ...policy,
    maxTurnSeconds: maxTurnSeconds ?? Math.max(21_600, policy.timeoutSeconds),
  }))
  .refine((policy) => policy.maxTurnSeconds >= policy.timeoutSeconds, {
    path: ["maxTurnSeconds"],
    message: "maxTurnSeconds must be at least timeoutSeconds",
  })
  .default({ timeoutSeconds: 300, retryDelaySeconds: 30, maxAttempts: 5, maxTurnSeconds: 21_600 });

/**
 * Coordinators wait on the shared T3 thread stream instead of polling. The stream only wakes them:
 * settlement still reads the snapshot, at the latest every `safetyPollMs`, so a dead stream delays
 * a reply but never loses it. `enabled: false` restores fixed 500 ms polling.
 */
const t3WatchSchema = z
  .object({
    enabled: z.boolean().default(true),
    safetyPollMs: z.number().int().min(1_000).max(60_000).default(15_000),
    lingerMs: z.number().int().min(0).max(600_000).default(30_000),
  })
  .default({ enabled: true, safetyPollMs: 15_000, lingerMs: 30_000 });
export type T3WatchConfig = z.infer<typeof t3WatchSchema>;

/** How long an approval or question may wait for a human before the turn is cancelled. */
const interactionExpirySchema = z.number().int().min(60).max(2_592_000).default(86_400);

/** `owner/name` of a GitHub repository. Always taken from config, never from a repository's git config. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A conservative subset of `git check-ref-format --branch`: no `..`, `@{`, control characters or leading `-`. */
export const GIT_BRANCH_NAME_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/\.)(?!\.)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;

const httpsBaseUrl = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  }, "must be an https URL without credentials, query or fragment")
  .transform((value) => value.replace(/\/+$/, ""));

/**
 * Top-level GitHub settings. Only a fine-grained personal access token (`type: "token"`) is supported;
 * GitHub App auth arrives with the button-mode follow-up. The token stays in `tokenFile` and is read by
 * Agent Tag only: it is never put in a worktree, a git config, a remote URL or a child's argv.
 */
const githubSchema = z
  .object({
    apiBaseUrl: httpsBaseUrl.default("https://api.github.com"),
    webBaseUrl: httpsBaseUrl.default("https://github.com"),
    auth: z.discriminatedUnion("type", [z.object({ type: z.literal("token"), tokenFile: absolutePath })]),
  })
  .strict();

const commitIdentityText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[<>\u0000-\u001f\u007f]/.test(value), "must not contain angle brackets or control characters");

const pullRequestRepositorySchema = z
  .object({
    root: absolutePath,
    repo: z.string().regex(GITHUB_REPOSITORY_PATTERN, "repo must be owner/name"),
    /** Defaults to the profile's `baseBranch`. */
    baseBranch: z.string().regex(GIT_BRANCH_NAME_PATTERN, "baseBranch is not a valid branch name").optional(),
  })
  .strict();

const enabledPullRequestsSchema = z
  .object({
    mode: z.enum(["auto", "button"]),
    repositories: z.array(pullRequestRepositorySchema).min(1),
    draft: z.boolean().default(true),
    commitAuthor: z
      .object({ name: commitIdentityText, email: commitIdentityText })
      .strict()
      .default({ name: "Agent Tag", email: "agent-tag@users.noreply.github.com" }),
    maxChangedFiles: z.number().int().positive().max(100_000).default(300),
    maxDiffBytes: z.number().int().positive().max(100_000_000).default(2_000_000),
    secretScan: z.enum(["block", "off"]).default("block"),
  })
  .strict();

/** Draft PR workflow per profile. Off unless configured; "button" is reserved for M3 and rejected. */
const pullRequestsSchema = z
  .discriminatedUnion("mode", [z.object({ mode: z.literal("off") }), enabledPullRequestsSchema])
  .default({ mode: "off" });

export type PullRequestsConfig = z.infer<typeof pullRequestsSchema>;
export type EnabledPullRequestsConfig = Extract<PullRequestsConfig, { readonly mode: "auto" | "button" }>;
export type GitHubConfig = z.infer<typeof githubSchema>;

const routeBaseSchema = z.object({
  conversationId: slackId,
  profileId,
  repositoryRoot: absolutePath.optional(),
  /** Channel default model; must be the profile default or one of its `allowedModels`. */
  defaultModel: modelRefSchema.optional(),
});
const routeSchema = z.union([
  routeBaseSchema.extend({ conversationType: z.literal("channel").default("channel") }),
  routeBaseSchema.extend({ conversationType: z.literal("dm"), ownerUserId: slackId }),
]);

const profileSchema = z.object({
  id: profileId,
  repositoryRoots: z.array(absolutePath).min(1),
  baseBranch: z.string().min(1).default("main"),
  defaultProviderInstanceId: providerInstanceId,
  defaultModel: z.string().min(1),
  /**
   * Models a thread may be switched to, besides the profile default and route defaults (which are
   * always allowed). Empty by default, so only the default model is allowed.
   */
  allowedModels: z.array(allowedModelSchema).max(20).default([]),
  modelSwitch: modelSwitchSchema,
  runtimeMode: z.enum(["approval-required", "auto-accept-edits"]),
  isolation: isolationSchema,
  externalWrites: externalWritesSchema,
  memory: z.object({
    shared: z.boolean(),
    privateDm: z.boolean(),
    retentionDays: z.number().int().positive().max(3650),
  }),
  ambient: z
    .object({
      enabled: z.boolean(),
      keywords: z.array(z.string().trim().min(1).max(64)).max(20),
      cooldownSeconds: z.number().int().min(60).max(86_400),
      maxTurnsPerHour: z.number().int().positive().max(60),
    })
    .default({ enabled: false, keywords: [], cooldownSeconds: 300, maxTurnsPerHour: 4 }),
  /** Earlier thread messages sent with the first mention in an existing thread (PR-G). */
  threadContext: z
    .object({
      enabled: z.boolean(),
      maxMessages: z.number().int().min(1).max(200),
      maxChars: z.number().int().min(1_000).max(100_000),
      maxMessageChars: z.number().int().min(200).max(10_000),
      includeBotMessages: z.enum(["none", "root-only", "all"]),
      includeNonAllowedUsers: z.boolean(),
    })
    .refine((value) => value.maxMessageChars <= value.maxChars, {
      message: "threadContext.maxMessageChars must not exceed maxChars",
      path: ["maxMessageChars"],
    })
    .default({
      enabled: true,
      maxMessages: 30,
      maxChars: 12_000,
      maxMessageChars: 2_000,
      includeBotMessages: "root-only",
      includeNonAllowedUsers: true,
    }),
  pullRequests: pullRequestsSchema,
});

const retentionDays = z.number().int().positive().max(3650);
const retentionSchema = z
  .object({
    auditDays: retentionDays.optional(),
    outboxDays: retentionDays.optional(),
    messageDays: retentionDays.optional(),
  })
  .strict()
  .default({});

const loopbackUrl = z.url().refine((value) => {
  const host = new URL(value).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}, "T3 must use a loopback URL");

/** An operator-run T3 server. Configs without `t3.mode` (every config before managed mode) parse as this. */
const externalT3Schema = z.object({
  mode: z.literal("external").default("external"),
  baseUrl: loopbackUrl,
  tokenFile: absolutePath,
  watch: t3WatchSchema,
});

/** A T3 server Agent Tag installs from t3.lock.json and supervises itself (`t3 serve` on loopback). */
const managedT3Schema = z.object({
  mode: z.literal("managed"),
  port: z.number().int().min(1024).max(65_535).default(37_841),
  tokenFile: absolutePath,
  /** T3's `--base-dir` (its SQLite, logs, environment id); default `<dataDir>/t3/home`. */
  homeDir: absolutePath.optional(),
  /** Verified binaries and supervisor state; default `<dataDir>/t3/runtime`. */
  runtimeDir: absolutePath.optional(),
  autoInstall: z.boolean().default(true),
  watch: t3WatchSchema,
  /**
   * Restricted-token rotation: rotate when fewer than `rotateBeforeDays` remain (tokens live 30 days),
   * and revoke the replaced token `revokeGraceMinutes` later so in-flight turns finish on it.
   */
  rotation: z
    .object({
      rotateBeforeDays: z.number().int().min(1).max(25).default(7),
      revokeGraceMinutes: z.number().int().min(1).max(1_440).default(15),
    })
    .strict()
    .default({ rotateBeforeDays: 7, revokeGraceMinutes: 15 }),
  /** Mirror for the pinned release assets; https only (http only on loopback). */
  downloadBaseUrl: z
    .string()
    .transform((value, context) => {
      try {
        return parseT3DownloadBaseUrl(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
        return z.NEVER;
      }
    })
    .optional(),
});

const t3Schema = z.union([externalT3Schema, managedT3Schema]);

/** Managed-mode settings with every default resolved against `dataDir`. */
export interface ResolvedManagedT3 {
  readonly port: number;
  readonly homeDir: string;
  readonly runtimeDir: string;
  readonly autoInstall: boolean;
  readonly downloadBaseUrl?: string;
  readonly rotation: T3RotationConfig;
}

export interface T3RotationConfig {
  readonly rotateBeforeDays: number;
  readonly revokeGraceMinutes: number;
}

/**
 * The normalized `config.t3`. Both modes carry `baseUrl` and `tokenFile`, so every consumer typed as
 * `T3ConnectionConfig` keeps working; managed mode derives `baseUrl` from its loopback port.
 */
export type ResolvedT3Config =
  | { readonly mode: "external"; readonly baseUrl: string; readonly tokenFile: string; readonly watch: T3WatchConfig }
  | {
      readonly mode: "managed";
      readonly baseUrl: string;
      readonly tokenFile: string;
      readonly watch: T3WatchConfig;
      readonly managed: ResolvedManagedT3;
    };

/** T3's own default base dir (`$T3CODE_HOME`, else `~/.t3`): the desktop app's data, never shared. */
function desktopT3Homes(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const homes = [resolve(home, ".t3")];
  const configured = env.T3CODE_HOME?.trim();
  if (configured !== undefined && configured.length > 0) homes.push(resolve(configured));
  return homes;
}

function resolveManagedT3(t3: z.infer<typeof managedT3Schema>, dataDir: string): ResolvedManagedT3 {
  return {
    port: t3.port,
    homeDir: t3.homeDir ?? join(dataDir, "t3", "home"),
    runtimeDir: t3.runtimeDir ?? join(dataDir, "t3", "runtime"),
    autoInstall: t3.autoInstall,
    rotation: t3.rotation,
    ...(t3.downloadBaseUrl === undefined ? {} : { downloadBaseUrl: t3.downloadBaseUrl }),
  };
}

function resolveT3Config(t3: z.infer<typeof t3Schema>, dataDir: string): ResolvedT3Config {
  if (t3.mode === "external") return { mode: "external", baseUrl: t3.baseUrl, tokenFile: t3.tokenFile, watch: t3.watch };
  const managed = resolveManagedT3(t3, dataDir);
  return { mode: "managed", baseUrl: `http://127.0.0.1:${managed.port}`, tokenFile: t3.tokenFile, watch: t3.watch, managed };
}

type ParsedProfile = z.infer<typeof profileSchema>;
type ModelRef = z.infer<typeof modelRefSchema>;

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

/** Whether `ref` is the profile default or one of its `allowedModels` entries. */
function isProfileModel(profile: ParsedProfile, ref: ModelRef): boolean {
  return (
    sameModel(ref, { instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel }) ||
    profile.allowedModels.some((entry) => sameModel(entry, ref))
  );
}

/** Case- and whitespace-insensitive key for labels and aliases. */
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Entries are unique by (instanceId, model). Labels and aliases share one case-insensitive namespace per
 * profile, and none may equal a different model's slug, so a name always resolves to one model.
 */
function checkAllowedModels(
  profile: ParsedProfile,
  path: ReadonlyArray<string | number>,
  context: z.RefinementCtx,
): void {
  const defaultRef = { instanceId: profile.defaultProviderInstanceId, model: profile.defaultModel };
  const refs: ModelRef[] = [defaultRef, ...profile.allowedModels];
  const names = new Map<string, number>();
  for (const [index, entry] of profile.allowedModels.entries()) {
    if (profile.allowedModels.findIndex((other) => sameModel(other, entry)) !== index) {
      context.addIssue({ code: "custom", path: [...path, index], message: "allowedModels entries must be unique" });
    }
    const seen = new Set<string>();
    const entryNames: Array<{ readonly key: string; readonly field: string | number; readonly kind: string }> = [
      ...(entry.label === undefined ? [] : [{ key: normalizeModelName(entry.label), field: "label", kind: "label" }]),
      ...entry.aliases.map((alias, aliasIndex) => ({ key: alias, field: aliasIndex, kind: "alias" })),
    ];
    for (const name of entryNames) {
      const issuePath = name.kind === "label" ? [...path, index, "label"] : [...path, index, "aliases", name.field];
      // Queries match `instance/model` and slugs before labels, so a name equal to either would select the other model.
      const shadows = (ref: ModelRef): boolean =>
        ref.model.toLowerCase() === name.key || `${ref.instanceId}/${ref.model}`.toLowerCase() === name.key;
      if (refs.some((ref) => !sameModel(ref, entry) && shadows(ref))) {
        context.addIssue({ code: "custom", path: issuePath, message: `${name.kind} collides with another model's slug or instance/model` });
      }
      if (seen.has(name.key)) {
        // A label that equals the entry's own alias is harmless; a repeated alias is not.
        if (name.kind === "alias" && entry.aliases.indexOf(name.key) !== name.field) {
          context.addIssue({ code: "custom", path: issuePath, message: "aliases must be unique" });
        }
        continue;
      }
      seen.add(name.key);
      const owner = names.get(name.key);
      if (owner !== undefined && owner !== index) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message: "labels and aliases must be unique within a profile",
        });
      } else {
        names.set(name.key, index);
      }
    }
  }
}

/**
 * Routines. A recurring routine is turned off after `consecutiveFailures` failed runs in a row whose
 * due times span at least `minFailureSpanSeconds` (Claude Tag: 3 failures over at least 1 hour).
 * The decision waits until every run due since the last success has an outcome, and runs dispatched
 * before outcome tracking existed never count (see src/store/schedule-outcomes.ts).
 */
const routinesSchema = z
  .object({
    autoDisable: z
      .object({
        consecutiveFailures: z.number().int().min(1).max(50).default(3),
        minFailureSpanSeconds: z.number().int().min(0).max(604_800).default(3_600),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

/** `@bot !command` settings (PR-H). Every key defaults, so existing configs stay valid. */
const commandsSchema = z
  .object({
    /** false: `!words` are ordinary prompts. */
    enabled: z.boolean().default(true),
    /** `!help` cannot be disabled: it is how users find out what is enabled. */
    disabled: z.array(z.enum(AGENT_COMMANDS).exclude(["help"])).default([]),
    /** Commands only `access.adminUserIds` may run. `!help` and `!status` are read-only and stay open. */
    adminOnly: z.array(z.enum(AGENT_COMMANDS).exclude(["help", "status"])).default([]),
  })
  .strict()
  .prefault({});

export const agentTagConfigSchema = z
  .object({
    version: z.literal(1),
    dataDir: absolutePath,
    t3: t3Schema,
    slack: z.object({
      workspaceId: slackId,
      appTokenFile: absolutePath,
      botTokenFile: absolutePath,
    }),
    access: z.object({
      allowedUserIds: z.array(slackId).min(1),
      allowedChannelIds: z.array(slackId).min(1),
      /** Users who may run `commands.adminOnly` commands. Must be allowed users. */
      adminUserIds: z.array(slackId).default([]),
    }),
    commands: commandsSchema,
    profiles: z.array(profileSchema).min(1),
    routes: z.array(routeSchema),
    limits: z.object({
      maxConcurrentTasks: z.number().int().positive().max(32),
      maxActiveSchedules: z.number().int().positive().max(10_000).default(100),
      stalledTurn: stalledTurnSchema,
      interactionExpirySeconds: interactionExpirySchema,
    }),
    retention: retentionSchema,
    routines: routinesSchema,
    github: githubSchema.optional(),
  })
  .superRefine((config, context) => {
    const profiles = new Map(config.profiles.map((profile) => [profile.id, profile]));
    if (profiles.size !== config.profiles.length) {
      context.addIssue({ code: "custom", path: ["profiles"], message: "profile ids must be unique" });
    }
    for (const [index, profile] of config.profiles.entries()) {
      checkAllowedModels(profile, ["profiles", index, "allowedModels"], context);
    }
    for (const [index, userId] of config.access.adminUserIds.entries()) {
      if (!config.access.allowedUserIds.includes(userId)) {
        context.addIssue({
          code: "custom",
          path: ["access", "adminUserIds", index],
          message: "admin user is not in access.allowedUserIds",
        });
      }
    }
    const routeConversationIds = new Set(config.routes.map((route) => route.conversationId));
    if (routeConversationIds.size !== config.routes.length) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "route conversation ids must be unique",
      });
    }
    for (const [index, route] of config.routes.entries()) {
      const profile = profiles.get(route.profileId);
      if (profile === undefined) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "profileId"],
          message: "route references an unknown profile",
        });
      } else if (
        route.repositoryRoot !== undefined &&
        !profile.repositoryRoots.includes(route.repositoryRoot)
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "repositoryRoot"],
          message: "route repositoryRoot is outside the profile allowlist",
        });
      }
      if (
        profile !== undefined &&
        route.defaultModel !== undefined &&
        !isProfileModel(profile, route.defaultModel)
      ) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "defaultModel"],
          message: "route defaultModel must be the profile default or one of its allowedModels",
        });
      }
      if (!config.access.allowedChannelIds.includes(route.conversationId)) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "conversationId"],
          message: "route conversation is not in access.allowedChannelIds",
        });
      }
      if (route.conversationType === "dm") {
        if (!route.conversationId.startsWith("D")) {
          context.addIssue({
            code: "custom",
            path: ["routes", index, "conversationId"],
            message: "DM route conversation id must start with D",
          });
        }
        if (!config.access.allowedUserIds.includes(route.ownerUserId)) {
          context.addIssue({
            code: "custom",
            path: ["routes", index, "ownerUserId"],
            message: "DM route owner is not in access.allowedUserIds",
          });
        }
        if (profile !== undefined && !profile.memory.privateDm) {
          context.addIssue({
            code: "custom",
            path: ["routes", index, "profileId"],
            message: "DM route profile must enable privateDm memory isolation",
          });
        }
      } else if (route.conversationId.startsWith("D")) {
        context.addIssue({
          code: "custom",
          path: ["routes", index, "conversationId"],
          message: "channel route cannot use a DM conversation id",
        });
      }
    }
    for (const [index, profile] of config.profiles.entries()) {
      const pullRequests = profile.pullRequests;
      if (pullRequests.mode === "off") continue;
      const path = ["profiles", index, "pullRequests"];
      if (config.github === undefined) {
        context.addIssue({ code: "custom", path: [...path, "mode"], message: "pull requests require the top-level github config" });
      }
      if (pullRequests.mode === "button") {
        context.addIssue({
          code: "custom",
          path: [...path, "mode"],
          message: 'mode "button" is not available yet (PR-M M3); use "auto" or "off"',
        });
      }
      if (profile.externalWrites.mode === "deny") {
        context.addIssue({
          code: "custom",
          path: [...path, "mode"],
          message: 'pull requests push to GitHub, so they must be "off" when externalWrites.mode is "deny"',
        });
      }
      const roots = new Set<string>();
      for (const [repositoryIndex, repository] of pullRequests.repositories.entries()) {
        if (!profile.repositoryRoots.includes(repository.root)) {
          context.addIssue({
            code: "custom",
            path: [...path, "repositories", repositoryIndex, "root"],
            message: "pull request repository root is not in the profile's repositoryRoots",
          });
        }
        if (roots.has(repository.root)) {
          context.addIssue({
            code: "custom",
            path: [...path, "repositories", repositoryIndex, "root"],
            message: "pull request repository roots must be unique",
          });
        }
        roots.add(repository.root);
      }
    }
    if (config.t3.mode === "managed") {
      const { homeDir, runtimeDir } = resolveManagedT3(config.t3, config.dataDir);
      if (desktopT3Homes(process.env, homedir()).includes(resolve(homeDir))) {
        context.addIssue({
          code: "custom",
          path: ["t3", "homeDir"],
          message: "managed T3 must not share the desktop T3 base dir (~/.t3 or $T3CODE_HOME); use its own homeDir",
        });
      }
      if (resolve(homeDir) === resolve(runtimeDir)) {
        context.addIssue({ code: "custom", path: ["t3", "runtimeDir"], message: "t3.runtimeDir must differ from t3.homeDir" });
      }
    }
  })
  .transform(({ t3, ...config }) => ({ ...config, t3: resolveT3Config(t3, config.dataDir) }));

export type AgentTagConfig = z.infer<typeof agentTagConfigSchema>;
export type AgentTagProfile = AgentTagConfig["profiles"][number];
export type AgentTagRoute = AgentTagConfig["routes"][number];
export type ThreadContextConfig = AgentTagConfig["profiles"][number]["threadContext"];
export type ConfiguredModelRef = ModelRef;

export interface ResolvedPullRequestRepository {
  readonly root: string;
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly baseBranch: string;
}

/**
 * The pull request target for a task's repository root, or undefined when the profile's pull requests are
 * off or the root is not configured. `baseBranch` falls back to the profile's `baseBranch`.
 */
export function pullRequestRepositoryFor(
  profile: AgentTagConfig["profiles"][number],
  repositoryRoot: string,
): ResolvedPullRequestRepository | undefined {
  if (profile.pullRequests.mode === "off") return undefined;
  const repository = profile.pullRequests.repositories.find((candidate) => candidate.root === repositoryRoot);
  if (repository === undefined) return undefined;
  const [owner = "", name = ""] = repository.repo.split("/");
  return {
    root: repository.root,
    repo: repository.repo,
    owner,
    name,
    baseBranch: repository.baseBranch ?? profile.baseBranch,
  };
}

export async function loadConfig(path: string): Promise<AgentTagConfig> {
  const input: unknown = await Bun.file(path).json();
  return agentTagConfigSchema.parse(input);
}
