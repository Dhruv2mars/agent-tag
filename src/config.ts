import { isAbsolute } from "node:path";

import { z } from "zod";

const absolutePath = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const slackId = z.string().regex(/^[A-Z][A-Z0-9]+$/);
const profileId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const providerInstanceId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

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

/** Draft PR workflow per profile. Off unless configured; not yet wired into the coordinator. */
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

export const agentTagConfigSchema = z
  .object({
    version: z.literal(1),
    dataDir: absolutePath,
    t3: z.object({
      baseUrl: z.url().refine((value) => {
        const host = new URL(value).hostname;
        return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
      }, "T3 must use a loopback URL"),
      tokenFile: absolutePath,
    }),
    slack: z.object({
      workspaceId: slackId,
      appTokenFile: absolutePath,
      botTokenFile: absolutePath,
    }),
    access: z.object({
      allowedUserIds: z.array(slackId).min(1),
      allowedChannelIds: z.array(slackId).min(1),
    }),
    profiles: z.array(profileSchema).min(1),
    routes: z.array(routeSchema),
    limits: z.object({
      maxConcurrentTasks: z.number().int().positive().max(32),
      maxActiveSchedules: z.number().int().positive().max(10_000).default(100),
      stalledTurn: stalledTurnSchema,
      interactionExpirySeconds: interactionExpirySchema,
    }),
    retention: retentionSchema,
    github: githubSchema.optional(),
  })
  .superRefine((config, context) => {
    const profiles = new Map(config.profiles.map((profile) => [profile.id, profile]));
    if (profiles.size !== config.profiles.length) {
      context.addIssue({ code: "custom", path: ["profiles"], message: "profile ids must be unique" });
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
  });

export type AgentTagConfig = z.infer<typeof agentTagConfigSchema>;

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
