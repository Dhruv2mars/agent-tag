import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordPrSync, type PrSyncInput } from "../src/store/pull-requests.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";

const T0 = "2026-09-21T00:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1_000).toISOString();
const sha = "a".repeat(40);
const readySync: PrSyncInput = {
  kind: "ready",
  repo: "o/r",
  baseBranch: "main",
  branch: "agent-tag/task",
  sha,
  mirrorRef: "refs/agent-tag/mirror/task",
  aheadCount: 2,
  requestText: "Fix the flaky test",
  summaryText: "Fixed it.",
};
const pullRequestUrl = "https://github.com/o/r/pull/7";

function slackEvent(overrides: Partial<SlackEventInput> = {}): SlackEventInput {
  return {
    deliveryId: "delivery-1",
    eventKey: "C1:1000.0001",
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.0001",
    actorUserId: "U1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text: "Open a PR for this",
    receivedAt: T0,
    sourceOrderKey: "1000.0001",
    ...overrides,
  };
}

interface Fixture {
  readonly store: AgentTagStore;
  /** A second connection to the same file for raw SQL checks and direct calls. */
  readonly database: Database;
}

async function withStore(run: (fixture: Fixture) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-pr-store-"));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  const database = new Database(path, { strict: true });
  try {
    await run({ store, database });
  } finally {
    database.close();
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-pr-store-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

/** Ingests one Slack message in `threadTs` (message ts `<root>.<index padded>`) and returns its receipt. */
function ingest(store: AgentTagStore, index: number, threadTs: string) {
  const messageTs = `${threadTs.split(".")[0]}.${String(index).padStart(4, "0")}`;
  return store.ingestSlackEvent(
    slackEvent({
      deliveryId: `delivery-${index}-${threadTs}`,
      eventKey: `C1:${messageTs}`,
      threadTs,
      sourceOrderKey: messageTs,
    }),
  );
}

/** Ingests a message, claims its operation and returns the ids a completion needs. */
function startTurn(store: AgentTagStore, index: number, threadTs: string, now: string) {
  const receipt = ingest(store, index, threadTs);
  const claimed = store.claimNextOperation({ workerId: "worker-a", now, leaseMs: 60_000, maxConcurrentTasks: 4 });
  if (claimed === null || claimed.operationId !== receipt.operationId) throw new Error("operation was not claimed");
  return { operationId: receipt.operationId, taskId: receipt.taskId, threadTs };
}

function completeTurn(
  store: AgentTagStore,
  turn: { readonly operationId: string; readonly taskId: string; readonly threadTs: string },
  prSync: PrSyncInput | undefined,
  now: string,
): string {
  return store.completeOperationWithOutbox({
    operationId: turn.operationId,
    taskId: turn.taskId,
    workerId: "worker-a",
    resultSequence: 1,
    conversationId: "C1",
    threadTs: turn.threadTs,
    text: "Done.",
    ...(prSync === undefined ? {} : { prSync, actorUserId: "U1" }),
    now,
  });
}

function outboxRows(database: Database, taskId: string): { clientMessageId: string; text: string; createdAt: string }[] {
  return database
    .query("SELECT client_message_id, payload_json, created_at FROM slack_outbox WHERE task_id = ? ORDER BY created_at, client_message_id")
    .all(taskId)
    .map((row) => {
      const record = row as { client_message_id: string; payload_json: string; created_at: string };
      return {
        clientMessageId: record.client_message_id,
        text: (JSON.parse(record.payload_json) as { text: string }).text,
        createdAt: record.created_at,
      };
    });
}

/** Inserts a bare job row for an operation, bypassing the store API, to exercise the table checks. */
function insertJobRow(
  database: Database,
  input: { readonly taskId: string; readonly operationId: string; readonly status: string; readonly leaseOwner?: string | null },
): void {
  database
    .query(
      `INSERT INTO pr_sync_jobs (
        job_id, task_id, operation_id, conversation_id, thread_ts, actor_user_id, github_repo, base_branch,
        status, lease_owner, lease_expires_at, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'C1', '1000.0001', 'U1', 'o/r', 'main', ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      input.taskId,
      input.operationId,
      input.status,
      input.leaseOwner ?? null,
      input.leaseOwner === null || input.leaseOwner === undefined ? null : at(60),
      T0,
      T0,
    );
}

describe("migration 18 table constraints", () => {
  test("task_pull_requests rejects an open PR without a number and a pending PR with one", async () => {
    await withStore(({ store, database }) => {
      const insertPr = (taskId: string, state: string, prNumber: number | null) =>
        database
          .query(
            `INSERT INTO task_pull_requests (
              task_id, github_repo, head_branch, base_branch, pr_number, pr_url, state, draft, last_pushed_sha,
              created_at, updated_at
            ) VALUES (?, 'o/r', 'agent-tag/task', 'main', ?, NULL, ?, 1, NULL, ?, ?)`,
          )
          .run(taskId, prNumber, state, T0, T0);

      const openWithoutNumber = ingest(store, 1, "1001.0001").taskId;
      expect(() => insertPr(openWithoutNumber, "open", null)).toThrow(/CHECK constraint failed/);

      const pendingWithNumber = ingest(store, 2, "1002.0001").taskId;
      expect(() => insertPr(pendingWithNumber, "pending", 7)).toThrow(/CHECK constraint failed/);

      const badNumber = ingest(store, 3, "1003.0001").taskId;
      expect(() => insertPr(badNumber, "open", 0)).toThrow(/CHECK constraint failed/);
      expect(() => insertPr(badNumber, "open", -1)).toThrow(/CHECK constraint failed/);

      const unknownState = ingest(store, 4, "1004.0001").taskId;
      expect(() => insertPr(unknownState, "draft", 7)).toThrow(/CHECK constraint failed/);

      // Positive controls: the valid shapes are accepted.
      const pending = ingest(store, 5, "1005.0001").taskId;
      expect(() => insertPr(pending, "pending", null)).not.toThrow();
      const open = ingest(store, 6, "1006.0001").taskId;
      expect(() => insertPr(open, "open", 7)).not.toThrow();
    });
  });

  test("pr_sync_jobs rejects an unknown status and an inflight job without a lease", async () => {
    await withStore(({ store, database }) => {
      const unknown = ingest(store, 1, "1001.0001");
      expect(() =>
        insertJobRow(database, { taskId: unknown.taskId, operationId: unknown.operationId, status: "bogus" }),
      ).toThrow(/CHECK constraint failed/);

      const noLease = ingest(store, 2, "1002.0001");
      expect(() =>
        insertJobRow(database, { taskId: noLease.taskId, operationId: noLease.operationId, status: "inflight" }),
      ).toThrow(/CHECK constraint failed/);

      // Positive control: a pending job and an inflight job that carries a lease are both accepted.
      const pending = ingest(store, 3, "1003.0001");
      expect(() =>
        insertJobRow(database, { taskId: pending.taskId, operationId: pending.operationId, status: "pending" }),
      ).not.toThrow();
      const leased = ingest(store, 4, "1004.0001");
      expect(() =>
        insertJobRow(database, {
          taskId: leased.taskId,
          operationId: leased.operationId,
          status: "inflight",
          leaseOwner: "worker-a",
        }),
      ).not.toThrow();
    });
  });

  test("pr_sync_jobs allows at most one job per operation", async () => {
    await withStore(({ store, database }) => {
      const receipt = ingest(store, 1, "1001.0001");
      insertJobRow(database, { taskId: receipt.taskId, operationId: receipt.operationId, status: "pending" });
      expect(() =>
        insertJobRow(database, { taskId: receipt.taskId, operationId: receipt.operationId, status: "pending" }),
      ).toThrow(/UNIQUE constraint failed/);
    });
  });
});

describe("recording a completed turn's PR sync", () => {
  test("a ready prSync queues exactly one pending job in the same transaction as the reply", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));

      const jobs = store.listPrSyncJobs(turn.taskId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        operationId: turn.operationId,
        status: "pending",
        resultCode: null,
        attempts: 0,
        sha,
        blockedUntil: null,
      });

      // The reply and the job were written together: the reply is there, and so is the audit record of the job.
      expect(outboxRows(database, turn.taskId).map((row) => row.clientMessageId)).toEqual([
        `${turn.operationId}:final`,
      ]);
      const audit = database
        .query("SELECT action, target FROM audit_log WHERE action = 'pr.sync.recorded'")
        .all() as { action: string; target: string }[];
      expect(audit).toEqual([{ action: "pr.sync.recorded", target: jobs[0]?.jobId ?? "" }]);
    });
  });

  test("a failed job insert rolls back the reply and leaves the operation in flight", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      // An empty repo makes recordPrSync throw inside the completion transaction.
      expect(() => completeTurn(store, turn, { ...readySync, repo: "" }, at(0))).toThrow();

      expect(store.listPrSyncJobs(turn.taskId)).toEqual([]);
      expect(outboxRows(database, turn.taskId)).toEqual([]);
      const status = database.query("SELECT status FROM operations WHERE operation_id = ?").get(turn.operationId);
      expect(status).toEqual({ status: "inflight" });

      // The turn can still be completed with a valid snapshot.
      completeTurn(store, turn, readySync, at(1));
      expect(store.listPrSyncJobs(turn.taskId)).toHaveLength(1);
    });
  });

  test("replaying the completion does not create a second job or a second reply", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const before = outboxRows(database, turn.taskId);

      // The operation is already succeeded, so the lease-guarded completion is rejected outright.
      expect(() => completeTurn(store, turn, readySync, at(1))).toThrow(
        "operation lease is missing, expired, or owned by another worker",
      );
      expect(store.listPrSyncJobs(turn.taskId)).toHaveLength(1);
      expect(outboxRows(database, turn.taskId)).toEqual(before);
    });
  });

  test("recordPrSync called twice for the same operation inserts one job", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const input = {
        operationId: turn.operationId,
        taskId: turn.taskId,
        workerId: "worker-a",
        conversationId: "C1",
        threadTs: turn.threadTs,
        actorUserId: "U1",
        prSync: readySync,
        now: at(1),
        noticeAt: at(2),
      };
      recordPrSync(database, input);
      recordPrSync(database, { ...input, prSync: { ...readySync, sha: "b".repeat(40) } });

      expect(store.listPrSyncJobs(turn.taskId)).toHaveLength(1);
      expect(store.listPrSyncJobs(turn.taskId)[0]?.sha).toBe(sha);
    });
  });

  test("a blocked prSync creates a terminal blocked job and queues one notice after the reply", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      const notice = "I didn't push: the diff contains something that looks like a credential.";
      completeTurn(
        store,
        turn,
        { kind: "blocked", repo: "o/r", baseBranch: "main", branch: "agent-tag/task", sha, reason: "secret", notice },
        at(0),
      );

      const jobs = store.listPrSyncJobs(turn.taskId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: "blocked", resultCode: "blocked.secret", sha });
      // Terminal: nothing is claimable for this task.
      expect(store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 })).toBeNull();

      const rows = outboxRows(database, turn.taskId);
      expect(rows.map((row) => row.clientMessageId)).toEqual([
        `${turn.operationId}:final`,
        `${turn.operationId}:pr-blocked`,
      ]);
      const notRow = rows[1];
      expect(notRow?.text).toBe(notice);
      expect(notRow && rows[0] && notRow.createdAt > rows[0].createdAt).toBe(true);
    });
  });

  test("a failed prSync creates no job and queues one context line", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      const notice = "Couldn't prepare a PR: snapshot_timeout";
      completeTurn(store, turn, { kind: "failed", code: "snapshot_timeout", notice }, at(0));

      expect(store.listPrSyncJobs(turn.taskId)).toEqual([]);
      const rows = outboxRows(database, turn.taskId);
      expect(rows.map((row) => row.clientMessageId)).toEqual([
        `${turn.operationId}:final`,
        `${turn.operationId}:pr-snapshot-failed`,
      ]);
      expect(rows[1]?.text).toBe(notice);
    });
  });

  test("a turn without a prSync records no job", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, undefined, at(0));
      expect(store.listPrSyncJobs(turn.taskId)).toEqual([]);
      expect(outboxRows(database, turn.taskId)).toHaveLength(1);
    });
  });
});

describe("claiming PR sync jobs", () => {
  test("one task runs one job at a time, oldest first, while other tasks run in parallel", async () => {
    await withStore(({ store }) => {
      const first = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, first, readySync, at(0));
      const second = startTurn(store, 2, "1000.0001", at(1));
      completeTurn(store, second, readySync, at(1));
      const other = startTurn(store, 3, "2000.0001", at(2));
      completeTurn(store, other, readySync, at(2));

      const [firstJob, secondJob] = store.listPrSyncJobs(first.taskId);
      const otherJob = store.listPrSyncJobs(other.taskId)[0];
      if (firstJob === undefined || secondJob === undefined || otherJob === undefined) throw new Error("jobs missing");

      const claimedFirst = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(3), leaseMs: 60_000 });
      expect(claimedFirst).toMatchObject({
        jobId: firstJob.jobId,
        taskId: first.taskId,
        githubRepo: "o/r",
        branch: "agent-tag/task",
        sha,
        aheadCount: 2,
        requestText: "Fix the flaky test",
        summaryText: "Fixed it.",
        attempts: 1,
      });

      // The second job for the same task waits behind the live in-flight one; the other task is free.
      const claimedOther = store.claimNextPrSyncJob({ workerId: "pr-b", now: at(3), leaseMs: 60_000 });
      expect(claimedOther?.jobId).toBe(otherJob.jobId);
      expect(store.claimNextPrSyncJob({ workerId: "pr-c", now: at(3), leaseMs: 60_000 })).toBeNull();

      // Once the first job settles, the second becomes claimable.
      store.settlePrSyncJob({
        jobId: firstJob.jobId,
        workerId: "pr-a",
        now: at(4),
        status: "succeeded",
        resultCode: null,
        audit: { action: "pr.created", result: "succeeded" },
      });
      expect(store.claimNextPrSyncJob({ workerId: "pr-c", now: at(5), leaseMs: 60_000 })?.jobId).toBe(secondJob.jobId);
    });
  });

  test("an in-flight job whose lease expired is reclaimed with a new attempt", async () => {
    await withStore(({ store }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 1_000 });
      expect(claimed?.attempts).toBe(1);

      expect(store.claimNextPrSyncJob({ workerId: "pr-b", now: at(1.5), leaseMs: 1_000 })).toBeNull();
      const reclaimed = store.claimNextPrSyncJob({ workerId: "pr-b", now: at(3), leaseMs: 1_000 });
      expect(reclaimed).toMatchObject({ jobId: claimed?.jobId, attempts: 2 });
    });
  });

  test("retryPrSyncJob keeps the job hidden until blockedUntil", async () => {
    await withStore(({ store }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 });
      if (claimed === null) throw new Error("job was not claimed");

      store.retryPrSyncJob({
        jobId: claimed.jobId,
        workerId: "pr-a",
        now: at(2),
        errorCode: "github_rate_limited",
        blockedUntil: at(60),
      });
      expect(store.listPrSyncJobs(turn.taskId)[0]).toMatchObject({
        status: "pending",
        resultCode: "github_rate_limited",
        blockedUntil: at(60),
        attempts: 1,
      });

      expect(store.claimNextPrSyncJob({ workerId: "pr-a", now: at(59), leaseMs: 60_000 })).toBeNull();
      expect(store.claimNextPrSyncJob({ workerId: "pr-a", now: at(60), leaseMs: 60_000 })).toMatchObject({
        jobId: claimed.jobId,
        attempts: 2,
      });
    });
  });

  test("releasePrSyncJob returns the job to pending without counting the attempt", async () => {
    await withStore(({ store }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 });
      if (claimed === null) throw new Error("job was not claimed");

      store.releasePrSyncJob({ jobId: claimed.jobId, workerId: "pr-a", now: at(2) });
      expect(store.listPrSyncJobs(turn.taskId)[0]).toMatchObject({ status: "pending", attempts: 0 });

      expect(store.claimNextPrSyncJob({ workerId: "pr-b", now: at(3), leaseMs: 60_000 })).toMatchObject({
        jobId: claimed.jobId,
        attempts: 1,
      });
    });
  });

  test("settlePrSyncJob queues one outbox row, and a second settle is rejected by the lease check", async () => {
    await withStore(({ store, database }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 });
      if (claimed === null) throw new Error("job was not claimed");

      const settle = () =>
        store.settlePrSyncJob({
          jobId: claimed.jobId,
          workerId: "pr-a",
          now: at(2),
          status: "skipped",
          resultCode: "no_changes",
          message: {
            suffix: "pr-result",
            payload: { text: "Nothing new to push." },
          },
          audit: { action: "pr.skipped.authority", result: "skipped" },
        });

      const outboxId = settle();
      expect(outboxId).toEqual(expect.any(String));
      expect(() => settle()).toThrow("pull request job lease is missing, expired, or owned by another worker");

      expect(store.listPrSyncJobs(turn.taskId)[0]).toMatchObject({ status: "skipped", resultCode: "no_changes" });
      const messages = outboxRows(database, turn.taskId).filter((row) => row.clientMessageId.endsWith(":pr-result"));
      expect(messages).toHaveLength(1);
    });
  });

  test("recordPrSyncPushed refuses a caller that does not hold the job's lease", async () => {
    await withStore(({ store }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 });
      if (claimed === null) throw new Error("job was not claimed");

      expect(() =>
        store.recordPrSyncPushed({
          jobId: claimed.jobId,
          workerId: "pr-intruder",
          operationId: turn.operationId,
          taskId: turn.taskId,
          repo: "o/r",
          headBranch: "agent-tag/task",
          baseBranch: "main",
          sha,
          pushStatus: "pushed",
          now: at(2),
        }),
      ).toThrow("pull request job lease is missing, expired, or owned by another worker");
      expect(store.getTaskPullRequest(turn.taskId)).toBeNull();
    });
  });

  test("a pushed record followed by a succeeded settle with a pull request updates the task PR", async () => {
    await withStore(({ store }) => {
      const turn = startTurn(store, 1, "1000.0001", at(0));
      completeTurn(store, turn, readySync, at(0));
      const claimed = store.claimNextPrSyncJob({ workerId: "pr-a", now: at(1), leaseMs: 60_000 });
      if (claimed === null) throw new Error("job was not claimed");

      store.recordPrSyncPushed({
        jobId: claimed.jobId,
        workerId: "pr-a",
        operationId: turn.operationId,
        taskId: turn.taskId,
        repo: "o/r",
        headBranch: "agent-tag/task",
        baseBranch: "main",
        sha,
        pushStatus: "pushed",
        now: at(2),
      });
      expect(store.getTaskPullRequest(turn.taskId)).toMatchObject({
        headBranch: "agent-tag/task",
        baseBranch: "main",
        state: "pending",
        number: null,
        url: null,
        lastPushedSha: sha,
      });

      store.settlePrSyncJob({
        jobId: claimed.jobId,
        workerId: "pr-a",
        now: at(3),
        status: "succeeded",
        resultCode: "created",
        pullRequest: {
          repo: "o/r",
          headBranch: "agent-tag/task",
          baseBranch: "main",
          number: 7,
          url: pullRequestUrl,
          state: "open",
          draft: true,
        },
        audit: { action: "pr.created", result: "succeeded", metadata: { number: 7 } },
      });

      expect(store.getTaskPullRequest(turn.taskId)).toEqual({
        taskId: turn.taskId,
        githubRepo: "o/r",
        headBranch: "agent-tag/task",
        baseBranch: "main",
        number: 7,
        url: pullRequestUrl,
        state: "open",
        draft: true,
        lastPushedSha: sha,
      });
      expect(store.listPrSyncJobs(turn.taskId)[0]).toMatchObject({ status: "succeeded" });
    });
  });
});
