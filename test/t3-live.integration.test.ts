import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

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
  });
}
