import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { dispatchT3Command, inspectT3, type T3Command } from "../src/t3/gateway.ts";

const enabled = Bun.env.RUN_T3_INTEGRATION === "1";

if (!enabled) {
  describe("live T3 gateway", () => {
    test.skip("set RUN_T3_INTEGRATION=1 to run against the pinned release", () => {});
  });
} else {
  const config = {
    baseUrl: z.url().parse(Bun.env.AGENT_TAG_T3_URL),
    tokenFile: z.string().min(1).parse(Bun.env.AGENT_TAG_T3_TOKEN_FILE),
  };

  describe("live T3 gateway", () => {
    test("probes the release and projects authenticated provider capabilities", async () => {
      const info = await inspectT3(config);
      const codex = info.providers.find((provider) => provider.instanceId === "codex");
      const claude = info.providers.find((provider) => provider.instanceId === "claudeAgent");
      expect(codex).toMatchObject({ installed: true, status: "ready", auth: { status: "authenticated" } });
      expect(claude).toMatchObject({
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
      });
      expect(codex?.models.map((model) => model.slug)).toContain("gpt-5.6-sol");
      expect(claude?.models.map((model) => model.slug)).toContain("claude-opus-5");
    });

    test("returns the same receipt sequence for a replayed command id", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-project-"));
      const projectId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      const command: T3Command = {
        type: "project.create",
        commandId,
        projectId,
        title: "Agent Tag integration fixture",
        workspaceRoot,
        createdAt: new Date().toISOString(),
      };
      let created = false;
      try {
        const first = await dispatchT3Command({ config, command });
        created = true;
        const replay = await dispatchT3Command({ config, command });
        expect(replay.sequence).toBe(first.sequence);
      } finally {
        if (created) {
          await dispatchT3Command({
            config,
            command: {
              type: "project.delete",
              commandId: crypto.randomUUID(),
              projectId,
              force: true,
            },
          });
        }
        if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-project-`)) {
          throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
        }
        await rm(workspaceRoot, { recursive: true });
      }
    });
  });
}
