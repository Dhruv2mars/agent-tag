import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { classifyT3DispatchError } from "../src/t3/dispatch-errors.ts";
import { AgentTagCoordinator, classifyT3TurnFailure } from "../src/coordinator.ts";
import { ProviderSelectionError, validateConfiguredProviders } from "../src/policy/provider.ts";
import { ArtifactError, readWorkspaceArtifact } from "../src/slack/uploads.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { runTasksCommand } from "../src/tasks-cli.ts";
import { T3Connection } from "../src/t3/connection.ts";
import {
  dispatchT3Command,
  uploadT3Attachment,
  downloadT3Attachment,
  downloadT3WorkspaceFile,
  T3AssetTransferError,
  deletePendingT3Attachment,
  fetchT3ThreadSnapshot,
  inspectT3,
  pendingT3Approvals,
  watchT3Thread,
  type T3Command,
  T3ThreadNotFoundError,
  type T3ThreadSnapshot,
} from "../src/t3/gateway.ts";

const enabled = Bun.env.RUN_T3_INTEGRATION === "1";

/**
 * Removes a fixture directory after the caller's prefix guard. After `project.delete`, T3 0.0.45
 * keeps pruning worktree metadata inside the fixture's `.git` asynchronously, so a single recursive
 * remove can race it and fail with ENOENT while leaving `.git` behind. Retry until the tree is gone.
 */
async function removeFixtureDirectory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (attempt >= 50) throw error;
    }
    if (!(await stat(directory).then(() => true, () => false))) return;
    if (attempt >= 50) throw new Error(`fixture directory still present after cleanup: ${directory}`);
    await Bun.sleep(100);
  }
}

async function runGit(cwd: string, ...args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

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
    async function waitForSnapshot(
      threadId: string,
      predicate: (snapshot: T3ThreadSnapshot) => boolean,
      timeoutMs = 60_000,
    ): Promise<T3ThreadSnapshot> {
      const deadline = Date.now() + timeoutMs;
      let lastSnapshot = await fetchT3ThreadSnapshot({ config, threadId });
      while (!predicate(lastSnapshot) && Date.now() < deadline) {
        if (lastSnapshot.thread.latestTurn?.state === "error") {
          const lastError = lastSnapshot.thread.session?.lastError ?? "";
          const diagnostic = lastError.includes("repeated API errors")
            ? "provider-api-errors"
            : lastError.toLowerCase().includes("usage limit")
              ? "provider-usage-limit"
              : "provider-error";
          throw new Error(`T3 provider turn entered the error state (${diagnostic})`);
        }
        await Bun.sleep(250);
        lastSnapshot = await fetchT3ThreadSnapshot({ config, threadId });
      }
      if (!predicate(lastSnapshot)) {
        throw new Error(
          `timed out waiting for T3 snapshot state; turn=${lastSnapshot.thread.latestTurn?.state ?? "none"}; session=${lastSnapshot.thread.session?.status ?? "none"}`,
        );
      }
      return lastSnapshot;
    }

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
      expect(claude?.models.map((model) => model.slug)).toContain("claude-sonnet-4-6");

      const selectionConfig = agentTagConfigSchema.parse({
        version: 1,
        dataDir: "/tmp/agent-tag-provider-fixture",
        t3: config,
        slack: {
          workspaceId: "T1",
          appTokenFile: "/tmp/agent-tag-provider-fixture/slack-app-token",
          botTokenFile: "/tmp/agent-tag-provider-fixture/slack-bot-token",
        },
        access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1", "C2"] },
        profiles: [
          {
            id: "codex-profile",
            repositoryRoots: ["/tmp/codex-profile"],
            defaultProviderInstanceId: "codex",
            defaultModel: "gpt-5.6-sol",
            runtimeMode: "approval-required",
            isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
            externalWrites: { mode: "deny" },
            memory: { shared: false, privateDm: false, retentionDays: 30 },
          },
          {
            id: "claude-profile",
            repositoryRoots: ["/tmp/claude-profile"],
            defaultProviderInstanceId: "claudeAgent",
            defaultModel: "claude-sonnet-4-6",
            runtimeMode: "approval-required",
            isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
            externalWrites: { mode: "deny" },
            memory: { shared: false, privateDm: false, retentionDays: 30 },
          },
        ],
        routes: [
          { conversationId: "C1", profileId: "codex-profile" },
          { conversationId: "C2", profileId: "claude-profile" },
        ],
        limits: { maxConcurrentTasks: 1 },
      });
      expect(validateConfiguredProviders(selectionConfig, info)).toHaveLength(2);

      const unsupportedConfig = agentTagConfigSchema.parse({
        ...selectionConfig,
        profiles: selectionConfig.profiles.map((profile) =>
          profile.id === "claude-profile" ? { ...profile, defaultModel: "missing-model" } : profile,
        ),
      });
      try {
        validateConfiguredProviders(unsupportedConfig, info);
        throw new Error("expected missing model validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderSelectionError);
        if (!(error instanceof ProviderSelectionError)) throw error;
        expect(error.code).toBe("model-missing");
        expect(error.profileId).toBe("claude-profile");
      }
    });

    test("round trips pending image and file attachments with restricted scopes", async () => {
      const fixtures = [
        { type: "file", name: "fixture.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("attachment-fixture-ok") },
        { type: "image", name: "fixture.png", mimeType: "image/png", bytes: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII="), (char) => char.charCodeAt(0)) },
      ] as const;
      for (const fixture of fixtures) {
        const attachment = await uploadT3Attachment({ config, ...fixture, data: new Blob([fixture.bytes]) });
        try {
          expect(attachment).toMatchObject({ type: fixture.type, name: fixture.name, sizeBytes: fixture.bytes.length });
          expect(await downloadT3Attachment({ config, attachment })).toEqual(fixture.bytes);
        } finally { await deletePendingT3Attachment({ config, attachmentId: attachment.id }); }
        await expect(downloadT3Attachment({ config, attachment })).rejects.toThrow();
      }
    }, 30_000);

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
        await removeFixtureDirectory(workspaceRoot);
      }
    });

    test(
      "runs a supervised Codex turn and reconciles the completed snapshot",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-turn-"));
        const projectId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        let created = false;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag provider fixture\n\nmarker: fixture-ok\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add provider fixture");

          await dispatchT3Command({
            config,
            command: {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId,
              title: "Agent Tag provider turn fixture",
              workspaceRoot,
              createdAt: new Date().toISOString(),
            },
          });
          created = true;
          const createdAt = new Date().toISOString();
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.start",
              commandId: crypto.randomUUID(),
              threadId,
              message: {
                messageId,
                role: "user",
                text: "Reply with exactly fixture-ok. Do not call tools, change files, or use the network.",
                attachments: [],
              },
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              titleSeed: "Agent Tag supervised provider fixture",
              runtimeMode: "approval-required",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Agent Tag supervised provider fixture",
                  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: workspaceRoot,
                  createdAt,
                },
                runSetupScript: false,
              },
              createdAt,
            },
          });

          const abort = new AbortController();
          const eventTypes = new Set<string>();
          let synchronized = false;
          let completed = false;
          const watch = watchT3Thread({
            config,
            threadId,
            afterSequence: 0,
            signal: abort.signal,
            onItem: async (item) => {
              if (item.kind === "event") {
                eventTypes.add(item.event.type);
                completed ||= item.event.type === "thread.turn-diff-completed";
              }
              synchronized ||= item.kind === "synchronized";
              if (completed && synchronized) abort.abort();
            },
          });
          const timeout = setTimeout(() => abort.abort(new Error("timed out waiting for T3 turn")), 120_000);
          await watch;
          clearTimeout(timeout);

          expect(synchronized).toBe(true);
          expect(completed).toBe(true);
          expect(eventTypes).toContain("thread.message-sent");
          expect(eventTypes).toContain("thread.turn-diff-completed");

          const snapshot = await fetchT3ThreadSnapshot({ config, threadId });
          expect(snapshot.thread.runtimeMode).toBe("approval-required");
          expect(snapshot.thread.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });
          expect(snapshot.thread.latestTurn?.state).toBe("completed");
          const assistantMessages = snapshot.thread.messages.filter((message) => message.role === "assistant");
          expect(assistantMessages.at(-1)?.streaming).toBe(false);
          expect(assistantMessages.at(-1)?.text.trim()).toBe("fixture-ok");
          expect(snapshot.thread.session?.lastError).toBeNull();
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
          if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-turn-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
          }
          await removeFixtureDirectory(workspaceRoot);
        }
      },
      150_000,
    );

    test(
      "thread.session.stop stops a started thread's provider session, replays idempotently and rejects an unknown thread (PR-H2)",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-session-stop-"));
        const projectId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        let created = false;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag session stop fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add session stop fixture");
          await dispatchT3Command({
            config,
            command: {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId,
              title: "Agent Tag session stop fixture",
              workspaceRoot,
              createdAt: new Date().toISOString(),
            },
          });
          created = true;
          const createdAt = new Date().toISOString();
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.start",
              commandId: crypto.randomUUID(),
              threadId,
              message: {
                messageId: crypto.randomUUID(),
                role: "user",
                text: "Reply with exactly fixture-ok. Do not call tools, change files, or use the network.",
                attachments: [],
              },
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              titleSeed: "Agent Tag session stop fixture",
              runtimeMode: "approval-required",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Agent Tag session stop fixture",
                  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: workspaceRoot,
                  createdAt,
                },
                runSetupScript: false,
              },
              createdAt,
            },
          });
          // Any settled turn leaves a provider session behind; whether the provider answered (or hit a
          // usage limit) does not matter to the stop contract.
          let settled = await fetchT3ThreadSnapshot({ config, threadId });
          const deadline = Date.now() + 120_000;
          while (
            !(settled.thread.session !== null && ["ready", "idle", "error", "interrupted"].includes(settled.thread.session.status)) &&
            Date.now() < deadline
          ) {
            await Bun.sleep(250);
            settled = await fetchT3ThreadSnapshot({ config, threadId });
          }
          const before = settled.thread.session?.status;
          expect(before === undefined || before === "stopped").toBe(false);

          const stop: T3Command = {
            type: "thread.session.stop",
            commandId: `${threadId}:g1:session.stop`,
            threadId,
            createdAt: new Date().toISOString(),
          };
          const first = await dispatchT3Command({ config, command: stop });
          let stopped = await fetchT3ThreadSnapshot({ config, threadId });
          for (const until = Date.now() + 30_000; stopped.thread.session?.status !== "stopped" && Date.now() < until;) {
            await Bun.sleep(250);
            stopped = await fetchT3ThreadSnapshot({ config, threadId });
          }
          expect(stopped.thread.session?.status).toBe("stopped");
          // The restart worker retries with the same command id: T3 deduplicates it.
          expect((await dispatchT3Command({ config, command: stop })).sequence).toBe(first.sequence);

          const unknown = await dispatchT3Command({
            config,
            command: { ...stop, commandId: crypto.randomUUID(), threadId: crypto.randomUUID() },
          }).then(() => null, (error: unknown) => error);
          expect(classifyT3DispatchError(unknown)).toEqual({ kind: "rejected", code: "T3CommandRejected" });
        } finally {
          if (created) {
            await dispatchT3Command({
              config,
              command: { type: "project.delete", commandId: crypto.randomUUID(), projectId, force: true },
            });
          }
          if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-session-stop-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
          }
          await removeFixtureDirectory(workspaceRoot);
        }
      },
      180_000,
    );

    test(
      "runs an explicit Claude turn and keeps the selected provider and model sticky",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-claude-"));
        const projectId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        let created = false;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag Claude fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add Claude fixture");

          await dispatchT3Command({
            config,
            command: {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId,
              title: "Agent Tag Claude fixture",
              workspaceRoot,
              createdAt: new Date().toISOString(),
            },
          });
          created = true;
          const createdAt = new Date().toISOString();
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.start",
              commandId: crypto.randomUUID(),
              threadId,
              message: {
                messageId: crypto.randomUUID(),
                role: "user",
                text: "Reply with exactly claude-fixture-ok. Do not call tools, change files, or use the network.",
                attachments: [],
              },
              modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
              titleSeed: "Agent Tag explicit Claude fixture",
              runtimeMode: "approval-required",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Agent Tag explicit Claude fixture",
                  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: workspaceRoot,
                  createdAt,
                },
                runSetupScript: false,
              },
              createdAt,
            },
          });
          const snapshot = await waitForSnapshot(
            threadId,
            (candidate) => candidate.thread.latestTurn?.state === "completed",
            120_000,
          );
          expect(snapshot.thread.modelSelection).toEqual({
            instanceId: "claudeAgent",
            model: "claude-sonnet-4-6",
          });
          expect(snapshot.thread.session).toMatchObject({
            providerInstanceId: "claudeAgent",
            lastError: null,
          });
          const assistantMessages = snapshot.thread.messages.filter(
            (message) => message.role === "assistant" && !message.streaming,
          );
          expect(assistantMessages.at(-1)?.text.trim()).toBe("claude-fixture-ok");
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
          if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-claude-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
          }
          await removeFixtureDirectory(workspaceRoot);
        }
      },
      150_000,
    );

    test(
      "accepts a supervised Codex command approval and completes the turn",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-approval-"));
        const projectId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        let created = false;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "fixture-ok\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add approval fixture");

          await dispatchT3Command({
            config,
            command: {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId,
              title: "Agent Tag approval fixture",
              workspaceRoot,
              createdAt: new Date().toISOString(),
            },
          });
          created = true;
          const createdAt = new Date().toISOString();
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.start",
              commandId: crypto.randomUUID(),
              threadId,
              message: {
                messageId: crypto.randomUUID(),
                role: "user",
                text: "Run the command cat README.md, then reply with exactly its contents. Do not change files or use the network.",
                attachments: [],
              },
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              titleSeed: "Agent Tag command approval fixture",
              runtimeMode: "approval-required",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Agent Tag command approval fixture",
                  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: workspaceRoot,
                  createdAt,
                },
                runSetupScript: false,
              },
              createdAt,
            },
          });

          const approvalSnapshot = await waitForSnapshot(
            threadId,
            (snapshot) => pendingT3Approvals(snapshot).length > 0,
          );
          const respondedRequestIds = new Set<string>();
          const deadline = Date.now() + 60_000;
          let completedSnapshot = approvalSnapshot;
          while (completedSnapshot.thread.latestTurn?.state !== "completed" && Date.now() < deadline) {
            for (const approval of pendingT3Approvals(completedSnapshot)) {
              if (respondedRequestIds.has(approval.requestId)) continue;
              expect(approval.requestKind).toBe("command");
              await dispatchT3Command({
                config,
                command: {
                  type: "thread.approval.respond",
                  commandId: crypto.randomUUID(),
                  threadId,
                  requestId: approval.requestId,
                  decision: "accept",
                  createdAt: new Date().toISOString(),
                },
              });
              respondedRequestIds.add(approval.requestId);
            }
            await Bun.sleep(250);
            completedSnapshot = await fetchT3ThreadSnapshot({ config, threadId });
            if (completedSnapshot.thread.latestTurn?.state === "error") {
              throw new Error("T3 provider turn entered the error state after approval");
            }
          }
          if (completedSnapshot.thread.latestTurn?.state !== "completed") {
            throw new Error("timed out waiting for the approved T3 turn to complete");
          }
          expect(respondedRequestIds.size).toBeGreaterThan(0);
          expect(pendingT3Approvals(completedSnapshot)).toEqual([]);
          const assistantMessages = completedSnapshot.thread.messages.filter(
            (message) => message.role === "assistant",
          );
          expect(assistantMessages.at(-1)?.text.trim()).toBe("fixture-ok");
          expect(completedSnapshot.thread.session?.lastError).toBeNull();
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
          if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-approval-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
          }
          await removeFixtureDirectory(workspaceRoot);
        }
      },
      90_000,
    );

    test(
      "reconciles one durable operation through T3 after a store and worker restart",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-coordinator-repo-"));
        const dataDirectory = await mkdtemp(join(tmpdir(), "agent-tag-t3-coordinator-data-"));
        const storePath = join(dataDirectory, "agent-tag.sqlite");
        let store = await AgentTagStore.open(storePath);
        let projectId: string | null = null;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag coordinator fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add coordinator fixture");

          const serviceConfig = agentTagConfigSchema.parse({
            version: 1,
            dataDir: dataDirectory,
            t3: config,
            slack: {
              workspaceId: "T1",
              appTokenFile: join(dataDirectory, "slack-app-token"),
              botTokenFile: join(dataDirectory, "slack-bot-token"),
            },
            access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
            profiles: [
              {
                id: "engineering",
                repositoryRoots: [workspaceRoot],
                baseBranch: "main",
                defaultProviderInstanceId: "codex",
                defaultModel: "gpt-5.6-sol",
                runtimeMode: "approval-required",
                isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
                externalWrites: { mode: "deny" },
                memory: { shared: true, privateDm: false, retentionDays: 30 },
              },
            ],
            routes: [{ conversationId: "C1", profileId: "engineering" }],
            limits: { maxConcurrentTasks: 1 },
          });
          const receivedAt = new Date().toISOString();
          // PR-K: a channel note reaches the thread's first turn, and only that turn.
          store.createMemory({
            workspaceId: "T1", scope: "channel", conversationId: "C1", content: "reports go out as tables",
            sourceType: "slack-command", sourceId: "C1:999.000001", actorUserId: "U1",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(), now: receivedAt,
          });
          const receipt = store.ingestSlackEvent({
            deliveryId: crypto.randomUUID(),
            eventKey: `C1:${Date.now()}.000001`,
            workspaceId: "T1",
            conversationId: "C1",
            threadTs: "1000.000001",
            actorUserId: "U1",
            conversationType: "channel",
            profileId: "engineering",
            repositoryRoot: workspaceRoot,
            text: "Reply with exactly durable-fixture-ok. Do not call tools, change files, or use the network.",
            receivedAt,
            sourceOrderKey: "1000.000001",
          });
          const binding = store.getTaskExecution(receipt.taskId);
          projectId = binding.projectId;
          let simulateRestart = true;
          const firstCoordinator = new AgentTagCoordinator({
            config: serviceConfig,
            store,
            t3: {
              dispatch: (command) => dispatchT3Command({ config, command }),
              fetchThread: async (threadId) => {
                if (simulateRestart) {
                  simulateRestart = false;
                  const error = new Error("simulated bridge restart");
                  error.name = "SimulatedBridgeRestart";
                  throw error;
                }
                return fetchT3ThreadSnapshot({ config, threadId });
              },
            },
            workerId: `live-before-restart-${crypto.randomUUID()}`,
            pollMs: 250,
            stallMs: 60_000,
          });
          expect(await firstCoordinator.processNext()).toMatchObject({
            kind: "retry-scheduled",
            operationId: receipt.operationId,
            errorCode: "SimulatedBridgeRestart",
          });
          store.close();
          store = await AgentTagStore.open(storePath);
          const restartedCoordinator = new AgentTagCoordinator({
            config: serviceConfig,
            store,
            workerId: `live-after-restart-${crypto.randomUUID()}`,
            now: () => new Date(Date.now() + 2_000),
            pollMs: 250,
            stallMs: 60_000,
          });
          const outcome = await restartedCoordinator.processNext();
          expect(outcome).toMatchObject({ kind: "completed", operationId: receipt.operationId });
          const progress = store.claimNextOutbox({
            workerId: "slack-live-fixture",
            now: new Date().toISOString(),
            leaseMs: 10_000,
          });
          if (progress === null) throw new Error("durable progress message was not queued");
          store.markOutboxDelivered({
            outboxId: progress.outboxId,
            workerId: "slack-live-fixture",
            slackMessageTs: "1000.000002",
            now: new Date().toISOString(),
          });
          // Status-message refreshes (PR-F) queue beside the reply; the reply is the first new post.
          let outbox = store.claimNextOutbox({ workerId: "slack-live-fixture", now: new Date().toISOString(), leaseMs: 10_000 });
          while (outbox !== null && outbox.refreshKind !== null) {
            outbox = store.claimNextOutbox({ workerId: "slack-live-fixture", now: new Date().toISOString(), leaseMs: 10_000 });
          }
          expect(outbox?.payload.text.trim()).toBe("durable-fixture-ok");
          expect(outbox?.correlationId).toBe(receipt.operationId);

          const userTexts = (snapshot: T3ThreadSnapshot) =>
            snapshot.thread.messages.filter((message) => message.role === "user").map((message) => message.text);
          const firstTurn = userTexts(await fetchT3ThreadSnapshot({ config, threadId: binding.threadId }));
          expect(firstTurn).toHaveLength(1);
          expect(firstTurn[0]).toStartWith('<agent-tag-memory updated="false">\n');
          expect(firstTurn[0]).toContain("reports go out as tables");
          const second = store.ingestSlackEvent({
            deliveryId: crypto.randomUUID(), eventKey: `C1:${Date.now()}.000002`,
            workspaceId: "T1", conversationId: "C1", threadTs: "1000.000001",
            actorUserId: "U1", conversationType: "channel", profileId: "engineering",
            repositoryRoot: workspaceRoot,
            text: "Reply with exactly second-turn-ok. Do not call tools, change files, or use the network.",
            receivedAt: new Date().toISOString(), sourceOrderKey: "1000.000002",
          });
          expect(await restartedCoordinator.processNext()).toMatchObject({ kind: "completed", operationId: second.operationId });
          const secondTurn = userTexts(await fetchT3ThreadSnapshot({ config, threadId: binding.threadId }));
          expect(secondTurn).toHaveLength(2);
          expect(secondTurn[1]).not.toContain("agent-tag-memory");
          expect(secondTurn[1]).toContain("second-turn-ok");

          const beforeRevocation = await fetchT3ThreadSnapshot({ config, threadId: binding.threadId });
          const followup = store.ingestSlackEvent({
            deliveryId: crypto.randomUUID(), eventKey: `C1:${Date.now()}.000003`,
            workspaceId: "T1", conversationId: "C1", threadTs: "1000.000001",
            actorUserId: "U1", conversationType: "channel", profileId: "engineering",
            repositoryRoot: workspaceRoot, text: "Revoked follow-up must never reach T3.",
            receivedAt: new Date().toISOString(), sourceOrderKey: "1000.000003",
          });
          store.close();
          store = await AgentTagStore.open(storePath);
          const revokedCoordinator = new AgentTagCoordinator({
            config: { ...serviceConfig, routes: [] }, store,
          });
          expect(await revokedCoordinator.processNext()).toMatchObject({
            kind: "failed", operationId: followup.operationId, errorCode: "ExecutionAuthorityDenied",
          });
          const afterRevocation = await fetchT3ThreadSnapshot({ config, threadId: binding.threadId });
          expect(afterRevocation.thread.messages).toEqual(beforeRevocation.thread.messages);
          expect(afterRevocation.thread.latestTurn).toEqual(beforeRevocation.thread.latestTurn);
        } finally {
          if (projectId !== null) {
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
          store.close();
          for (const directory of [workspaceRoot, dataDirectory]) {
            if (!directory.startsWith(`${tmpdir()}/agent-tag-t3-coordinator-`)) {
              throw new Error(`refusing to remove unexpected fixture path ${directory}`);
            }
            await removeFixtureDirectory(directory);
          }
        }
      },
      150_000,
    );

    test(
      "rejects a supervised command and interrupts a waiting turn",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-control-"));
        const projectId = crypto.randomUUID();
        let created = false;
        try {
          await writeFile(join(workspaceRoot, "README.md"), "control-fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add control fixture");
          await dispatchT3Command({
            config,
            command: {
              type: "project.create",
              commandId: crypto.randomUUID(),
              projectId,
              title: "Agent Tag control fixture",
              workspaceRoot,
              createdAt: new Date().toISOString(),
            },
          });
          created = true;

          const startTurn = async (threadId: string, title: string): Promise<void> => {
            const createdAt = new Date().toISOString();
            await dispatchT3Command({
              config,
              command: {
                type: "thread.turn.start",
                commandId: crypto.randomUUID(),
                threadId,
                message: {
                  messageId: crypto.randomUUID(),
                  role: "user",
                  text: "Run the command cat README.md, then report whether it succeeded. Do not change files or use the network.",
                  attachments: [],
                },
                modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                titleSeed: title,
                runtimeMode: "approval-required",
                interactionMode: "default",
                bootstrap: {
                  createThread: {
                    projectId,
                    title,
                    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: "main",
                    worktreePath: workspaceRoot,
                    createdAt,
                  },
                  runSetupScript: false,
                },
                createdAt,
              },
            });
          };

          const rejectedThreadId = crypto.randomUUID();
          await startTurn(rejectedThreadId, "Agent Tag rejection fixture");
          let rejectedSnapshot = await waitForSnapshot(
            rejectedThreadId,
            (snapshot) => pendingT3Approvals(snapshot).length > 0,
          );
          const declined = new Set<string>();
          const rejectionDeadline = Date.now() + 60_000;
          while (
            rejectedSnapshot.thread.latestTurn?.state !== "completed" &&
            Date.now() < rejectionDeadline
          ) {
            for (const approval of pendingT3Approvals(rejectedSnapshot)) {
              if (declined.has(approval.requestId)) continue;
              await dispatchT3Command({
                config,
                command: {
                  type: "thread.approval.respond",
                  commandId: crypto.randomUUID(),
                  threadId: rejectedThreadId,
                  requestId: approval.requestId,
                  decision: "decline",
                  createdAt: new Date().toISOString(),
                },
              });
              declined.add(approval.requestId);
            }
            await Bun.sleep(250);
            rejectedSnapshot = await fetchT3ThreadSnapshot({ config, threadId: rejectedThreadId });
          }
          expect(declined.size).toBeGreaterThan(0);
          expect(rejectedSnapshot.thread.latestTurn?.state).toBe("completed");
          expect(pendingT3Approvals(rejectedSnapshot)).toEqual([]);

          const interruptedThreadId = crypto.randomUUID();
          await startTurn(interruptedThreadId, "Agent Tag interruption fixture");
          const waiting = await waitForSnapshot(
            interruptedThreadId,
            (snapshot) => pendingT3Approvals(snapshot).length > 0,
          );
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.interrupt",
              commandId: crypto.randomUUID(),
              threadId: interruptedThreadId,
              ...(waiting.thread.latestTurn?.turnId === undefined
                ? {}
                : { turnId: waiting.thread.latestTurn.turnId }),
              createdAt: new Date().toISOString(),
            },
          });
          const interrupted = await waitForSnapshot(
            interruptedThreadId,
            (snapshot) => snapshot.thread.latestTurn?.state === "interrupted",
          );
          expect(interrupted.thread.latestTurn?.state).toBe("interrupted");
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
          if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-control-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
          }
          await removeFixtureDirectory(workspaceRoot);
        }
      },
      120_000,
    );

    test(
      "agent files: a real thread worktree reads back exactly, escapes are refused, and T3 workspace-file serves only preview types (PR-L2 Done 8)",
      async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-uploads-"));
        const workspaceRoot = join(fixtureRoot, "repo");
        const projectId = crypto.randomUUID();
        const threadId = crypto.randomUUID();
        let created = false;
        try {
          await mkdir(workspaceRoot);
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag upload fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add upload fixture");
          await dispatchT3Command({
            config,
            command: { type: "project.create", commandId: crypto.randomUUID(), projectId, title: "Agent Tag upload fixture", workspaceRoot, createdAt: new Date().toISOString() },
          });
          created = true;
          const createdAt = new Date().toISOString();
          // The same bootstrap the coordinator sends: T3 prepares a worktree for the thread's branch.
          await dispatchT3Command({
            config,
            command: {
              type: "thread.turn.start",
              commandId: crypto.randomUUID(),
              threadId,
              message: { messageId: crypto.randomUUID(), role: "user", text: "Reply with exactly fixture-ok. Do not call tools.", attachments: [] },
              modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
              titleSeed: "Agent Tag upload fixture",
              runtimeMode: "approval-required",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId,
                  title: "Agent Tag upload fixture",
                  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: { projectCwd: workspaceRoot, baseBranch: "main", branch: `agent-tag/upload-${threadId.slice(0, 8)}` },
                runSetupScript: false,
              },
              createdAt,
            },
          });
          const prepared = await waitForSnapshot(threadId, (snapshot) => snapshot.thread.worktreePath !== null);
          const worktree = z.string().parse(prepared.thread.worktreePath);
          if (prepared.thread.latestTurn?.state === "running") {
            await dispatchT3Command({
              config,
              command: { type: "thread.turn.interrupt", commandId: crypto.randomUUID(), threadId, createdAt: new Date().toISOString() },
            }).catch(() => undefined);
          }

          const csv = new TextEncoder().encode("name,count\nalpha,1\n");
          const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2Z0AAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
          await mkdir(join(worktree, "out"), { recursive: true });
          await writeFile(join(worktree, "out", "report.csv"), csv);
          await writeFile(join(worktree, "out", "chart.png"), png);
          await writeFile(join(fixtureRoot, "host-only.png"), png);
          await symlink(join(fixtureRoot, "host-only.png"), join(worktree, "out", "escape.png"));

          // What Slack uploads use: the worktree on disk, with containment.
          const read = (path: string) => readWorkspaceArtifact({ root: worktree, path, maxBytes: 1024 * 1024 });
          const refusal = (path: string) => read(path).then(() => "read", (error: unknown) => (error instanceof ArtifactError ? error.code : String(error)));
          expect(await read("out/report.csv")).toEqual(csv);
          expect(await read("out/chart.png")).toEqual(png);
          expect(await refusal("../repo/README.md")).toBe("outside-workspace");
          expect(await refusal("out/escape.png")).toBe("outside-workspace");

          // The pinned T3 contract the spec assumed: exact bytes for a preview type, refused otherwise.
          const viaT3 = (path: string) => downloadT3WorkspaceFile({ config, threadId, path, maxBytes: 1024 * 1024 });
          expect(await viaT3("out/chart.png")).toEqual(png);
          await expect(viaT3("out/report.csv")).rejects.toBeInstanceOf(T3AssetTransferError);
          await expect(viaT3("../repo/README.md")).rejects.toBeInstanceOf(T3AssetTransferError);
          await expect(viaT3("out/escape.png")).rejects.toBeInstanceOf(T3AssetTransferError);
        } finally {
          if (created) {
            await dispatchT3Command({
              config,
              command: { type: "project.delete", commandId: crypto.randomUUID(), projectId, force: true },
            });
          }
          if (!fixtureRoot.startsWith(`${tmpdir()}/agent-tag-t3-uploads-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${fixtureRoot}`);
          }
          await removeFixtureDirectory(fixtureRoot);
        }
      },
      120_000,
    );
    test(
      "lifecycle cleanup: tasks close + tasks cleanup --once retire a real thread, worktree and branch; a dirty worktree is kept (PR-N Done 5)",
      async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-lifecycle-"));
        const workspaceRoot = join(fixtureRoot, "repo");
        const dataDirectory = join(fixtureRoot, "data");
        const configPath = join(fixtureRoot, "agent-tag.json");
        let store: AgentTagStore | null = null;
        let projectId: string | null = null;
        try {
          await mkdir(workspaceRoot);
          await mkdir(dataDirectory, { mode: 0o700 });
          await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag lifecycle fixture\n");
          await runGit(workspaceRoot, "init", "-b", "main");
          await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
          await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
          await runGit(workspaceRoot, "add", "README.md");
          await runGit(workspaceRoot, "commit", "-m", "test: add lifecycle fixture");
          const rawConfig = {
            version: 1,
            dataDir: dataDirectory,
            t3: config,
            slack: { workspaceId: "T1", appTokenFile: join(fixtureRoot, "slack-app-token"), botTokenFile: join(fixtureRoot, "slack-bot-token") },
            access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
            profiles: [{
              id: "engineering",
              repositoryRoots: [workspaceRoot],
              baseBranch: "main",
              defaultProviderInstanceId: "claudeAgent",
              defaultModel: "claude-sonnet-4-6",
              runtimeMode: "approval-required",
              isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
              externalWrites: { mode: "deny" },
              memory: { shared: true, privateDm: false, retentionDays: 30 },
            }],
            routes: [{ conversationId: "C1", profileId: "engineering" }],
            limits: { maxConcurrentTasks: 1 },
          };
          await writeFile(configPath, JSON.stringify(rawConfig));
          const serviceConfig = agentTagConfigSchema.parse(rawConfig);
          store = await AgentTagStore.open(join(dataDirectory, "agent-tag.sqlite"));
          const coordinator = new AgentTagCoordinator({ config: serviceConfig, store, workerId: `live-lifecycle-${crypto.randomUUID()}`, pollMs: 250, stallMs: 60_000 });

          // One real turn per task; each bootstraps its own worktree on agent-tag/<taskId>.
          const tasks: Array<{ taskId: string; threadId: string; worktree: string; branch: string }> = [];
          for (const threadTs of ["1000.000001", "2000.000001"]) {
            const receipt = store.ingestSlackEvent({
              deliveryId: crypto.randomUUID(),
              eventKey: `C1:${threadTs}`,
              workspaceId: "T1",
              conversationId: "C1",
              threadTs,
              actorUserId: "U1",
              conversationType: "channel",
              profileId: "engineering",
              repositoryRoot: workspaceRoot,
              text: "Reply with exactly lifecycle-fixture-ok. Do not call tools, change files, or use the network.",
              receivedAt: new Date().toISOString(),
              sourceOrderKey: threadTs,
            });
            const binding = store.getTaskExecution(receipt.taskId);
            projectId = binding.projectId;
            expect(await coordinator.processNext()).toMatchObject({ kind: "completed", operationId: receipt.operationId });
            for (let row = store.claimNextOutbox({ workerId: "slack-live", now: new Date().toISOString(), leaseMs: 10_000 }); row !== null;
              row = store.claimNextOutbox({ workerId: "slack-live", now: new Date().toISOString(), leaseMs: 10_000 })) {
              store.markOutboxDelivered({ outboxId: row.outboxId, workerId: "slack-live", slackMessageTs: `${threadTs}9`, now: new Date().toISOString() });
            }
            const snapshot = await fetchT3ThreadSnapshot({ config, threadId: binding.threadId });
            const worktree = z.string().parse(snapshot.thread.worktreePath);
            const branch = `agent-tag/${receipt.taskId}`;
            expect(snapshot.thread.branch).toBe(branch);
            expect(existsSync(worktree)).toBe(true);
            tasks.push({ taskId: receipt.taskId, threadId: binding.threadId, worktree, branch });
          }
          const [clean, dirty] = tasks;
          if (clean === undefined || dirty === undefined) throw new Error("fixture tasks were not created");
          await writeFile(join(dirty.worktree, "uncommitted.txt"), "keep me\n");
          store.close();
          store = null;

          const cli = async (argv: readonly string[]) => {
            const lines: string[] = [];
            const exitCode = await runTasksCommand(argv, { write: (line) => lines.push(line) });
            return { exitCode, lines };
          };
          for (const task of tasks) {
            expect(await cli(["close", task.taskId, configPath])).toEqual({
              exitCode: 0,
              lines: [`closed ${task.taskId} (generation 1); the next reply in its thread starts a new session`],
            });
          }
          const cleanup = await cli(["cleanup", configPath, "--once"]);
          console.log(cleanup.lines.join("\n"));
          expect(cleanup.exitCode).toBe(0);
          expect(cleanup.lines).toContain(`${clean.taskId} g1 (admin): worktree removed, branch deleted, done`);
          expect(cleanup.lines.some((line) => line.startsWith(`${dirty.taskId} g1 (admin): worktree retained-dirty, branch unknown, kept until `))).toBe(true);

          // The clean task: worktree, branch and T3 thread are gone.
          expect(existsSync(clean.worktree)).toBe(false);
          expect(await runGit(workspaceRoot, "branch", "--list", clean.branch)).toBe("");
          await expect(fetchT3ThreadSnapshot({ config, threadId: clean.threadId })).rejects.toBeInstanceOf(T3ThreadNotFoundError);
          const connection = new T3Connection({ config });
          try {
            const bindings = await connection.worktreeBindings();
            expect(bindings.map((binding) => binding.threadId)).not.toContain(clean.threadId);
            expect(bindings.map((binding) => binding.threadId)).not.toContain(dirty.threadId);
          } finally {
            await connection.close();
          }

          // The dirty task: its T3 thread is gone, its worktree and branch are kept.
          expect(existsSync(join(dirty.worktree, "uncommitted.txt"))).toBe(true);
          expect(await runGit(workspaceRoot, "branch", "--list", dirty.branch)).not.toBe("");
          store = await AgentTagStore.open(join(dataDirectory, "agent-tag.sqlite"));
          const states = Object.fromEntries(
            store.listPendingRetiredThreads().map((row) => [row.taskId, row.worktreeState]),
          );
          expect(states).toEqual({ [dirty.taskId]: "retained-dirty" });
          expect(store.lifecycleCounts()).toMatchObject({ closedTasks: 2, retainedDirty: 1, cleanupFailures: 0 });
        } finally {
          store?.close();
          if (projectId !== null) {
            await dispatchT3Command({
              config,
              command: { type: "project.delete", commandId: crypto.randomUUID(), projectId, force: true },
            }).catch(() => undefined);
          }
          if (!fixtureRoot.startsWith(`${tmpdir()}/agent-tag-t3-lifecycle-`)) {
            throw new Error(`refusing to remove unexpected fixture path ${fixtureRoot}`);
          }
          await removeFixtureDirectory(fixtureRoot);
        }
      },
      240_000,
    );

    /**
     * PR-P2 Done 7: what T3 0.0.45 does with a model change on a started thread. Starts a Claude
     * thread on `from`, then runs `act` on it; the fixture project is deleted afterwards.
     */
    async function withStartedClaudeThread(
      from: string,
      act: (input: { readonly threadId: string; readonly turn: (model: { instanceId: string; model: string }, text: string) => Promise<void> }) => Promise<void>,
    ): Promise<void> {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-switch-"));
      const projectId = crypto.randomUUID();
      const threadId = crypto.randomUUID();
      let created = false;
      try {
        await writeFile(join(workspaceRoot, "README.md"), "# Agent Tag model switch fixture\n");
        await runGit(workspaceRoot, "init", "-b", "main");
        await runGit(workspaceRoot, "config", "user.name", "Agent Tag Integration");
        await runGit(workspaceRoot, "config", "user.email", "agent-tag@example.invalid");
        await runGit(workspaceRoot, "add", "README.md");
        await runGit(workspaceRoot, "commit", "-m", "test: add model switch fixture");
        await dispatchT3Command({
          config,
          command: {
            type: "project.create",
            commandId: crypto.randomUUID(),
            projectId,
            title: "Agent Tag model switch fixture",
            workspaceRoot,
            createdAt: new Date().toISOString(),
          },
        });
        created = true;
        const createdAt = new Date().toISOString();
        const start = { instanceId: "claudeAgent", model: from };
        await dispatchT3Command({
          config,
          command: {
            type: "thread.turn.start",
            commandId: crypto.randomUUID(),
            threadId,
            message: {
              messageId: crypto.randomUUID(),
              role: "user",
              text: "Reply with exactly switch-one-ok. Do not call tools, change files, or use the network.",
              attachments: [],
            },
            modelSelection: start,
            titleSeed: "Agent Tag model switch fixture",
            runtimeMode: "approval-required",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId,
                title: "Agent Tag model switch fixture",
                modelSelection: start,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: "main",
                worktreePath: workspaceRoot,
                createdAt,
              },
              runSetupScript: false,
            },
            createdAt,
          },
        });
        await waitForSnapshot(threadId, (candidate) => candidate.thread.latestTurn?.state === "completed", 120_000);
        await act({
          threadId,
          turn: async (modelSelection, text) => {
            await dispatchT3Command({
              config,
              command: {
                type: "thread.turn.start",
                commandId: crypto.randomUUID(),
                threadId,
                message: { messageId: crypto.randomUUID(), role: "user", text, attachments: [] },
                modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                createdAt: new Date().toISOString(),
              },
            });
          },
        });
      } finally {
        if (created) {
          await dispatchT3Command({
            config,
            command: { type: "project.delete", commandId: crypto.randomUUID(), projectId, force: true },
          });
        }
        if (!workspaceRoot.startsWith(`${tmpdir()}/agent-tag-t3-switch-`)) {
          throw new Error(`refusing to remove unexpected fixture path ${workspaceRoot}`);
        }
        await removeFixtureDirectory(workspaceRoot);
      }
    }

    test(
      "moves a started thread to another model of the same driver in place, and the next turn runs on it",
      async () => {
        await withStartedClaudeThread("claude-haiku-4-5", async ({ threadId, turn }) => {
          const target = { instanceId: "claudeAgent", model: "claude-sonnet-4-6" };
          await dispatchT3Command({
            config,
            command: { type: "thread.meta.update", commandId: crypto.randomUUID(), threadId, modelSelection: target },
          });
          await turn(target, "Reply with exactly switch-two-ok. Do not call tools, change files, or use the network.");
          const snapshot = await waitForSnapshot(
            threadId,
            (candidate) =>
              candidate.thread.latestTurn?.state === "completed" &&
              candidate.thread.messages.some((message) => message.role === "assistant" && !message.streaming && message.text.includes("switch-two-ok")),
            120_000,
          );
          expect(snapshot.thread.modelSelection).toEqual(target);
          expect(snapshot.thread.session).toMatchObject({ providerInstanceId: "claudeAgent", lastError: null });
          expect(snapshot.thread.activities.some((activity) => activity.kind === "provider.turn.start.failed")).toBe(false);
        });
      },
      300_000,
    );

    test(
      "refuses a turn that moves a started thread to another driver with provider.turn.start.failed",
      async () => {
        await withStartedClaudeThread("claude-haiku-4-5", async ({ threadId, turn }) => {
          await turn({ instanceId: "codex", model: "gpt-5.6-sol" }, "Reply with exactly switch-cross-ok.");
          const snapshot = await waitForSnapshot(
            threadId,
            (candidate) => candidate.thread.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
            60_000,
          );
          const failure = snapshot.thread.activities.find((activity) => activity.kind === "provider.turn.start.failed")!;
          const detail = z.object({ detail: z.string() }).parse(failure.payload).detail;
          // Agent Tag reads this as a refused switch, so the thread keeps its model (Done 6).
          expect(classifyT3TurnFailure(detail).code).toBe("T3ModelSwitchRejected");
          expect(snapshot.thread.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-haiku-4-5" });
          console.log(`provider.turn.start.failed detail: ${detail}`);
        });
      },
      240_000,
    );
  });
}
