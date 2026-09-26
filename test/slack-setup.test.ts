import { expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { SLACK_ACTION_IDS } from "../src/slack/actions.ts";

const manifestSchema = z.object({
  oauth_config: z.object({
    scopes: z.object({ bot: z.array(z.string().min(1)) }),
  }),
  settings: z.object({
    event_subscriptions: z.object({ bot_events: z.array(z.string().min(1)) }),
    interactivity: z.object({ is_enabled: z.boolean() }),
    socket_mode_enabled: z.boolean(),
  }),
});

test("the checked-in Slack manifest is the least-privilege runtime contract", async () => {
  const raw: unknown = await Bun.file(
    join(import.meta.dir, "..", "config", "slack-manifest.example.json"),
  ).json();
  const manifest = manifestSchema.parse(raw);
  expect(manifest.oauth_config.scopes.bot).toEqual([
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "groups:history",
    "im:history",
  ]);
  expect(manifest.settings.event_subscriptions.bot_events).toEqual([
    "app_mention",
    "message.channels",
    "message.groups",
    "message.im",
  ]);
  expect(manifest.settings.socket_mode_enabled).toBe(true);
  expect(manifest.settings.interactivity.is_enabled).toBe(true);
  expect(SLACK_ACTION_IDS).toHaveLength(6);
});

test("the checked-in Agent Tag config parses without hidden defaults", async () => {
  const raw: unknown = await Bun.file(
    join(import.meta.dir, "..", "config", "agent-tag.example.json"),
  ).json();
  const config = agentTagConfigSchema.parse(raw);
  expect(config.routes).toEqual([
    {
      conversationId: "C0EXAMPLE",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/agent-tag/repositories/example",
    },
  ]);
  expect(config.profiles[0]?.ambient.enabled).toBe(false);
});
