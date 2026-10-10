// Live GitHub acceptance for the draft PR workflow (PR-M §2 Done 8), opt-in only:
//
//   AGENT_TAG_LIVE_GITHUB=1 \
//   AGENT_TAG_LIVE_GITHUB_REPO=owner/sandbox \
//   AGENT_TAG_LIVE_GITHUB_TOKEN_FILE=/abs/path/github-token \   # mode 0600, fine-grained PAT on the sandbox only
//   bun test test/github-live.integration.test.ts
//
// Clones the sandbox, edits README in an `agent-tag/<task>` worktree, then drives the real snapshot →
// completion transaction → PR worker path against github.com: one draft PR, a follow-up push to the same
// PR number, and no job for a turn with no changes. The PR is left open for the evidence file; close it
// by hand. The Slack card and T3 process inspection are separate human steps in the evidence template.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { preparePullRequestSync } from "../src/git/pr-sync.ts";
import { PrWorker } from "../src/git/pr-worker.ts";
import { createGitRunner } from "../src/git/runner.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { git, withTempDir } from "./fixtures/git-fixture.ts";

const enabled = Bun.env.AGENT_TAG_LIVE_GITHUB === "1";
const repoName = Bun.env.AGENT_TAG_LIVE_GITHUB_REPO ?? "";
const tokenFile = Bun.env.AGENT_TAG_LIVE_GITHUB_TOKEN_FILE ?? "";

describe.skipIf(!enabled)("live GitHub draft PR workflow", () => {
  test("one draft PR, a follow-up push to the same PR, no PR for a no-change turn", async () => {
    expect(repoName).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(tokenFile.startsWith("/")).toBe(true);
    await withTempDir("github-live", async (directory) => {
      const root = join(directory, "repo");
      const taskSuffix = crypto.randomUUID().slice(0, 8);
      // Public read of the sandbox; the token is only ever used by Agent Tag's own push and API calls.
      git(directory, "clone", "--quiet", `https://github.com/${repoName}.git`, root);
      const baseBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
      const config = agentTagConfigSchema.parse({
        version: 1,
        dataDir: join(directory, "data"),
        t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/nonexistent/t3-token" },
        slack: { workspaceId: "T1", appTokenFile: "/nonexistent/a", botTokenFile: "/nonexistent/b" },
        github: { auth: { type: "token", tokenFile } },
        access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
        profiles: [{
          id: "live",
          repositoryRoots: [root],
          baseBranch,
          defaultProviderInstanceId: "codex",
          defaultModel: "gpt-5.6-sol",
          runtimeMode: "approval-required",
          isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
          externalWrites: { mode: "approval-required" },
          memory: { shared: true, privateDm: false, retentionDays: 180 },
          pullRequests: { mode: "auto", repositories: [{ root, repo: repoName }] },
        }],
        routes: [{ conversationId: "C1", profileId: "live" }],
        limits: { maxConcurrentTasks: 1 },
      });
      const profile = config.profiles[0]!;
      const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
      const runner = createGitRunner();
      const worker = new PrWorker({ config, store, runner });
      let index = 0;
      let branch = "";
      let worktree = "";
      const turn = async (request: string, edit: (() => Promise<void>) | undefined) => {
        index += 1;
        const now = new Date().toISOString();
        const receipt = store.ingestSlackEvent({
          deliveryId: `live-${taskSuffix}-${index}`,
          eventKey: `C1:1.${index}`,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1.1",
          actorUserId: "U1",
          conversationType: "channel",
          profileId: "live",
          repositoryRoot: root,
          text: request,
          receivedAt: now,
          sourceOrderKey: `1.${index}`,
        });
        if (branch === "") {
          branch = `agent-tag/${receipt.taskId}`;
          worktree = join(directory, "worktree");
          git(root, "worktree", "add", "--quiet", "-b", branch, worktree, baseBranch);
        }
        await edit?.();
        const claimed = store.claimNextOperation({ workerId: "live", now, leaseMs: 120_000, maxConcurrentTasks: 1 });
        if (claimed === null) throw new Error("operation was not claimed");
        const prSync = await preparePullRequestSync({
          config,
          store,
          options: { runner },
          profile,
          taskId: claimed.taskId,
          repositoryRoot: root,
          t3Thread: { branch, worktreePath: worktree },
          requestText: request,
          summaryText: `Live acceptance turn ${index}: ${request}`,
          conversationId: "C1",
          threadTs: "1.1",
          actorUserId: "U1",
        });
        store.completeOperationWithOutbox({
          operationId: claimed.operationId,
          taskId: claimed.taskId,
          workerId: "live",
          resultSequence: index,
          conversationId: "C1",
          threadTs: "1.1",
          text: `turn ${index} done`,
          ...(prSync === undefined ? {} : { prSync, actorUserId: "U1" }),
          now: new Date().toISOString(),
        });
        return { taskId: claimed.taskId, prSync };
      };
      try {
        const first = await turn("fix the typo in README", async () => {
          const readme = join(worktree, "README.md");
          const text = await Bun.file(readme).text().catch(() => "");
          await Bun.write(readme, `${text}\nAgent Tag live acceptance ${taskSuffix}.\n`);
        });
        expect(first.prSync?.kind).toBe("ready");
        const created = await worker.processNext();
        expect(created.kind).toBe("created");
        const pull = store.getTaskPullRequest(first.taskId);
        expect(pull?.state).toBe("open");
        console.log(`live draft PR: ${pull?.url} (draft=${pull?.draft})`);

        await turn("also mention the date", async () => {
          await Bun.write(join(worktree, "LIVE-ACCEPTANCE.md"), `${new Date().toISOString()}\n`);
        });
        const pushed = await worker.processNext();
        expect(pushed).toMatchObject({ kind: "pushed", number: pull?.number });

        const question = await turn("what does README say?", undefined);
        expect(question.prSync).toBeUndefined();
        expect(await worker.processNext()).toEqual({ kind: "idle" });
        expect(store.getTaskPullRequest(first.taskId)?.number).toBe(pull?.number);
      } finally {
        store.close();
      }
    });
  }, 180_000);
});
