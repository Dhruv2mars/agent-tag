// Draft PR workflow end to end (PR-M §7 M2): coordinator snapshot hook → job in the completion
// transaction → PR worker push to a local bare remote → fake GitHub → Slack card / line / notices.
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { type AgentTagConfig, agentTagConfigSchema } from "../src/config.ts";
import { AgentTagCoordinator } from "../src/coordinator.ts";
import { PrWorker } from "../src/git/pr-worker.ts";
import { pullRequestRequestText } from "../src/git/pr-sync.ts";
import { githubRemoteUrl } from "../src/git/push.ts";
import { createGitRunner, type GitRunner, type GitSpawn } from "../src/git/runner.ts";
import type { GitHubCredentials } from "../src/github/auth.ts";
import {
  createGitHubClient,
  type CreatePullInput,
  type CreatePullResult,
  GitHubApiError,
  type GitHubClient,
  type GitHubPull,
} from "../src/github/client.ts";
import { SecretString } from "../src/security/secret-file.ts";
import { AgentTagStore, type SlackOutboxPayload } from "../src/store/store.ts";
import type { T3ThreadSnapshot } from "../src/t3/gateway.ts";
import { canaryToken, createSourceRepo, git, recordingSpawn, type SourceRepo, withTempDir } from "./fixtures/git-fixture.ts";

const REPO = "octo/example";
const START = Date.parse("2026-09-21T00:00:00.000Z");

function isolatedRunner(spawn?: GitSpawn): GitRunner {
  return createGitRunner({
    parentEnv: { PATH: process.env.PATH, HOME: "/nonexistent-agent-tag-home" },
    ...(spawn === undefined ? {} : { spawn }),
  });
}

function buildConfig(
  repo: SourceRepo,
  dataDir: string,
  overrides: { readonly mode?: "auto" | "off"; readonly allowedUserIds?: readonly string[] } = {},
): AgentTagConfig {
  return agentTagConfigSchema.parse({
    version: 1,
    dataDir,
    t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
    slack: {
      workspaceId: "T1",
      appTokenFile: "/var/lib/agent-tag/slack-app-token",
      botTokenFile: "/var/lib/agent-tag/slack-bot-token",
    },
    github: { auth: { type: "token", tokenFile: "/nonexistent/github-token" } },
    access: { allowedUserIds: overrides.allowedUserIds ?? ["U1"], allowedChannelIds: ["C1"] },
    profiles: [
      {
        id: "engineering",
        repositoryRoots: [repo.root],
        baseBranch: "main",
        defaultProviderInstanceId: "codex",
        defaultModel: "gpt-5.6-sol",
        runtimeMode: "approval-required",
        isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
        externalWrites: { mode: "approval-required" },
        memory: { shared: true, privateDm: false, retentionDays: 180 },
        pullRequests:
          overrides.mode === "off" ? { mode: "off" } : { mode: "auto", repositories: [{ root: repo.root, repo: REPO }] },
      },
    ],
    routes: [{ conversationId: "C1", profileId: "engineering" }],
    limits: { maxConcurrentTasks: 2 },
  });
}

/** In-memory GitHub that checks the head branch really exists on the bare remote before opening a PR. */
class FakeGitHub implements GitHubClient {
  readonly pulls = new Map<number, GitHubPull>();
  readonly creates: CreatePullInput[] = [];
  readonly gets: number[] = [];
  /** Thrown by the next `createDraftPull`; `afterCreate` throws only once the PR exists (lost response). */
  failCreate: { readonly error: Error; readonly afterCreate: boolean } | undefined;

  constructor(private readonly remotePath: string) {}

  async findPullByHead(_repo: string, headBranch: string): Promise<GitHubPull | undefined> {
    const matches = [...this.pulls.values()].filter((pull) => pull.headRef === headBranch);
    const newest = matches.at(-1);
    if (newest === undefined) return undefined;
    const { additions: _a, deletions: _d, changedFiles: _c, commits: _n, ...listed } = newest;
    return listed;
  }

  async createDraftPull(_repo: string, input: CreatePullInput): Promise<CreatePullResult> {
    this.creates.push(input);
    const failure = this.failCreate;
    if (failure !== undefined && !failure.afterCreate) {
      this.failCreate = undefined;
      throw failure.error;
    }
    const headSha = git(this.remotePath, "rev-parse", `refs/heads/${input.head}`);
    const number = this.pulls.size + 1;
    this.pulls.set(number, {
      number,
      htmlUrl: `https://github.example/${REPO}/pull/${number}`,
      state: "open",
      merged: false,
      draft: input.draft ?? false,
      title: input.title,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      commits: 1,
    });
    if (failure !== undefined) {
      this.failCreate = undefined;
      throw failure.error;
    }
    return { pull: this.pulls.get(number)!, created: true, draftUnavailable: false };
  }

  async getPull(_repo: string, number: number): Promise<GitHubPull> {
    this.gets.push(number);
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new GitHubApiError({ kind: "not-found", message: "no such pull", status: 404 });
    return pull;
  }

  async checkPushAccess(): Promise<"yes"> {
    return "yes";
  }

  update(number: number, patch: Partial<GitHubPull>): void {
    this.pulls.set(number, { ...this.pulls.get(number)!, ...patch });
  }
}

/** GitHub REST over real HTTP (Bun.serve). The client insists on https, so its fetch is pointed here. */
function serveGitHub(remotePath: string) {
  interface RawPull {
    number: number;
    html_url: string;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    additions: number;
    deletions: number;
    changed_files: number;
    commits: number;
  }
  const pulls: RawPull[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const authorizations: string[] = [];
  let loseNextCreateResponse = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      authorizations.push(request.headers.get("authorization") ?? "");
      const json = (status: number, body: unknown) => Response.json(body, { status });
      if (url.pathname === `/repos/${REPO}/pulls` && request.method === "GET") {
        const head = url.searchParams.get("head")?.split(":")[1];
        return json(200, pulls.filter((pull) => pull.head.ref === head).map(({ additions: _a, deletions: _d, changed_files: _c, commits: _n, ...listed }) => listed));
      }
      if (url.pathname === `/repos/${REPO}/pulls` && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        posts.push(body);
        if (pulls.some((pull) => pull.head.ref === body.head && pull.state === "open")) {
          return json(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for octo:x." }] });
        }
        const number = pulls.length + 1;
        const head = String(body.head);
        const pull: RawPull = {
          number,
          html_url: `https://github.example/${REPO}/pull/${number}`,
          state: "open",
          draft: body.draft === true,
          merged: false,
          title: String(body.title),
          head: { ref: head, sha: git(remotePath, "rev-parse", `refs/heads/${head}`) },
          base: { ref: String(body.base) },
          additions: 3,
          deletions: 1,
          changed_files: 1,
          commits: Number(git(remotePath, "rev-list", "--count", `refs/heads/${head}`)) - 1,
        };
        pulls.push(pull);
        if (loseNextCreateResponse) {
          loseNextCreateResponse = false;
          return json(502, { message: "Bad Gateway" });
        }
        return json(201, pull);
      }
      const single = new RegExp(`^/repos/${REPO}/pulls/(\\d+)$`).exec(url.pathname);
      if (single !== null && request.method === "GET") {
        const pull = pulls.find((candidate) => candidate.number === Number(single[1]));
        if (pull === undefined) return json(404, { message: "Not Found" });
        pull.head.sha = git(remotePath, "rev-parse", `refs/heads/${pull.head.ref}`);
        pull.commits = Number(git(remotePath, "rev-list", "--count", `refs/heads/${pull.head.ref}`)) - 1;
        return json(200, pull);
      }
      return json(404, { message: `no route ${request.method} ${url.pathname}` });
    },
  });
  const client = createGitHubClient({
    apiBaseUrl: "https://api.github.example",
    credentials,
    fetch: (input, init) => fetch(input.replace("https://api.github.example", `http://127.0.0.1:${server.port}`), init),
  });
  return {
    client,
    pulls,
    posts,
    authorizations,
    loseNextCreateResponse: () => {
      loseNextCreateResponse = true;
    },
    stop: () => server.stop(true),
  };
}

const credentials: GitHubCredentials = {
  token: async () => new SecretString(canaryToken()),
  describe: () => "test token",
};

interface Harness {
  readonly repo: SourceRepo;
  readonly store: AgentTagStore;
  readonly github: FakeGitHub;
  readonly remotePath: string;
  readonly config: AgentTagConfig;
  readonly turnTexts: string[];
  /** Advances the shared clock. */
  advance(milliseconds: number): void;
  now(): Date;
  coordinator(options?: { readonly runner?: GitRunner; readonly config?: AgentTagConfig; readonly noPullRequests?: boolean }): AgentTagCoordinator;
  worker(options?: {
    readonly config?: AgentTagConfig;
    readonly github?: GitHubClient;
    readonly threadLink?: (conversationId: string, threadTs: string) => Promise<string | undefined>;
  }): PrWorker;
  /** Ingests one Slack mention in the shared thread and runs the coordinator to completion. */
  turn(text: string, coordinator?: AgentTagCoordinator): Promise<string>;
  /** Claims and delivers every queued Slack message, oldest first. */
  drain(): Array<{ readonly clientMessageId: string; readonly payload: SlackOutboxPayload }>;
  remoteHead(branch: string): string | undefined;
  /** The shared thread's task, once the first turn ran. */
  taskId(): string;
}

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  await withTempDir("pr-workflow", async (directory) => {
    const repo = await createSourceRepo(directory);
    const dataDir = join(directory, "data");
    const remoteBase = join(directory, "remote");
    const remotePath = join(remoteBase, "octo", "example.git");
    await mkdir(remotePath, { recursive: true });
    git(remotePath, "init", "--quiet", "--bare");
    const config = buildConfig(repo, dataDir);
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    const github = new FakeGitHub(remotePath);
    let clock = START;
    const now = () => new Date(clock);
    let threadId = "not-dispatched";
    let currentMessageId: string | undefined;
    let finalText = "";
    let sequence = 0;
    const turnTexts: string[] = [];
    const snapshot = (): T3ThreadSnapshot => ({
      snapshotSequence: 100 + sequence,
      thread: {
        id: threadId,
        projectId: "project-1",
        title: "Fixture",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: repo.branch,
        worktreePath: repo.worktree,
        latestTurn: {
          turnId: `turn-${sequence}`,
          state: "completed",
          requestedAt: now().toISOString(),
          startedAt: now().toISOString(),
          completedAt: now().toISOString(),
          assistantMessageId: `assistant-${sequence}`,
        },
        messages: [
          ...(currentMessageId === undefined
            ? []
            : [{
                id: currentMessageId,
                role: "user" as const,
                text: "request",
                turnId: null,
                streaming: false,
                createdAt: now().toISOString(),
                updatedAt: now().toISOString(),
              }]),
          {
            id: `assistant-${sequence}`,
            role: "assistant" as const,
            text: finalText,
            turnId: `turn-${sequence}`,
            streaming: false,
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
          },
        ],
        activities: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now().toISOString(),
        },
      },
    });
    const coordinator: Harness["coordinator"] = (options = {}) =>
      new AgentTagCoordinator({
        config: options.config ?? config,
        store,
        t3: {
          dispatch: async (command) => {
            sequence += 1;
            if (command.type === "thread.turn.start") {
              threadId = command.threadId;
              currentMessageId = command.message.messageId;
              turnTexts.push(command.message.text);
            }
            return { sequence };
          },
          fetchThread: async () => snapshot(),
        },
        workerId: "coordinator-a",
        now,
        sleep: async () => {},
        ...(options.noPullRequests === true
          ? {}
          : { pullRequests: { runner: options.runner ?? isolatedRunner(), gitRoot: repo.gitRoot } }),
      });
    let eventIndex = 0;
    let taskId: string | undefined;
    const harness: Harness = {
      repo,
      store,
      github,
      remotePath,
      config,
      turnTexts,
      advance: (milliseconds) => {
        clock += milliseconds;
      },
      now,
      coordinator,
      worker: (options = {}) =>
        new PrWorker({
          config: options.config ?? config,
          store,
          github: options.github ?? github,
          credentials,
          runner: isolatedRunner(),
          gitRoot: repo.gitRoot,
          testRemoteUrlFor: (name) => githubRemoteUrl(`file://${remoteBase}`, name, { allowTestRemote: true }),
          workerId: "pr-a",
          ...(options.threadLink === undefined ? {} : { threadLink: options.threadLink }),
          now,
        }),
      turn: async (text, runner = coordinator()) => {
        eventIndex += 1;
        clock += 1_000;
        finalText = `Done: ${text}`;
        const ts = `1000.00000${eventIndex}`;
        const receipt = store.ingestSlackEvent({
          deliveryId: `delivery-${eventIndex}`,
          eventKey: `C1:${ts}`,
          workspaceId: "T1",
          conversationId: "C1",
          threadTs: "1000.000001",
          actorUserId: "U1",
          conversationType: "channel",
          profileId: "engineering",
          repositoryRoot: repo.root,
          text,
          receivedAt: now().toISOString(),
          sourceOrderKey: ts,
        });
        taskId = receipt.taskId;
        const outcome = await runner.processNext();
        if (outcome.kind !== "completed") throw new Error(`turn ended ${JSON.stringify(outcome)}`);
        return outcome.operationId;
      },
      drain: () => {
        const delivered: Array<{ clientMessageId: string; payload: SlackOutboxPayload }> = [];
        for (;;) {
          const message = store.claimNextOutbox({ workerId: "slack-a", now: now().toISOString(), leaseMs: 10_000 });
          if (message === null) return delivered;
          delivered.push({ clientMessageId: message.clientMessageId, payload: message.payload });
          store.markOutboxDelivered({
            outboxId: message.outboxId,
            workerId: "slack-a",
            slackMessageTs: `2000.${String(delivered.length).padStart(6, "0")}`,
            now: now().toISOString(),
          });
        }
      },
      taskId: () => {
        if (taskId === undefined) throw new Error("no turn ran yet");
        return taskId;
      },
      remoteHead: (branch) => {
        const result = Bun.spawnSync(["git", "-C", remotePath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
      },
    };
    try {
      await body(harness);
    } finally {
      store.close();
    }
  });
}

function texts(messages: ReadonlyArray<{ readonly payload: SlackOutboxPayload }>): string[] {
  return messages.map((message) => message.payload.text);
}

describe("draft PR workflow", () => {
  test("a first job opens one draft PR with a card; a follow-up turn pushes and posts a line", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const operationId = await h.turn("<@UBOT> add a feature file");
      expect(h.turnTexts[0]).toContain("pushes it to a draft PR");
      expect(h.turnTexts[0]).toContain("Do not run `git push`");
      const reply = h.drain();
      expect(texts(reply).some((text) => text.includes("add a feature file"))).toBe(true);

      const taskId = h.taskId();
      const jobs = h.store.listPrSyncJobs(taskId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ operationId, status: "pending" });

      const worker = h.worker();
      const created = await worker.processNext();
      expect(created).toMatchObject({ kind: "created", number: 1 });
      expect(h.github.creates).toHaveLength(1);
      expect(h.github.creates[0]).toMatchObject({ head: h.repo.branch, base: "main", draft: true });
      expect(h.github.creates[0]?.body).toContain("add a feature file");
      const firstSha = h.remoteHead(h.repo.branch);
      expect(firstSha).toBe(h.store.getTaskPullRequest(taskId)?.lastPushedSha ?? "missing");
      const card = h.drain();
      expect(card).toHaveLength(1);
      expect(card[0]?.clientMessageId).toBe(`${operationId}:pr`);
      expect(card[0]?.payload.text).toContain("Draft PR opened");
      expect(JSON.stringify(card[0]?.payload.blocks)).toContain("agent-tag.pr.view");
      expect(h.store.getTaskPullRequest(taskId)).toMatchObject({ state: "open", number: 1, draft: true });
      expect(await worker.processNext()).toEqual({ kind: "idle" });

      await Bun.write(join(h.repo.worktree, "second.txt"), "second\n");
      const second = await h.turn("add a second file");
      h.drain();
      expect(await worker.processNext()).toMatchObject({ kind: "pushed", number: 1 });
      expect(h.github.creates).toHaveLength(1);
      expect(h.remoteHead(h.repo.branch)).not.toBe(firstSha);
      const line = h.drain();
      expect(line.map((message) => message.clientMessageId)).toEqual([`${second}:pr-push`]);
      expect(line[0]?.payload.text).toContain("Pushed 1 commit to");
      expect(await worker.processNext()).toEqual({ kind: "idle" });
    });
  });

  test("an empty diff records no job and posts no card", async () => {
    await withHarness(async (h) => {
      await h.turn("just answer a question");
      expect(h.store.listAuditRecords({ limit: 1_000 }).some((record) => record.action.startsWith("pr."))).toBe(false);
      expect(await h.worker().processNext()).toEqual({ kind: "idle" });
      expect(texts(h.drain()).some((text) => text.includes("PR"))).toBe(false);
    });
  });

  test("mode off, or no git option, never spawns git", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const recorded = recordingSpawn();
      const off = buildConfig(h.repo, h.config.dataDir, { mode: "off" });
      await h.turn("change things", h.coordinator({ config: off, runner: isolatedRunner(recorded.spawn) }));
      expect(recorded.calls).toHaveLength(0);
      expect(h.turnTexts[0]).not.toContain("draft PR");
      await h.turn("change more", h.coordinator({ noPullRequests: true }));
      expect(h.turnTexts[1]).not.toContain("draft PR");
      expect(h.store.listAuditRecords({ limit: 1_000 }).some((record) => record.action.startsWith("pr."))).toBe(false);
    });
  });

  test("a snapshot failure still posts the reply, then one context line", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const broken = createGitRunner({ gitBinary: "/nonexistent/agent-tag-git", parentEnv: { PATH: "/usr/bin:/bin" } });
      const operationId = await h.turn("change things", h.coordinator({ runner: broken }));
      const delivered = h.drain();
      const replyIndex = delivered.findIndex((message) => message.payload.text.includes("Done: change things"));
      const noticeIndex = delivered.findIndex((message) => message.clientMessageId === `${operationId}:pr-snapshot-failed`);
      expect(replyIndex).toBeGreaterThanOrEqual(0);
      expect(noticeIndex).toBeGreaterThan(replyIndex);
      expect(delivered[noticeIndex]?.payload.text).toContain("Couldn't prepare a PR");
      expect(await h.worker().processNext()).toEqual({ kind: "idle" });
    });
  });

  test("a credential in the diff blocks the push with one notice", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "config.txt"), `token=${canaryToken()}\n`);
      const operationId = await h.turn("add config");
      const delivered = h.drain();
      const notice = delivered.find((message) => message.clientMessageId === `${operationId}:pr-blocked`);
      expect(notice?.payload.text).toContain("looks like a credential");
      expect(notice?.payload.text).toContain("config.txt");
      expect(await h.worker().processNext()).toEqual({ kind: "idle" });
      expect(h.remoteHead(h.repo.branch)).toBeUndefined();
      expect(h.github.creates).toHaveLength(0);
    });
  });

  test("a lost create response replays into find-by-head: exactly one PR", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const operationId = await h.turn("add a feature file");
      h.drain();
      h.github.failCreate = { error: new GitHubApiError({ kind: "transient", message: "socket hang up" }), afterCreate: true };
      const worker = h.worker();
      const retry = await worker.processNext();
      expect(retry).toMatchObject({ kind: "retry-scheduled", code: "github.transient" });
      expect(h.drain()).toHaveLength(0);
      expect(await worker.processNext()).toEqual({ kind: "idle" });
      h.advance(31_000);
      expect(await worker.processNext()).toMatchObject({ kind: "created", number: 1 });
      expect(h.github.pulls.size).toBe(1);
      expect(h.github.creates).toHaveLength(1);
      expect(h.drain().map((message) => message.clientMessageId)).toEqual([`${operationId}:pr`]);
    });
  });

  test("a lost create response, then a merge and branch delete: the replay does not push again", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const operationId = await h.turn("add a feature file");
      h.drain();
      h.github.failCreate = { error: new GitHubApiError({ kind: "transient", message: "socket hang up" }), afterCreate: true };
      const worker = h.worker();
      expect(await worker.processNext()).toMatchObject({ kind: "retry-scheduled" });
      h.github.update(1, { state: "closed", merged: true });
      git(h.remotePath, "update-ref", "-d", `refs/heads/${h.repo.branch}`);
      h.advance(31_000);
      expect(await worker.processNext()).toMatchObject({ kind: "skipped", code: "pr.merged" });
      expect(h.remoteHead(h.repo.branch)).toBeUndefined();
      expect(h.github.creates).toHaveLength(1);
      expect(h.store.getTaskPullRequest(h.taskId())).toMatchObject({ number: 1, state: "merged" });
      expect(h.drain().map((message) => message.clientMessageId)).toEqual([`${operationId}:pr-closed`]);
    });
  });

  test("a branch switch in the worktree is called out on the card and on the follow-up line", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      git(h.repo.worktree, "add", "feature.txt");
      git(h.repo.worktree, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "--quiet", "-m", "add feature");
      git(h.repo.worktree, "checkout", "--quiet", "-b", "agent-side");
      await Bun.write(join(h.repo.worktree, "side.txt"), "side\n");
      await h.turn("add a feature file");
      h.drain();
      const worker = h.worker();
      expect(await worker.processNext()).toMatchObject({ kind: "created" });
      const card = h.drain();
      expect(JSON.stringify(card[0]?.payload)).toContain("switched branches in its worktree");
      expect(git(h.remotePath, "ls-tree", "--name-only", `refs/heads/${h.repo.branch}`)).not.toContain("side.txt");

      git(h.repo.worktree, "checkout", "--quiet", h.repo.branch);
      git(h.repo.worktree, "add", "side.txt");
      git(h.repo.worktree, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "--quiet", "-m", "add side");
      git(h.repo.worktree, "checkout", "--quiet", "-b", "agent-side-2");
      await h.turn("add side");
      h.drain();
      expect(await worker.processNext()).toMatchObject({ kind: "pushed" });
      expect(texts(h.drain())[0]).toContain("switched branches in its worktree");
    });
  });

  test("the PR body links the Slack thread permalink, falling back to channel/ts", async () => {
    for (const [threadLink, expected] of [
      [async () => "https://example.slack.com/archives/C1/p1000000001", "https://example.slack.com/archives/C1/p1000000001"],
      [async () => { throw new Error("slack down"); }, "C1/1000.000001"],
    ] as const) {
      await withHarness(async (h) => {
        await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
        await h.turn("add a feature file");
        expect(await h.worker({ threadLink }).processNext()).toMatchObject({ kind: "created" });
        expect(h.github.creates[0]?.body).toContain(expected);
      });
    }
  });

  test("a merged PR stops pushing with one notice; later jobs end quietly", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      await h.turn("add a feature file");
      const worker = h.worker();
      expect(await worker.processNext()).toMatchObject({ kind: "created" });
      h.drain();
      const pushed = h.remoteHead(h.repo.branch);
      h.github.update(1, { state: "closed", merged: true });

      await Bun.write(join(h.repo.worktree, "more.txt"), "more\n");
      const second = await h.turn("add more");
      h.drain();
      expect(await worker.processNext()).toMatchObject({ kind: "skipped", code: "pr.merged" });
      expect(h.remoteHead(h.repo.branch)).toBe(pushed);
      const notice = h.drain();
      expect(notice.map((message) => message.clientMessageId)).toEqual([`${second}:pr-closed`]);
      expect(notice[0]?.payload.text).toContain("is merged");

      await Bun.write(join(h.repo.worktree, "again.txt"), "again\n");
      await h.turn("add again");
      h.drain();
      expect(await worker.processNext()).toMatchObject({ kind: "skipped", code: "pr.merged" });
      expect(h.drain()).toHaveLength(0);
      expect(h.remoteHead(h.repo.branch)).toBe(pushed);
    });
  });

  test("someone else's push is never overwritten", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      await h.turn("add a feature file");
      const worker = h.worker();
      expect(await worker.processNext()).toMatchObject({ kind: "created" });
      h.drain();
      const pushed = h.remoteHead(h.repo.branch)!;
      const tree = git(h.remotePath, "rev-parse", `${pushed}^{tree}`);
      const theirs = git(h.remotePath, "commit-tree", tree, "-p", pushed, "-m", "someone else");
      git(h.remotePath, "update-ref", `refs/heads/${h.repo.branch}`, theirs);

      await Bun.write(join(h.repo.worktree, "more.txt"), "more\n");
      const second = await h.turn("add more");
      h.drain();
      const outcome = await worker.processNext();
      expect(outcome.kind).toBe("skipped");
      expect(h.remoteHead(h.repo.branch)).toBe(theirs);
      const notice = h.drain();
      expect(notice.map((message) => message.clientMessageId)).toEqual([`${second}:pr-rejected`]);
      expect(notice[0]?.payload.text).toContain("didn't overwrite");
      expect(h.store.listAuditRecords({ limit: 1_000 }).some((record) => record.action === "pr.push.rejected")).toBe(true);
    });
  });

  test("revoked authority skips the job without pushing or posting", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      await h.turn("add a feature file");
      h.drain();
      const revoked = buildConfig(h.repo, h.config.dataDir, { allowedUserIds: ["U2"] });
      expect(await h.worker({ config: revoked }).processNext()).toMatchObject({ kind: "skipped", code: "pr.authority" });
      expect(h.remoteHead(h.repo.branch)).toBeUndefined();
      expect(h.github.creates).toHaveLength(0);
      expect(h.drain()).toHaveLength(0);
      expect(h.store.listAuditRecords({ limit: 1_000 }).some((record) => record.action === "pr.skipped.authority")).toBe(true);
    });
  });

  test("a rejected credential fails the job with one operator notice and no retry", async () => {
    await withHarness(async (h) => {
      await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
      const operationId = await h.turn("add a feature file");
      h.drain();
      h.github.failCreate = { error: new GitHubApiError({ kind: "auth", message: "bad credentials", status: 401 }), afterCreate: false };
      const worker = h.worker();
      expect(await worker.processNext()).toMatchObject({ kind: "failed", code: "github.auth" });
      const notice = h.drain();
      expect(notice.map((message) => message.clientMessageId)).toEqual([`${operationId}:pr-failed`]);
      expect(notice[0]?.payload.text).toContain("github.auth");
      h.advance(3_600_000);
      expect(await worker.processNext()).toEqual({ kind: "idle" });
    });
  });

  test("over HTTP: one draft POST, a follow-up reuses the PR, a lost create response replays without a second PR", async () => {
    await withHarness(async (h) => {
      const server = serveGitHub(h.remotePath);
      try {
        const worker = h.worker({ github: server.client });
        await Bun.write(join(h.repo.worktree, "feature.txt"), "feature\n");
        const first = await h.turn("add a feature file");
        h.drain();
        server.loseNextCreateResponse();
        expect(await worker.processNext()).toMatchObject({ kind: "retry-scheduled", code: "github.transient" });
        h.advance(31_000);
        expect(await worker.processNext()).toMatchObject({ kind: "created", number: 1 });
        expect(server.posts).toHaveLength(1);
        expect(server.posts[0]).toMatchObject({ draft: true, head: h.repo.branch, base: "main", maintainer_can_modify: false });
        expect(server.pulls).toHaveLength(1);
        expect(server.authorizations.every((value) => value.includes("github_pat_"))).toBe(true);
        const card = h.drain();
        expect(card.map((message) => message.clientMessageId)).toEqual([`${first}:pr`]);
        expect(card[0]?.payload.text).toContain("https://github.example/octo/example/pull/1");

        await Bun.write(join(h.repo.worktree, "second.txt"), "second\n");
        const second = await h.turn("add a second file");
        h.drain();
        expect(await worker.processNext()).toMatchObject({ kind: "pushed", number: 1 });
        expect(server.posts).toHaveLength(1);
        expect(server.pulls[0]?.commits).toBe(2);
        expect(h.drain().map((message) => message.clientMessageId)).toEqual([`${second}:pr-push`]);
      } finally {
        server.stop();
      }
    });
  });

  test("request text drops Slack mentions for commit messages and titles", () => {
    expect(pullRequestRequestText("<@UBOT>  please <#C1|general> fix\nthe bug <!here>")).toBe("please fix the bug");
  });
});

