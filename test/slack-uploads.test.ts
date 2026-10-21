import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema, type AgentTagConfig } from "../src/config.ts";
import { AgentTagCoordinator, type T3CoordinatorGateway } from "../src/coordinator.ts";
import { deliverNextSlackOutbox } from "../src/slack/outbox.ts";
import {
  ArtifactError,
  FileUploadWorker,
  normalizeUploadPath,
  parseUploadDirectives,
  readWorkspaceArtifact,
  rejectedUploadsNotice,
  secretClassesIn,
  slackUploadClient,
  SlackUploadPostError,
  type SlackFilesApi,
  type SlackUploadClient,
} from "../src/slack/uploads.ts";
import { AgentTagStore, type SlackEventInput } from "../src/store/store.ts";
import type { T3Command, T3ThreadSnapshot } from "../src/t3/gateway.ts";

const start = "2026-10-01T00:00:00.000Z";
const baseConfig = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U0A1"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 1 },
} as const;
const config = agentTagConfigSchema.parse(baseConfig);
const limits = config.files.outbound;

const CSV = new TextEncoder().encode("name,count\nalpha,1\nbeta,2\n");
// A token-shaped canary (never a real credential): `ghp_` plus 36 characters.
const FAKE_GITHUB_TOKEN = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;

describe("config", () => {
  test("outbound defaults, and caps that stay under T3's 50 MiB file limit", () => {
    expect(limits).toEqual({ enabled: true, maxFilesPerTurn: 5, maxFileBytes: 25 * 1024 * 1024, scanForSecrets: true });
    const parse = (outbound: Record<string, unknown>) => agentTagConfigSchema.parse({ ...baseConfig, files: { outbound } });
    expect(() => parse({ maxFilesPerTurn: 11 })).toThrow();
    expect(() => parse({ maxFilesPerTurn: 0 })).toThrow();
    expect(() => parse({ maxFileBytes: 50 * 1024 * 1024 + 1 })).toThrow();
    expect(() => parse({ surprise: true })).toThrow();
    expect(parse({ enabled: false }).files.inbound.enabled).toBe(true);
  });
});

describe("upload directives", () => {
  test("strips directive lines and keeps paths, titles and the reply around them", () => {
    const parsed = parseUploadDirectives(
      [
        "Here is the report.",
        "[[agent-tag:upload out/report.csv]]",
        '  [[agent-tag:upload ./charts//q3.png "Q3 chart"]]  ',
      ].join("\n"),
      5,
    );
    expect(parsed.text).toBe("Here is the report.");
    expect(parsed.requests).toEqual([
      { path: "out/report.csv", title: null },
      { path: "charts/q3.png", title: "Q3 chart" },
    ]);
    expect(parsed.rejected).toEqual([]);
  });

  test("never queues paths outside the workspace or hidden files (Done 7)", () => {
    const parsed = parseUploadDirectives(
      [
        "[[agent-tag:upload ../x]]",
        "[[agent-tag:upload /etc/passwd]]",
        "[[agent-tag:upload ~/.ssh/id_rsa]]",
        "[[agent-tag:upload out/../../x]]",
        "[[agent-tag:upload out\\x.csv]]",
        "[[agent-tag:upload .env]]",
        "[[agent-tag:upload out/.secrets/key.txt]]",
      ].join("\n"),
      10,
    );
    expect(parsed.requests).toEqual([]);
    expect(parsed.rejected.map((entry) => entry.reason)).toEqual([
      "invalid-path",
      "invalid-path",
      "invalid-path",
      "invalid-path",
      "invalid-path",
      "hidden-path",
      "hidden-path",
    ]);
    expect(parsed.text).toBe("I couldn't share the files I meant to.");
    expect(normalizeUploadPath("a/\u0007b")).toEqual({ reason: "invalid-path" });
  });

  test("ignores directives inside a paragraph or a code fence", () => {
    const text = [
      "Write [[agent-tag:upload out/a.csv]] on its own line to share a file.",
      "```",
      "[[agent-tag:upload out/b.csv]]",
      "```",
    ].join("\n");
    expect(parseUploadDirectives(text, 5)).toEqual({ text, requests: [], rejected: [] });
  });

  test("caps the count, drops duplicates, and lists what was not queued", () => {
    const parsed = parseUploadDirectives(
      ["[[agent-tag:upload a.csv]]", "[[agent-tag:upload ./a.csv]]", "[[agent-tag:upload b.csv]]", "[[agent-tag:upload c.csv]]"].join("\n"),
      2,
    );
    expect(parsed.requests.map((request) => request.path)).toEqual(["a.csv", "b.csv"]);
    expect(parsed.rejected).toEqual([
      { path: "./a.csv", reason: "duplicate" },
      { path: "c.csv", reason: "over-limit" },
    ]);
    expect(parsed.text).toBe("Sharing 2 files.");
    expect(rejectedUploadsNotice(parsed.rejected, { ...limits, maxFilesPerTurn: 2 })).toBe(
      ":warning: Didn't share `./a.csv` (listed twice), `c.csv` (only 2 files per reply).",
    );
    expect(rejectedUploadsNotice([{ path: "<!channel>`x", reason: "invalid-path" }], limits)).toBe(
      ":warning: Didn't share `@\u200bchannel'x` (not a path inside the workspace).",
    );
  });
});

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-uploads-"));
  try {
    await run(directory);
  } finally {
    if (!directory.startsWith(`${tmpdir()}/agent-tag-uploads-`)) throw new Error(`refusing to remove ${directory}`);
    await rm(directory, { recursive: true, force: true });
  }
}

describe("workspace reads", () => {
  test("returns exact bytes and refuses escapes, hidden targets, directories, empty and oversize files", async () => {
    await withDirectory(async (directory) => {
      const root = join(directory, "worktree");
      await mkdir(join(root, "out"), { recursive: true });
      await mkdir(join(root, ".git"));
      await writeFile(join(root, "out", "report.csv"), CSV);
      await writeFile(join(root, "out", "empty.txt"), "");
      await writeFile(join(root, ".git", "config"), "[core]\n");
      await writeFile(join(directory, "outside.txt"), "host secret");
      await symlink(join(directory, "outside.txt"), join(root, "out", "escape.txt"));
      await symlink(join(root, ".git", "config"), join(root, "out", "git-config"));
      await symlink(join(root, "out", "report.csv"), join(root, "out", "alias.csv"));

      const read = (path: string, maxBytes = 1024) => readWorkspaceArtifact({ root, path, maxBytes });
      const code = (path: string, maxBytes?: number) =>
        read(path, maxBytes).then(() => "read", (error: unknown) => (error instanceof ArtifactError ? error.code : String(error)));

      expect(await read("out/report.csv")).toEqual(CSV);
      expect(await read("out/alias.csv")).toEqual(CSV);
      expect(await code("out/escape.txt")).toBe("outside-workspace");
      expect(await code("../outside.txt")).toBe("outside-workspace");
      expect(await code("out/git-config")).toBe("hidden-path");
      expect(await code(".git/config")).toBe("hidden-path");
      expect(await code("out")).toBe("not-a-file");
      expect(await code("out/missing.csv")).toBe("not-found");
      expect(await code("out/empty.txt")).toBe("empty");
      expect(await code("out/report.csv", CSV.byteLength - 1)).toBe("too-large");
    });
  });
});

describe("secret gate", () => {
  test("finds credential shapes in text and inside binary bytes, and reports classes only", () => {
    expect(secretClassesIn(new TextEncoder().encode(`token=${FAKE_GITHUB_TOKEN}\n`))).toEqual(["github-token"]);
    const binary = new Uint8Array([0, 0xff, 0x89, ...new TextEncoder().encode(FAKE_GITHUB_TOKEN), 0, 0xfe]);
    expect(secretClassesIn(binary)).toEqual(["github-token"]);
    expect(secretClassesIn(CSV)).toEqual([]);
  });
});

describe("Slack upload client", () => {
  test("uses the three-step external upload and never sends the token to the upload URL", async () => {
    const calls: { method: string; args: unknown }[] = [];
    const api: SlackFilesApi = {
      files: {
        getUploadURLExternal: async (args) => {
          calls.push({ method: "files.getUploadURLExternal", args });
          return { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F0UP1" };
        },
        completeUploadExternal: async (args) => {
          calls.push({ method: "files.completeUploadExternal", args });
          return { ok: true };
        },
        info: async (args) => {
          calls.push({ method: "files.info", args });
          return { ok: true, file: { id: "F0UP1", channels: ["C9"], shares: { private: { C1: [] } } } };
        },
      },
    };
    const posts: { url: string; init: RequestInit }[] = [];
    const client = slackUploadClient(api, async (url, init) => {
      posts.push({ url: url.toString(), init });
      return new Response("OK", { status: 200 });
    });
    expect(await client.getUploadUrl({ filename: "report.csv", length: CSV.byteLength })).toEqual({
      uploadUrl: "https://files.slack.com/upload/v1/abc",
      fileId: "F0UP1",
    });
    await client.postBytes("https://files.slack.com/upload/v1/abc", CSV);
    await client.complete({ fileId: "F0UP1", title: "Report", channelId: "C1", threadTs: "1000.000001" });
    expect(await client.sharedIn("F0UP1")).toEqual(["C9", "C1"]);
    expect(calls.map((call) => call.method)).toEqual([
      "files.getUploadURLExternal",
      "files.completeUploadExternal",
      "files.info",
    ]);
    expect(calls[1]?.args).toEqual({ files: [{ id: "F0UP1", title: "Report" }], channel_id: "C1", thread_ts: "1000.000001" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init.method).toBe("POST");
    expect(posts[0]?.init.redirect).toBe("error");
    expect(posts[0]?.init.headers).toBeUndefined();
    expect(new Uint8Array(await new Response(posts[0]?.init.body as Blob).arrayBuffer())).toEqual(CSV);

    await expect(client.postBytes("http://files.slack.com/upload/v1/abc", CSV)).rejects.toThrow("Slack upload POST failed");
    const failing = slackUploadClient(api, async () => {
      throw new Error("connect https://files.slack.com/upload/v1/abc?secret=1 refused");
    });
    const error = await failing.postBytes("https://files.slack.com/upload/v1/abc?secret=1", CSV).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("secret=1");
  });
});

// --- Completion hook + upload worker against a real store (Done 6, Done 7). ---

interface Harness {
  readonly store: AgentTagStore;
  readonly path: string;
  readonly root: string;
  readonly clock: () => Date;
  readonly advance: (milliseconds: number) => void;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  await withDirectory(async (directory) => {
    const path = join(directory, "agent-tag.sqlite");
    const root = join(directory, "worktree");
    await mkdir(join(root, "out"), { recursive: true });
    const store = await AgentTagStore.open(path);
    let current = new Date(start).getTime();
    try {
      await run({
        store,
        path,
        root,
        clock: () => new Date(current),
        advance: (milliseconds) => {
          current += milliseconds;
        },
      });
    } finally {
      store.close();
    }
  });
}

function mention(text = "make the report"): SlackEventInput {
  return {
    deliveryId: "delivery-1",
    eventKey: "C1:1000.000001",
    workspaceId: "T1",
    conversationId: "C1",
    threadTs: "1000.000001",
    actorUserId: "U0A1",
    conversationType: "channel",
    profileId: "engineering",
    repositoryRoot: "/srv/repos/example",
    text,
    receivedAt: start,
    sourceOrderKey: "1000.000001",
    messageTs: "1000.000001",
    origin: "slack",
  };
}

function scriptedT3(clock: () => Date, reply: string, worktreePath: string) {
  const turnStarts: Extract<T3Command, { type: "thread.turn.start" }>[] = [];
  let threadId = "not-dispatched";
  let messageId = "not-dispatched";
  const t3: T3CoordinatorGateway = {
    dispatch: async (command) => {
      if (command.type === "thread.turn.start") {
        turnStarts.push(command);
        threadId = command.threadId;
        messageId = command.message.messageId;
      }
      return { sequence: turnStarts.length };
    },
    fetchThread: async (): Promise<T3ThreadSnapshot> => {
      const at = clock().toISOString();
      return {
        snapshotSequence: 9,
        thread: {
          id: threadId,
          projectId: "project-1",
          title: "Fixture",
          modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: "agent-tag/task-1",
          worktreePath,
          latestTurn: {
            turnId: `turn-${messageId}`,
            state: "completed",
            requestedAt: at,
            startedAt: at,
            completedAt: at,
            assistantMessageId: `assistant-${messageId}`,
          },
          messages: [
            { id: messageId, role: "user", text: "request", turnId: null, streaming: false, createdAt: at, updatedAt: at },
            { id: `assistant-${messageId}`, role: "assistant", text: reply, turnId: `turn-${messageId}`, streaming: false, createdAt: at, updatedAt: at },
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
            updatedAt: at,
          },
        },
      };
    },
  };
  return { t3, turnStarts };
}

async function completeTurn(harness: Harness, reply: string, options: { config?: AgentTagConfig } = {}) {
  harness.store.ingestSlackEvent(mention());
  const { t3, turnStarts } = scriptedT3(harness.clock, reply, harness.root);
  const coordinator = new AgentTagCoordinator({
    config: options.config ?? config,
    store: harness.store,
    t3,
    workerId: "worker-a",
    now: harness.clock,
    sleep: async (milliseconds) => harness.advance(milliseconds),
  });
  expect((await coordinator.processNext()).kind).toBe("completed");
  return turnStarts;
}

/** Posts every pending reply through the real outbox delivery with a fake chat.postMessage; returns them minus the live status message. */
async function deliverReplies(harness: Harness): Promise<string[]> {
  const posted: string[] = [];
  for (;;) {
    const outcome = await deliverNextSlackOutbox({
      config,
      store: harness.store,
      workerId: "outbox",
      postMessage: async (message) => {
        posted.push(message.text);
        return { ts: `1000.00010${posted.length}` };
      },
      updateMessage: async () => ({}),
      now: () => harness.clock().toISOString(),
    });
    if (outcome.kind === "idle") {
      // Anything the upload worker enqueues next sorts after these replies.
      harness.advance(1_000);
      return posted.filter((text) => text !== "Working on it…");
    }
  }
}

function fakeSlack(options: { sharedIn?: (fileId: string) => readonly string[]; fail?: Partial<Record<"getUploadUrl" | "postBytes" | "complete", unknown>> } = {}) {
  const calls: { method: string; args: unknown }[] = [];
  let next = 0;
  const failOnce = (method: "getUploadUrl" | "postBytes" | "complete") => {
    const error = options.fail?.[method];
    if (error === undefined) return;
    delete options.fail?.[method];
    throw error;
  };
  const client: SlackUploadClient = {
    getUploadUrl: async (args) => {
      calls.push({ method: "getUploadURLExternal", args });
      failOnce("getUploadUrl");
      next += 1;
      return { uploadUrl: `https://files.slack.com/upload/v1/${next}`, fileId: `F0UP${next}` };
    },
    postBytes: async (uploadUrl, bytes) => {
      calls.push({ method: "POST", args: { uploadUrl, bytes: new TextDecoder().decode(bytes) } });
      failOnce("postBytes");
    },
    complete: async (args) => {
      calls.push({ method: "completeUploadExternal", args });
      failOnce("complete");
    },
    sharedIn: async (fileId) => {
      calls.push({ method: "files.info", args: fileId });
      return options.sharedIn?.(fileId) ?? [];
    },
  };
  return { client, calls };
}

function uploadRows(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query("SELECT workspace_root, workspace_path, title, state, slack_file_id, attempts, error_code FROM slack_file_uploads ORDER BY ordinal")
      .all();
  } finally {
    database.close();
  }
}

function outboxTexts(path: string): { clientMessageId: string; text: string }[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query("SELECT client_message_id, payload_json FROM slack_outbox WHERE method = 'post' AND client_message_id NOT LIKE '%:status' ORDER BY created_at, client_message_id")
      .all()
      .map((row) => {
        const { client_message_id, payload_json } = row as { client_message_id: string; payload_json: string };
        return { clientMessageId: client_message_id, text: (JSON.parse(payload_json) as { text: string }).text };
      });
  } finally {
    database.close();
  }
}

function auditRows(path: string, action: string): { result: string; metadata_json: string }[] {
  const database = new Database(path, { readonly: true });
  try {
    return database.query("SELECT result, metadata_json FROM audit_log WHERE action = ?").all(action) as { result: string; metadata_json: string }[];
  } finally {
    database.close();
  }
}

function worker(harness: Harness, slack: SlackUploadClient, options: { config?: AgentTagConfig } = {}) {
  return new FileUploadWorker({
    config: options.config ?? config,
    store: harness.store,
    slack,
    workerId: "uploader",
    random: () => 0,
    now: harness.clock,
  });
}

describe("agent files shared to Slack (PR-L2)", () => {
  test("a reply's upload directive posts the reply without it, then shares the file in the thread (Done 6)", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "report.csv"), CSV);
      const turnStarts = await completeTurn(harness, "Here is the report.\n[[agent-tag:upload out/report.csv]]");
      expect(turnStarts[0]?.message.text).toContain("[[agent-tag:upload relative/path/to/file]]");
      expect(uploadRows(harness.path)).toEqual([
        {
          workspace_root: harness.root,
          workspace_path: "out/report.csv",
          title: null,
          state: "pending",
          slack_file_id: null,
          attempts: 0,
          error_code: null,
        },
      ]);

      const slack = fakeSlack();
      // The file waits for the reply it belongs to.
      expect((await worker(harness, slack.client).processNext()).kind).toBe("idle");
      expect(await deliverReplies(harness)).toEqual(["Here is the report."]);

      expect((await worker(harness, slack.client).processNext()).kind).toBe("delivered");
      expect(slack.calls).toEqual([
        { method: "getUploadURLExternal", args: { filename: "report.csv", length: CSV.byteLength } },
        { method: "POST", args: { uploadUrl: "https://files.slack.com/upload/v1/1", bytes: new TextDecoder().decode(CSV) } },
        { method: "completeUploadExternal", args: { fileId: "F0UP1", title: "report.csv", channelId: "C1", threadTs: "1000.000001" } },
      ]);
      expect(uploadRows(harness.path)).toMatchObject([{ state: "delivered", slack_file_id: "F0UP1", attempts: 1 }]);
      expect((await worker(harness, slack.client).processNext()).kind).toBe("idle");
    });
  });

  test("paths outside the workspace and a symlink escape never reach Slack (Done 7)", async () => {
    await withHarness(async (harness) => {
      const outside = join(harness.root, "..", "host-secret.txt");
      await writeFile(outside, "host only");
      await symlink(outside, join(harness.root, "out", "link.txt"));
      await completeTurn(
        harness,
        [
          "Done.",
          "[[agent-tag:upload ../x]]",
          "[[agent-tag:upload /etc/passwd]]",
          "[[agent-tag:upload ~/.ssh/id_rsa]]",
          "[[agent-tag:upload out/link.txt]]",
        ].join("\n"),
      );
      expect(uploadRows(harness.path)).toMatchObject([{ workspace_path: "out/link.txt", state: "pending" }]);
      await deliverReplies(harness);
      const slack = fakeSlack();
      expect(await worker(harness, slack.client).processNext()).toMatchObject({ kind: "failed", errorCode: "outside-workspace" });
      expect(slack.calls).toEqual([]);
      expect(outboxTexts(harness.path).map((row) => row.text)).toEqual([
        "Done.",
        ":warning: Didn't share `../x` (not a path inside the workspace), `/etc/passwd` (not a path inside the workspace), `~/.ssh/id_rsa` (not a path inside the workspace).",
        ":warning: Couldn't share `link.txt`: the path leaves the workspace.",
      ]);
    });
  });

  test("a file with a known credential shape is held back with a notice and an audit row without content (Done 7)", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "notes.txt"), `deploy with ${FAKE_GITHUB_TOKEN}\n`);
      await completeTurn(harness, "Notes attached.\n[[agent-tag:upload out/notes.txt \"Deploy notes\"]]");
      await deliverReplies(harness);
      const slack = fakeSlack();
      expect(await worker(harness, slack.client).processNext()).toMatchObject({ kind: "failed", errorCode: "secret-blocked" });
      expect(slack.calls).toEqual([]);
      expect(outboxTexts(harness.path).at(-1)?.text).toBe(
        ":warning: Couldn't share `notes.txt`: it looks like it contains a credential, so Agent Tag held it back.",
      );
      const blocked = auditRows(harness.path, "slack.file.upload-blocked");
      expect(blocked).toHaveLength(1);
      expect(JSON.parse(blocked[0]?.metadata_json ?? "{}")).toMatchObject({ classes: "github-token", extension: "txt" });
      const database = new Database(harness.path, { readonly: true });
      try {
        const dump = JSON.stringify(database.query("SELECT * FROM audit_log").all());
        expect(dump).not.toContain(FAKE_GITHUB_TOKEN);
        expect(dump).not.toContain("notes.txt");
      } finally {
        database.close();
      }
    });
  });

  test("the secret gate can be turned off", async () => {
    await withHarness(async (harness) => {
      const open = agentTagConfigSchema.parse({ ...baseConfig, files: { outbound: { scanForSecrets: false } } });
      await writeFile(join(harness.root, "out", "notes.txt"), `deploy with ${FAKE_GITHUB_TOKEN}\n`);
      await completeTurn(harness, "[[agent-tag:upload out/notes.txt]]", { config: open });
      await deliverReplies(harness);
      expect((await worker(harness, fakeSlack().client, { config: open }).processNext()).kind).toBe("delivered");
    });
  });

  test("a crash after Slack shared the file marks it delivered without sharing it again", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "report.csv"), CSV);
      await completeTurn(harness, "[[agent-tag:upload out/report.csv]]");
      await deliverReplies(harness);
      // completeUploadExternal reached Slack but the response was lost: ambiguous, so retried.
      const lost = fakeSlack({ fail: { complete: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) } });
      expect(await worker(harness, lost.client).processNext()).toMatchObject({ kind: "retry-scheduled" });
      expect(uploadRows(harness.path)).toMatchObject([{ state: "pending", slack_file_id: "F0UP1" }]);

      harness.advance(10 * 60_000);
      const recovered = fakeSlack({ sharedIn: () => ["C1"] });
      expect((await worker(harness, recovered.client).processNext()).kind).toBe("delivered");
      expect(recovered.calls).toEqual([{ method: "files.info", args: "F0UP1" }]);
      expect(uploadRows(harness.path)).toMatchObject([{ state: "delivered", slack_file_id: "F0UP1", attempts: 2 }]);
    });
  });

  test("a crash before the share completed starts a fresh upload on retry", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "report.csv"), CSV);
      await completeTurn(harness, "[[agent-tag:upload out/report.csv]]");
      await deliverReplies(harness);
      const slack = fakeSlack({ fail: { postBytes: new SlackUploadPostError(null) } });
      expect(await worker(harness, slack.client).processNext()).toMatchObject({ kind: "retry-scheduled", errorCode: "upload_post_failed" });
      harness.advance(10 * 60_000);
      expect((await worker(harness, slack.client).processNext()).kind).toBe("delivered");
      expect(slack.calls.map((call) => call.method)).toEqual([
        "getUploadURLExternal",
        "POST",
        "files.info",
        "getUploadURLExternal",
        "POST",
        "completeUploadExternal",
      ]);
      expect(uploadRows(harness.path)).toMatchObject([{ state: "delivered", slack_file_id: "F0UP2" }]);
    });
  });

  test("a missing files:write scope fails once with a reinstall hint", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "report.csv"), CSV);
      await completeTurn(harness, "[[agent-tag:upload out/report.csv]]");
      await deliverReplies(harness);
      const missingScope = Object.assign(new Error("An API error occurred: missing_scope"), {
        code: "slack_webapi_platform_error",
        data: { ok: false, error: "missing_scope" },
      });
      const slack = fakeSlack({ fail: { getUploadUrl: missingScope } });
      expect(await worker(harness, slack.client).processNext()).toMatchObject({ kind: "failed", errorCode: "missing_scope" });
      expect(outboxTexts(harness.path).at(-1)?.text).toBe(
        ":warning: Couldn't share `report.csv`: the Slack app needs the files:write scope; ask the operator to reinstall it.",
      );
    });
  });

  test("an upload whose task lost its route fails without touching Slack or posting a notice", async () => {
    await withHarness(async (harness) => {
      await writeFile(join(harness.root, "out", "report.csv"), CSV);
      await completeTurn(harness, "[[agent-tag:upload out/report.csv]]");
      await deliverReplies(harness);
      const revoked = agentTagConfigSchema.parse({
        ...baseConfig,
        access: { ...baseConfig.access, allowedChannelIds: ["C2"] },
        routes: [{ conversationId: "C2", profileId: "engineering" }],
      });
      const slack = fakeSlack();
      expect(await worker(harness, slack.client, { config: revoked }).processNext()).toMatchObject({
        kind: "failed",
        errorCode: "ExecutionAuthorityDenied",
      });
      expect(slack.calls).toEqual([]);
      expect(outboxTexts(harness.path).map((row) => row.text)).toEqual(["Sharing 1 file."]);
    });
  });

  test("with outbound files off, directives stay in the reply and no instruction is sent", async () => {
    await withHarness(async (harness) => {
      const off = agentTagConfigSchema.parse({ ...baseConfig, files: { outbound: { enabled: false } } });
      const turnStarts = await completeTurn(harness, "[[agent-tag:upload out/report.csv]]", { config: off });
      expect(turnStarts[0]?.message.text).not.toContain("agent-tag:upload");
      expect(uploadRows(harness.path)).toEqual([]);
      expect(outboxTexts(harness.path).map((row) => row.text)).toEqual(["[[agent-tag:upload out/report.csv]]"]);
    });
  });
});
