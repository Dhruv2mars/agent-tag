import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { parseT3DownloadBaseUrl } from "./t3/install.ts";

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
}

/**
 * The normalized `config.t3`. Both modes carry `baseUrl` and `tokenFile`, so every consumer typed as
 * `T3ConnectionConfig` keeps working; managed mode derives `baseUrl` from its loopback port.
 */
export type ResolvedT3Config =
  | { readonly mode: "external"; readonly baseUrl: string; readonly tokenFile: string }
  | {
      readonly mode: "managed";
      readonly baseUrl: string;
      readonly tokenFile: string;
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
    ...(t3.downloadBaseUrl === undefined ? {} : { downloadBaseUrl: t3.downloadBaseUrl }),
  };
}

function resolveT3Config(t3: z.infer<typeof t3Schema>, dataDir: string): ResolvedT3Config {
  if (t3.mode === "external") return { mode: "external", baseUrl: t3.baseUrl, tokenFile: t3.tokenFile };
  const managed = resolveManagedT3(t3, dataDir);
  return { mode: "managed", baseUrl: `http://127.0.0.1:${managed.port}`, tokenFile: t3.tokenFile, managed };
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
    routines: routinesSchema,
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

export async function loadConfig(path: string): Promise<AgentTagConfig> {
  const input: unknown = await Bun.file(path).json();
  return agentTagConfigSchema.parse(input);
}
