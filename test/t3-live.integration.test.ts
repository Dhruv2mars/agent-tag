import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import { AgentTagStore } from "../src/store/store.ts";
import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  inspectT3,
  pendingT3Approvals,
  watchT3Thread,
  type T3Command,
  type T3ThreadSnapshot,
} from "../src/t3/gateway.ts";

const enabled = Bun.env.RUN_T3_INTEGRATION === "1";

async function runGit(cwd: string, ...args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
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
          throw new Error("T3 provider turn entered the error state");
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
          await rm(workspaceRoot, { recursive: true });
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
          await rm(workspaceRoot, { recursive: true });
        }
      },
      90_000,
    );

    test(
      "carries one durable operation through T3 into the Slack outbox",
      async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tag-t3-coordinator-repo-"));
        const dataDirectory = await mkdtemp(join(tmpdir(), "agent-tag-t3-coordinator-data-"));
        const store = await AgentTagStore.open(join(dataDirectory, "agent-tag.sqlite"));
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
          const receipt = store.ingestSlackEvent({
            deliveryId: crypto.randomUUID(),
            eventKey: `C1:${Date.now()}.000001`,
            workspaceId: "T1",
            conversationId: "C1",
            threadTs: "1000.000001",
            actorUserId: "U1",
            profileId: "engineering",
            repositoryRoot: workspaceRoot,
            text: "Reply with exactly durable-fixture-ok. Do not call tools, change files, or use the network.",
            receivedAt,
            sourceOrderKey: "1000.000001",
          });
          const binding = store.getTaskExecution(receipt.taskId);
          projectId = binding.projectId;
          const coordinator = new AgentTagCoordinator({
            config: serviceConfig,
            store,
            workerId: `live-${crypto.randomUUID()}`,
            pollMs: 250,
            maxWaitMs: 60_000,
          });
          const outcome = await coordinator.processNext();
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
          const outbox = store.claimNextOutbox({
            workerId: "slack-live-fixture",
            now: new Date().toISOString(),
            leaseMs: 10_000,
          });
          expect(outbox?.payload.text.trim()).toBe("durable-fixture-ok");
          expect(outbox?.correlationId).toBe(receipt.operationId);
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
            await rm(directory, { recursive: true });
          }
        }
      },
      90_000,
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
          await rm(workspaceRoot, { recursive: true });
        }
      },
      120_000,
    );
  });
}
