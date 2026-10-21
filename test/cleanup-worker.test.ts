import { Database } from "bun:sqlite";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CleanupPolicy, type CleanupT3, CleanupWorker, isTaskBranch, plannedCleanupAction } from "../src/cleanup-worker.ts";
import { createGitRunner } from "../src/git/runner.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";
import { runTasksCommand } from "../src/tasks-cli.ts";
import {
  type T3Command,
  type T3ThreadSnapshot,
  T3ThreadNotFoundError,
  type T3VcsStatus,
  type T3WorktreeBinding,
} from "../src/t3/gateway.ts";

setDefaultTimeout(30_000);

const startedAt = "2026-10-01T00:00:00.000Z";
const closedAt = "2026-10-02T00:00:00.000Z";
const policy: CleanupPolicy = { dirtyWorktreeRetentionDays: 14, deleteEmptyBranches: true, maxCleanupsPerSweep: 5, sweepIntervalSeconds: 60 };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-C", cwd, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, "branch", "--list", branch) !== "";
}

/** A T3 stand-in over real git: snapshots from `threads`, status and removal from the worktree itself. */
class FakeT3 implements CleanupT3 {
  readonly threads = new Map<string, { worktreePath: string | null; branch: string | null }>();
  readonly commands: T3Command[] = [];
  readonly removals: Array<{ path: string; force: boolean }> = [];
  readonly otherBindings: T3WorktreeBinding[] = [];
  pr: T3VcsStatus["pr"] = null;
  dispatchError: Error | null = null;
  removeError: Error | null = null;

  async fetchThread(threadId: string): Promise<T3ThreadSnapshot> {
    const thread = this.threads.get(threadId);
    if (thread === undefined) throw new T3ThreadNotFoundError(threadId);
    // Cleanup reads only the worktree fields.
    return { snapshotSequence: 1, thread: { id: threadId, ...thread } } as unknown as T3ThreadSnapshot;
  }

  async dispatch(command: T3Command): Promise<unknown> {
    if (this.dispatchError !== null) throw this.dispatchError;
    this.commands.push(command);
    if (command.type === "thread.delete") this.threads.delete(command.threadId);
    return { sequence: this.commands.length };
  }

  async vcsStatus(cwd: string): Promise<T3VcsStatus> {
    return {
      isRepo: true,
      refName: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
      hasWorkingTreeChanges: git(cwd, "status", "--porcelain") !== "",
      aheadOfDefaultCount: Number(git(cwd, "rev-list", "--count", "main..HEAD")),
      pr: this.pr,
    };
  }

  async removeWorktree(input: { readonly cwd: string; readonly path: string; readonly force: boolean }): Promise<void> {
    if (this.removeError !== null) throw this.removeError;
    this.removals.push({ path: input.path, force: input.force });
    git(input.cwd, "worktree", "remove", ...(input.force ? ["--force"] : []), input.path);
  }

  async worktreeBindings(): Promise<readonly T3WorktreeBinding[]> {
    return [...[...this.threads].map(([threadId, thread]) => ({ threadId, worktreePath: thread.worktreePath })), ...this.otherBindings];
  }
}

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly store: AgentTagStore;
  readonly database: Database;
  readonly t3: FakeT3;
  clock: Date;
  worker(overrides?: Partial<CleanupPolicy>): CleanupWorker;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "agent-tag-cleanup-")));
  const repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "initial");
  const path = join(root, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const database = new Database(path, { strict: true });
  const t3 = new FakeT3();
  const fixture: Fixture = {
    root,
    repo,
    store,
    database,
    t3,
    clock: new Date(closedAt),
    worker: (overrides = {}) =>
      new CleanupWorker({
        store,
        t3,
        git: createGitRunner(),
        policy: { ...policy, ...overrides },
        dataDir: join(root, "data"),
        home: join(root, "home"),
        now: () => fixture.clock,
        owner: "cleanup-test",
      }),
  };
  try {
    await run(fixture);
  } finally {
    database.close();
    store.close();
    if (!root.startsWith(realpathSync(tmpdir())) || !root.includes("/agent-tag-cleanup-")) {
      throw new Error(`refusing to remove unexpected fixture path ${root}`);
    }
    await rm(root, { recursive: true });
  }
}

function slackEvent(repo: string, n: number): SlackEventInput {
  return {
    deliveryId: `delivery-${n}`,
    eventKey: `C1:${n}.0001`,
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: `${n}.0001`,
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: repo,
    text: "Investigate",
    receivedAt: startedAt,
    sourceOrderKey: `${n}.0001`,
  };
}

let threadCounter = 0;

/**
 * A task whose generation-1 T3 thread made a worktree, then closed with its session stopped: the
 * state the cleanup worker starts from.
 */
function retiredTask(
  fixture: Fixture,
  options: { readonly worktree?: boolean; readonly snapshotBranch?: string; readonly stopped?: boolean } = {},
): { taskId: string; threadId: string; branch: string; worktree: string } {
  threadCounter += 1;
  const receipt = fixture.store.ingestSlackEvent(slackEvent(fixture.repo, threadCounter));
  const taskId = receipt.taskId;
  const { threadId } = fixture.store.getTaskExecution(taskId);
  const claimed = fixture.store.claimNextOperation({ workerId: "w", now: startedAt, leaseMs: 10_000, maxConcurrentTasks: 10 });
  if (claimed?.taskId !== taskId) throw new Error("operation was not claimable");
  fixture.store.markOperationTurnDispatched({ operationId: claimed.operationId, workerId: "w", now: startedAt });
  fixture.store.markOperationTurnStarted({ operationId: claimed.operationId, workerId: "w", turnId: null, now: startedAt });
  fixture.store.markT3ThreadStarted({ taskId, threadId, now: startedAt });
  fixture.store.completeOperationWithOutbox({
    operationId: claimed.operationId,
    taskId,
    workerId: "w",
    resultSequence: 1,
    conversationId: "C1",
    threadTs: `${threadCounter}.0001`,
    text: "done",
    now: startedAt,
  });
  for (let row = fixture.store.claimNextOutbox({ workerId: "o", now: startedAt, leaseMs: 10_000 }); row !== null;
    row = fixture.store.claimNextOutbox({ workerId: "o", now: startedAt, leaseMs: 10_000 })) {
    fixture.store.markOutboxDelivered({ outboxId: row.outboxId, workerId: "o", slackMessageTs: "1.9999", now: startedAt });
  }
  const branch = `agent-tag/${taskId}`;
  const worktree = join(fixture.root, `wt-${threadCounter}`);
  if (options.worktree ?? true) {
    git(fixture.repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
    fixture.t3.threads.set(threadId, { worktreePath: worktree, branch: options.snapshotBranch ?? branch });
  } else {
    fixture.t3.threads.set(threadId, { worktreePath: null, branch: null });
  }
  expect(fixture.store.closeTask({ taskId, reason: "admin", actorId: "test", now: closedAt })).toMatchObject({ kind: "closed" });
  if (options.stopped ?? true) fixture.store.recordSessionStop({ taskId, generation: 1, outcome: "stopped", now: closedAt });
  return { taskId, threadId, branch, worktree };
}

function retiredRow(database: Database, taskId: string): Record<string, unknown> {
  const row = database.query<Record<string, unknown>, [string]>("SELECT * FROM task_retired_t3_threads WHERE task_id = ?").get(taskId);
  if (row === null) throw new Error("no retired row");
  return row;
}

function auditResults(store: AgentTagStore, taskId: string): string[] {
  return store
    .listAuditRecords({ limit: 1_000 })
    .filter((record) => record.target === taskId && (record.action.startsWith("task.worktree") || record.action.startsWith("task.branch") ||
      record.action.startsWith("task.cleanup") || record.action === "task.thread.deleted"))
    .map((record) => `${record.action}:${record.result}`);
}

function notices(database: Database, taskId: string): string[] {
  return database
    .query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM slack_outbox WHERE task_id = ? AND client_message_id LIKE '%:worktree-retained'",
    )
    .all(taskId)
    .map((row) => (JSON.parse(row.payload_json) as { text: string }).text);
}

describe("CleanupWorker", () => {
  test("a clean worktree: deletes the thread, removes the worktree and the empty branch", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      const result = await fixture.worker().runPass({ limit: null });
      expect(result).toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
      expect(fixture.t3.commands).toEqual([{ type: "thread.delete", commandId: `${task.taskId}:g1:thread.delete`, threadId: task.threadId }]);
      expect(fixture.t3.removals).toEqual([{ path: task.worktree, force: false }]);
      expect(existsSync(task.worktree)).toBe(false);
      expect(branchExists(fixture.repo, task.branch)).toBe(false);
      expect(existsSync(fixture.repo)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        worktree_path: task.worktree,
        worktree_state: "removed",
        branch_state: "deleted",
        head_commit_count: 0,
        completed_at: closedAt,
        lease_owner: null,
        last_error_code: null,
      });
      expect(auditResults(fixture.store, task.taskId).sort()).toEqual([
        "task.branch.deleted:deleted",
        "task.cleanup.completed:completed",
        "task.thread.deleted:deleted",
        "task.worktree.removed:removed",
      ]);
      expect(notices(fixture.database, task.taskId)).toEqual([]);
      // Nothing left to do.
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });
    });
  });

  test("waits for the session stop before touching a retired thread", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { stopped: false });
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });
      expect(existsSync(task.worktree)).toBe(true);
      expect(fixture.t3.commands).toEqual([]);
    });
  });

  test("a dirty worktree is kept with one notice, then force-removed once the retention passes", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "scratch.txt"), "uncommitted\n");
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
      const retainUntil = "2026-10-16T00:00:00.000Z";
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        worktree_state: "retained-dirty",
        retain_until: retainUntil,
        next_attempt_at: retainUntil,
        branch_state: "unknown",
        completed_at: null,
        lease_owner: null,
      });
      expect(existsSync(join(task.worktree, "scratch.txt"))).toBe(true);
      expect(notices(fixture.database, task.taskId)).toEqual([
        ":file_folder: Uncommitted changes from this session are kept in a local worktree until 2026-10-16. Reply here to pick them back up.",
      ]);
      expect(fixture.store.lifecycleCounts()).toMatchObject({ retainedDirty: 1, oldestRetainUntil: retainUntil, pendingCleanup: 0 });

      // Not due yet.
      fixture.clock = new Date("2026-10-15T23:59:59.000Z");
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });

      fixture.clock = new Date(retainUntil);
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 1, completed: 1 });
      expect(fixture.t3.removals).toEqual([{ path: task.worktree, force: true }]);
      expect(existsSync(task.worktree)).toBe(false);
      expect(branchExists(fixture.repo, task.branch)).toBe(false);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "removed", branch_state: "deleted", retain_until: null });
      expect(notices(fixture.database, task.taskId)).toHaveLength(1);
      const removed = fixture.store.listAuditRecords({ limit: 1_000 })
        .find((record) => record.target === task.taskId && record.action === "task.worktree.removed");
      expect(removed?.metadata).toMatchObject({ forced: true });
      // The thread was deleted once, on the first pass.
      expect(fixture.t3.commands.filter((command) => command.type === "thread.delete")).toHaveLength(1);
    });
  });

  test("dirtyWorktreeRetentionDays null keeps a dirty worktree for good", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "scratch.txt"), "uncommitted\n");
      expect(await fixture.worker({ dirtyWorktreeRetentionDays: null }).runPass({ limit: null })).toMatchObject({ completed: 1 });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "retained-dirty", retain_until: null, completed_at: closedAt });
      expect(existsSync(task.worktree)).toBe(true);
      expect(notices(fixture.database, task.taskId)).toEqual([
        ":file_folder: Uncommitted changes from this session are kept in a local worktree. Reply here to pick them back up.",
      ]);
      expect(fixture.store.lifecycleCounts()).toMatchObject({ retainedDirty: 1, oldestRetainUntil: null, pendingCleanup: 0 });
    });
  });

  test("a dirty worktree found after its retention ran out still gets a day's notice", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "scratch.txt"), "uncommitted\n");
      fixture.clock = new Date("2026-11-01T00:00:00.000Z");
      await fixture.worker().runPass({ limit: null });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "retained-dirty", retain_until: "2026-11-02T00:00:00.000Z" });
      expect(existsSync(task.worktree)).toBe(true);
    });
  });

  test("no notice when the task has reopened since, or its thread is muted", async () => {
    await withFixture(async (fixture) => {
      const reopened = retiredTask(fixture);
      const reopenedEvent = slackEvent(fixture.repo, threadCounter);
      await writeFile(join(reopened.worktree, "scratch.txt"), "uncommitted\n");
      const muted = retiredTask(fixture);
      await writeFile(join(muted.worktree, "scratch.txt"), "uncommitted\n");
      fixture.database
        .query(
          `INSERT INTO slack_thread_controls (workspace_id, conversation_id, thread_ts, muted_at, muted_by, mute_source, updated_at)
           VALUES ('T1', 'C1', ?, ?, 'U1', 'command', ?)`,
        )
        .run(`${threadCounter}.0001`, closedAt, closedAt);
      fixture.store.ingestSlackEvent({ ...reopenedEvent, deliveryId: "reopen", eventKey: "C1:reopen", sourceOrderKey: `${reopenedEvent.threadTs.split(".")[0]}.0002` });
      await fixture.worker().runPass({ limit: null });
      for (const task of [reopened, muted]) {
        expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "retained-dirty" });
        expect(notices(fixture.database, task.taskId)).toEqual([]);
      }
    });
  });

  test("a branch with commits is kept; the clean worktree still goes", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "work.txt"), "work\n");
      git(task.worktree, "add", "work.txt");
      git(task.worktree, "commit", "-q", "-m", "work");
      await fixture.worker().runPass({ limit: null });
      expect(existsSync(task.worktree)).toBe(false);
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "removed", branch_state: "kept-commits", head_commit_count: 1 });
    });
  });

  test("a branch with an open PR is kept, and one recorded at retirement that T3 cannot see", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.pr = { state: "open", url: "https://github.com/acme/repo/pull/7" };
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ branch_state: "kept-pr", pr_url: "https://github.com/acme/repo/pull/7" });

      const recorded = retiredTask(fixture);
      fixture.t3.pr = null;
      fixture.database.query("UPDATE task_retired_t3_threads SET pr_url = 'https://github.com/acme/repo/pull/8' WHERE task_id = ?").run(recorded.taskId);
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, recorded.branch)).toBe(true);
      expect(retiredRow(fixture.database, recorded.taskId)).toMatchObject({ branch_state: "kept-pr" });
    });
  });

  test("a merged PR with no commits ahead lets the branch go", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.pr = { state: "merged", url: "https://github.com/acme/repo/pull/9" };
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, task.branch)).toBe(false);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ branch_state: "deleted" });
    });
  });

  test("a merged PR does not cover later commits, even when the branch's upstream has them", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "later.txt"), "later\n");
      git(task.worktree, "add", "later.txt");
      git(task.worktree, "commit", "-q", "-m", "after the merge");
      // Pushed: `git branch -d` would accept the branch because its upstream contains the commit.
      git(fixture.repo, "remote", "add", "origin", fixture.repo);
      git(fixture.repo, "update-ref", `refs/remotes/origin/${task.branch}`, task.branch);
      git(fixture.repo, "config", `branch.${task.branch}.remote`, "origin");
      git(fixture.repo, "config", `branch.${task.branch}.merge`, `refs/heads/${task.branch}`);
      fixture.t3.pr = { state: "merged", url: "https://github.com/acme/repo/pull/9" };
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ branch_state: "kept-commits", head_commit_count: 1 });
    });
  });

  test("a snapshot branch that is not this task's fails the row and removes nothing", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { snapshotBranch: "feature/someone-else" });
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ completed: 1 });
      expect(existsSync(task.worktree)).toBe(true);
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(fixture.t3.commands).toEqual([]);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        worktree_state: "failed",
        branch_state: "failed",
        last_error_code: "branch-mismatch",
        cleanup_attempts: 1,
      });
      expect(auditResults(fixture.store, task.taskId)).toEqual(["task.cleanup.failed:refused"]);
      expect(fixture.store.lifecycleCounts()).toMatchObject({ cleanupFailures: 1 });
    });
  });

  test("never removes the repository itself, even when T3 reports it as the worktree", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { worktree: false });
      git(fixture.repo, "branch", task.branch);
      git(fixture.repo, "checkout", "-q", task.branch);
      fixture.t3.threads.set(task.threadId, { worktreePath: fixture.repo, branch: task.branch });
      await fixture.worker().runPass({ limit: null });
      expect(existsSync(join(fixture.repo, "README.md"))).toBe(true);
      expect(fixture.t3.removals).toEqual([]);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "failed", last_error_code: "worktree-path-protected" });
    });
  });

  test("never removes a worktree another T3 thread is bound to", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.otherBindings.push({ threadId: "thread-other", worktreePath: task.worktree });
      await fixture.worker().runPass({ limit: null });
      expect(existsSync(task.worktree)).toBe(true);
      expect(fixture.t3.removals).toEqual([]);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "failed", last_error_code: "worktree-bound" });
    });
  });

  test("never removes a directory git does not list as the branch's worktree", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { worktree: false });
      const stray = join(fixture.root, "stray");
      git(fixture.root, "init", "-q", stray);
      fixture.t3.threads.set(task.threadId, { worktreePath: stray, branch: task.branch });
      await fixture.worker().runPass({ limit: null });
      expect(existsSync(stray)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "failed", last_error_code: "worktree-unregistered" });
    });
  });

  test("a thread T3 no longer has counts as deleted; git still finds its worktree", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.threads.delete(task.threadId);
      await fixture.worker().runPass({ limit: null });
      expect(fixture.t3.commands).toEqual([]);
      expect(existsSync(task.worktree)).toBe(false);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        thread_deleted_at: closedAt,
        worktree_path: task.worktree,
        worktree_state: "removed",
        branch_state: "deleted",
      });
    });
  });

  test("a worktree T3 already removed counts as removed; its branch, with no known commit count, is kept", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      git(fixture.repo, "worktree", "remove", task.worktree);
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "removed", branch_state: "kept-commits", head_commit_count: null });
      expect(fixture.t3.removals).toEqual([]);
    });
  });

  test("a thread without a worktree: the thread goes, the never-created branch counts as deleted", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { worktree: false });
      await fixture.worker().runPass({ limit: null });
      expect(fixture.t3.commands.map((command) => command.type)).toEqual(["thread.delete"]);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "none", branch_state: "deleted", completed_at: closedAt });
    });
  });

  test("an unknown thread rejected by T3 counts as deleted", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.threads.set(task.threadId, { worktreePath: task.worktree, branch: task.branch });
      const original = fixture.t3.dispatch.bind(fixture.t3);
      fixture.t3.dispatch = async (command) => {
        if (command.type === "thread.delete") {
          throw { _tag: "OrchestrationDispatchCommandError", message: `Thread '${task.threadId}' does not exist` };
        }
        return original(command);
      };
      await fixture.worker().runPass({ limit: null });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "removed", completed_at: closedAt });
    });
  });

  test("a transient error backs off, resumes without re-dispatching, and fails for good after 10 attempts", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.removeError = new Error("socket closed");
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ deferred: 1 });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        cleanup_attempts: 1,
        last_error_code: "Error",
        next_attempt_at: "2026-10-02T00:00:30.000Z",
        lease_owner: null,
        thread_deleted_at: closedAt,
        completed_at: null,
      });
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });
      fixture.clock = new Date("2026-10-02T00:00:30.000Z");
      await fixture.worker().runPass({ limit: null });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ cleanup_attempts: 2, next_attempt_at: "2026-10-02T00:01:30.000Z" });
      for (let attempt = 3; attempt <= 10; attempt += 1) {
        fixture.clock = new Date(Date.parse(String(retiredRow(fixture.database, task.taskId).next_attempt_at)));
        await fixture.worker().runPass({ limit: null });
      }
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        cleanup_attempts: 10,
        worktree_state: "failed",
        branch_state: "failed",
        completed_at: expect.any(String),
      });
      expect(existsSync(task.worktree)).toBe(true);
      // The delete went out once; later passes resumed after it.
      expect(fixture.t3.commands.filter((command) => command.type === "thread.delete")).toHaveLength(1);
      expect(auditResults(fixture.store, task.taskId).at(-1)).toBe("task.cleanup.failed:exhausted");
    });
  });

  test("the backoff caps at an hour", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      fixture.t3.removeError = new Error("socket closed");
      fixture.database.query("UPDATE task_retired_t3_threads SET cleanup_attempts = 8 WHERE task_id = ?").run(task.taskId);
      await fixture.worker().runPass({ limit: null });
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ cleanup_attempts: 9, next_attempt_at: "2026-10-02T01:00:00.000Z" });
    });
  });

  test("a branch git refuses to delete fails the row, with no retry using -D", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture, { worktree: false });
      // Checked out in the main worktree: `git branch -d` refuses.
      git(fixture.repo, "checkout", "-q", "-b", task.branch);
      fixture.database.query("UPDATE task_retired_t3_threads SET head_commit_count = 0 WHERE task_id = ?").run(task.taskId);
      await fixture.worker().runPass({ limit: null });
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({
        worktree_state: "none",
        branch_state: "failed",
        last_error_code: "branch-delete-failed",
        completed_at: closedAt,
      });
    });
  });

  test("deleteEmptyBranches false leaves the branch", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await fixture.worker({ deleteEmptyBranches: false }).runPass({ limit: null });
      expect(existsSync(task.worktree)).toBe(false);
      expect(branchExists(fixture.repo, task.branch)).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "removed", branch_state: "unknown", completed_at: closedAt });
    });
  });

  test("processNext is throttled and takes at most maxCleanupsPerSweep rows", async () => {
    await withFixture(async (fixture) => {
      for (let n = 0; n < 3; n += 1) retiredTask(fixture, { worktree: false });
      const worker = fixture.worker({ maxCleanupsPerSweep: 2 });
      expect(await worker.processNext()).toEqual({ kind: "threads-cleaned", count: 2 });
      expect(await worker.processNext()).toEqual({ kind: "idle" });
      fixture.clock = new Date(fixture.clock.getTime() + 60_000);
      expect(await worker.processNext()).toEqual({ kind: "threads-cleaned", count: 1 });
    });
  });

  test("a row leased by another worker is skipped", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      expect(fixture.store.claimNextRetiredThread({ owner: "other", now: closedAt, leaseMs: 60_000 })?.taskId).toBe(task.taskId);
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });
      fixture.clock = new Date(Date.parse(closedAt) + 60_000);
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 1, completed: 1 });
    });
  });

  test("a reopen cannot adopt a retained worktree while cleanup holds its lease", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      await writeFile(join(task.worktree, "scratch.txt"), "uncommitted\n");
      await fixture.worker().runPass({ limit: null });
      const due = "2026-10-16T00:00:00.000Z";
      expect(fixture.store.claimNextRetiredThread({ owner: "other", now: due, leaseMs: 60_000 })?.taskId).toBe(task.taskId);
      expect(fixture.store.adoptRetiredWorktree({ taskId: task.taskId, generation: 1, now: due })).toBe(false);
      const later = "2026-10-16T00:01:00.000Z";
      expect(fixture.store.adoptRetiredWorktree({ taskId: task.taskId, generation: 1, now: later })).toBe(true);
      expect(fixture.store.adoptRetiredWorktree({ taskId: task.taskId, generation: 1, now: later })).toBe(true);
      expect(retiredRow(fixture.database, task.taskId)).toMatchObject({ worktree_state: "adopted", branch_state: "adopted", completed_at: later });
      // Adopted rows are done: cleanup never takes them again.
      fixture.clock = new Date(later);
      expect(await fixture.worker().runPass({ limit: null })).toMatchObject({ claimed: 0 });
      expect(existsSync(task.worktree)).toBe(true);
    });
  });
});

describe("cleanup helpers", () => {
  test("isTaskBranch accepts only this task's generation branches", () => {
    const taskId = "0b5f4c1e-8f53-4d6b-9a43-5f7c9d0e2a11";
    expect(isTaskBranch(taskId, `agent-tag/${taskId}`)).toBe(true);
    expect(isTaskBranch(taskId, `agent-tag/${taskId}-g12`)).toBe(true);
    expect(isTaskBranch(taskId, `agent-tag/${taskId}-g0`)).toBe(false);
    expect(isTaskBranch(taskId, `agent-tag/${taskId}x`)).toBe(false);
    expect(isTaskBranch(taskId, "main")).toBe(false);
    expect(isTaskBranch("../../etc", "agent-tag/../../etc")).toBe(false);
  });

  test("getResumeCandidate skips a session a !restart retired", async () => {
    await withFixture(async (fixture) => {
      const task = retiredTask(fixture);
      expect(fixture.store.getResumeCandidate(task.taskId, 2)).toMatchObject({ generation: 1, branch: task.branch, worktreeState: "unknown" });
      fixture.database.query("UPDATE task_retired_t3_threads SET reason = 'restart' WHERE task_id = ?").run(task.taskId);
      expect(fixture.store.getResumeCandidate(task.taskId, 2)).toBeNull();
      expect(fixture.store.getResumeCandidate(task.taskId, 1)).toBeNull();
    });
  });

  test("the dry run describes each pending row without changing anything", async () => {
    await withFixture(async (fixture) => {
      const waiting = retiredTask(fixture, { stopped: false });
      const ready = retiredTask(fixture);
      const now = new Date(closedAt);
      const plans = Object.fromEntries(fixture.store.listPendingRetiredThreads().map((row) => [row.taskId, plannedCleanupAction(row, policy, now)]));
      expect(plans).toEqual({
        [waiting.taskId]: "wait for the session stop",
        [ready.taskId]: `delete T3 thread ${ready.threadId}; remove its worktree if clean (keep if dirty); delete branch ${ready.branch} if it has no commits or PR`,
      });
      expect(existsSync(ready.worktree)).toBe(true);
      expect(fixture.store.lifecycleCounts()).toMatchObject({ closedTasks: 2, pendingCleanup: 2 });
    });
  });
});

describe("agent-tag tasks cleanup", () => {
  async function writeConfig(fixture: Fixture): Promise<string> {
    const configPath = join(fixture.root, "agent-tag.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      dataDir: fixture.root,
      t3: { baseUrl: "http://127.0.0.1:1", tokenFile: join(fixture.root, "t3-token") },
      slack: { workspaceId: "T1", appTokenFile: join(fixture.root, "app"), botTokenFile: join(fixture.root, "bot") },
      access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
      profiles: [{
        id: "engineering",
        repositoryRoots: [fixture.repo],
        defaultProviderInstanceId: "codex",
        defaultModel: "gpt-5.6-sol",
        runtimeMode: "approval-required",
        isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
        externalWrites: { mode: "deny" },
        memory: { shared: true, privateDm: false, retentionDays: 30 },
      }],
      routes: [{ conversationId: "C1", profileId: "engineering" }],
      limits: { maxConcurrentTasks: 2 },
      lifecycle: { maxCleanupsPerSweep: 1 },
    }));
    return configPath;
  }

  const tasks = async (fixture: Fixture, argv: readonly string[]) => {
    const lines: string[] = [];
    let closed = false;
    const exitCode = await runTasksCommand(argv, {
      write: (line) => lines.push(line),
      now: () => fixture.clock,
      t3: () => Object.assign(fixture.t3, { close: async () => { closed = true; } }),
    });
    return { exitCode, lines, closed };
  };

  test("--dry-run lists the plan and changes nothing", async () => {
    await withFixture(async (fixture) => {
      const configPath = await writeConfig(fixture);
      expect((await tasks(fixture, ["cleanup", configPath, "--dry-run"])).lines).toEqual(["no retired threads pending cleanup"]);
      const task = retiredTask(fixture);
      const result = await tasks(fixture, ["cleanup", configPath, "--dry-run"]);
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual([
        `${task.taskId} g1 (admin): delete T3 thread ${task.threadId}; remove its worktree if clean (keep if dirty); delete branch ${task.branch} if it has no commits or PR`,
      ]);
      expect(fixture.t3.commands).toEqual([]);
      expect(existsSync(task.worktree)).toBe(true);
    });
  });

  test("--once stops due sessions, then cleans every due row past the sweep limit", async () => {
    await withFixture(async (fixture) => {
      const configPath = await writeConfig(fixture);
      const unstopped = retiredTask(fixture, { stopped: false });
      const dirty = retiredTask(fixture);
      await writeFile(join(dirty.worktree, "scratch.txt"), "uncommitted\n");
      const result = await tasks(fixture, ["cleanup", configPath, "--once"]);
      expect(result.exitCode).toBe(0);
      expect(result.closed).toBe(true);
      expect(fixture.t3.commands.map((command) => command.type)).toContain("thread.session.stop");
      expect(result.lines.sort()).toEqual([
        "cleanup: 1 done, 1 waiting, 0 skipped",
        `${dirty.taskId} g1 (admin): worktree retained-dirty, branch unknown, kept until 2026-10-16T00:00:00.000Z`,
        `${unstopped.taskId} g1 (admin): worktree removed, branch deleted, done`,
      ].sort());
      expect(existsSync(unstopped.worktree)).toBe(false);
      expect(existsSync(dirty.worktree)).toBe(true);
    });
  });

  test("--once exits 1 when a row fails", async () => {
    await withFixture(async (fixture) => {
      const configPath = await writeConfig(fixture);
      const task = retiredTask(fixture, { snapshotBranch: "main" });
      const result = await tasks(fixture, ["cleanup", configPath, "--once"]);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toBe(`${task.taskId} g1 (admin): worktree failed, branch failed, done (branch-mismatch)`);
    });
  });

  test("needs exactly one of --dry-run and --once", async () => {
    await withFixture(async (fixture) => {
      const configPath = await writeConfig(fixture);
      await expect(tasks(fixture, ["cleanup", configPath])).rejects.toThrow("usage:");
      await expect(tasks(fixture, ["cleanup", configPath, "--dry-run", "--once"])).rejects.toThrow("usage:");
    });
  });
});
