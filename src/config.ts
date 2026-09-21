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
    routes: z.array(
      z.object({
        conversationId: slackId,
        profileId,
        repositoryRoot: absolutePath.optional(),
      }),
    ),
    limits: z.object({
      maxConcurrentTasks: z.number().int().positive().max(32),
      maxActiveSchedules: z.number().int().positive().max(10_000).default(100),
    }),
  })
  .superRefine((config, context) => {
    const profiles = new Map(config.profiles.map((profile) => [profile.id, profile]));
    if (profiles.size !== config.profiles.length) {
      context.addIssue({ code: "custom", path: ["profiles"], message: "profile ids must be unique" });
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
    }
  });

export type AgentTagConfig = z.infer<typeof agentTagConfigSchema>;

export async function loadConfig(path: string): Promise<AgentTagConfig> {
  const input: unknown = await Bun.file(path).json();
  return agentTagConfigSchema.parse(input);
}
