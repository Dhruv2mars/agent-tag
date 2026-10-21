import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagMemory, type MemoryContext } from "../src/memory.ts";
import { AgentTagStore } from "../src/store/store.ts";

const now = "2026-09-21T00:00:00.000Z";
const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1", "C2"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/engineering"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: true, retentionDays: 30 },
    },
    {
      id: "support",
      repositoryRoots: ["/srv/repos/support"],
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: true, retentionDays: 30 },
    },
  ],
  routes: [
    { conversationId: "C1", profileId: "engineering" },
    { conversationId: "C2", profileId: "support" },
  ],
  limits: { maxConcurrentTasks: 2 },
});

function acceptedMemory(result: ReturnType<AgentTagMemory["create"]>) {
  if (result.kind !== "accepted") throw new Error(`memory fixture denied: ${result.reason}`);
  return result.memory;
}

describe("scoped memory", () => {
  test("enforces scope, attribution, editing, forgetting, and retention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-memory-"));
    const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
    try {
      const receipt = store.ingestSlackEvent({
        deliveryId: "delivery-1",
        eventKey: "C1:1000.000001",
        workspaceId: "T1",
        conversationId: "C1",
        threadTs: "1000.000001",
        actorUserId: "U1",
        conversationType: "channel",
        profileId: "engineering",
        repositoryRoot: "/srv/repos/engineering",
        text: "fixture",
        receivedAt: now,
      });
      const memory = new AgentTagMemory({ config, store });
      const channelU1: MemoryContext = {
        workspaceId: "T1",
        actorUserId: "U1",
        profileId: "engineering",
        taskId: receipt.taskId,
        conversationType: "channel",
      };
      const shared = acceptedMemory(memory.create({
        context: channelU1,
        scope: "shared",
        content: "team convention",
        sourceType: "slack-message",
        sourceId: "C1:1000.000010",
        now,
      }));
      const profile = acceptedMemory(memory.create({
        context: channelU1,
        scope: "profile",
        content: "engineering convention",
        sourceType: "slack-message",
        sourceId: "C1:1000.000011",
        now,
      }));
      const task = acceptedMemory(memory.create({
        context: channelU1,
        scope: "task",
        content: "task decision",
        sourceType: "slack-message",
        sourceId: "C1:1000.000012",
        now,
      }));
      const privateEntry = acceptedMemory(memory.create({
        context: { ...channelU1, conversationType: "dm" },
        scope: "private",
        content: "private preference",
        sourceType: "slack-dm",
        sourceId: "D1:1000.000013",
        now,
      }));

      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).toEqual(
        expect.arrayContaining([shared.memoryId, profile.memoryId, task.memoryId]),
      );
      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).not.toContain(
        privateEntry.memoryId,
      );
      expect(
        memory.list({ context: { ...channelU1, conversationType: "dm" }, now }).map((entry) => entry.memoryId),
      ).toContain(privateEntry.memoryId);

      const channelU2: MemoryContext = { ...channelU1, actorUserId: "U2" };
      expect(memory.list({ context: channelU2, now }).map((entry) => entry.memoryId)).not.toContain(
        privateEntry.memoryId,
      );
      expect(
        memory.edit({ context: { ...channelU2, conversationType: "dm" }, memoryId: privateEntry.memoryId, content: "stolen", now }),
      ).toEqual({ kind: "denied", reason: "memory-denied" });

      const supportContext: MemoryContext = {
        workspaceId: "T1",
        actorUserId: "U2",
        profileId: "support",
        conversationType: "channel",
      };
      expect(memory.list({ context: supportContext, now }).map((entry) => entry.memoryId)).toEqual([
        shared.memoryId,
      ]);
      expect(memory.list({ context: { ...channelU1, taskId: "forged-task" }, now })).toEqual([]);

      const edited = memory.edit({ context: channelU1, memoryId: profile.memoryId, content: "updated convention", now });
      expect(edited.kind).toBe("accepted");
      if (edited.kind !== "accepted") throw new Error("memory edit failed");
      expect(edited.memory).toMatchObject({ content: "updated convention", version: 2 });
      expect(memory.forget({ context: channelU1, memoryId: task.memoryId, now })).toEqual({ kind: "accepted" });
      expect(memory.list({ context: channelU1, now }).map((entry) => entry.memoryId)).not.toContain(task.memoryId);

      expect(store.expireMemory("2026-10-22T00:00:00.000Z")).toBe(3);
      expect(memory.list({ context: channelU1, now: "2026-10-22T00:00:00.000Z" })).toEqual([]);
      expect(store.listAuditRecords().map((record) => record.action)).toEqual(
        expect.arrayContaining([
          "memory.created",
          "memory.updated",
          "memory.forgotten",
          "memory.expired",
          "memory.denied",
        ]),
      );
    } finally {
      store.close();
      if (!directory.startsWith(`${tmpdir()}/agent-tag-memory-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});

async function withMemoryStore(
  label: string,
  run: (store: AgentTagStore, path: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `agent-tag-memory-${label}-`));
  const path = join(directory, "agent-tag.sqlite");
  const store = await AgentTagStore.open(path);
  try {
    await run(store, path);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-memory-${label}-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
}

function withMemoryLimits(memory: Partial<(typeof config.profiles)[number]["memory"]>) {
  return agentTagConfigSchema.parse({
    ...config,
    profiles: config.profiles.map((profile) => ({ ...profile, memory: { ...profile.memory, ...memory } })),
  });
}

const inC1: MemoryContext = {
  workspaceId: "T1",
  actorUserId: "U1",
  profileId: "engineering",
  conversationId: "C1",
  visibility: "public",
  conversationType: "channel",
};
const inC3: MemoryContext = { ...inC1, conversationId: "C3" };
const inDm: MemoryContext = {
  workspaceId: "T1",
  actorUserId: "U1",
  profileId: "engineering",
  conversationId: "D1",
  visibility: "dm",
  conversationType: "dm",
};

function remembered(result: ReturnType<AgentTagMemory["remember"]>) {
  if (result.kind !== "accepted") throw new Error(`remember fixture not accepted: ${JSON.stringify(result)}`);
  return result.memory;
}

function rememberIn(memory: AgentTagMemory, context: MemoryContext, content: string, target: "here" | "workspace" = "here") {
  return memory.remember({ context, target, content, sourceType: "slack-message", sourceId: "C1:1.1", now });
}

const ids = (records: ReadonlyArray<{ readonly memoryId: string }>) => records.map((record) => record.memoryId);

describe("channel scope", () => {
  test("a channel note is visible only in its conversation, and any allowed user there can edit or forget it", async () => {
    await withMemoryStore("channel", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const note = remembered(rememberIn(memory, inC1, "reports go out as tables"));
      expect(note).toMatchObject({
        scope: "channel",
        conversationId: "C1",
        profileId: null,
        ownerUserId: null,
        taskId: null,
        createdBy: "U1",
      });
      expect(ids(memory.listForConversation({ context: inC1, now }).channel)).toEqual([note.memoryId]);
      // Same profile, another channel.
      expect(memory.listForConversation({ context: inC3, now }).channel).toEqual([]);
      expect(ids(memory.list({ context: inC3, now }))).not.toContain(note.memoryId);
      // A DM, even with the channel's conversation id smuggled in.
      expect(ids(memory.list({ context: { ...inDm, conversationId: "C1" }, now }))).not.toContain(note.memoryId);
      expect(memory.resolveRef({ context: inDm, ref: note.memoryId.slice(0, 8), now })).toEqual({ kind: "not-found" });

      const u2: MemoryContext = { ...inC1, actorUserId: "U2" };
      const edited = memory.editRef({ context: u2, ref: note.memoryId.slice(0, 8), content: "reports go out as CSV", now });
      expect(edited).toMatchObject({ kind: "accepted", memory: { content: "reports go out as CSV", version: 2, updatedBy: "U2" } });
      expect(memory.forgetRef({ context: inC3, ref: note.memoryId.slice(0, 8), now })).toEqual({ kind: "not-found" });
      expect(memory.forgetRef({ context: u2, ref: note.memoryId, now })).toMatchObject({ kind: "accepted" });
      expect(memory.listForConversation({ context: inC1, now }).channel).toEqual([]);
      expect(store.hasConversationMemory({ workspaceId: "T1", conversationId: "C1", now })).toBe(false);
      const denials = store.listAuditRecords().filter((record) => record.action === "memory.denied");
      expect(denials.map((record) => record.result)).toEqual(["memory-not-found"]);
    });
  });

  test("channel notes survive re-routing: they are keyed by conversation, not profile", async () => {
    await withMemoryStore("channel-profile", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const note = remembered(rememberIn(memory, inC1, "on-call is @ops"));
      expect(store.hasConversationMemory({ workspaceId: "T1", conversationId: "C1", now })).toBe(true);
      const rerouted = { ...inC1, profileId: "support" };
      expect(ids(memory.listForConversation({ context: rerouted, now }).channel)).toEqual([note.memoryId]);
    });
  });

  test("a channel note needs a conversation and the DM target writes private notes for the owner", async () => {
    await withMemoryStore("channel-dm", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const { conversationId: _, ...noConversation } = inC1;
      expect(rememberIn(memory, noConversation, "x")).toEqual({ kind: "denied", reason: "conversation-required" });
      const dmNote = remembered(rememberIn(memory, inDm, "I prefer terse replies"));
      expect(dmNote).toMatchObject({ scope: "private", profileId: "engineering", ownerUserId: "U1", conversationId: null });
      expect(ids(memory.listForConversation({ context: inDm, now }).dm)).toEqual([dmNote.memoryId]);
      expect(ids(memory.list({ context: inC1, now }))).not.toContain(dmNote.memoryId);
      expect(memory.listForConversation({ context: { ...inDm, actorUserId: "U2" }, now }).dm).toEqual([]);
    });
  });
});

describe("workspace writes", () => {
  test("only a public channel writes workspace notes; private channels and DMs read them per config", async () => {
    await withMemoryStore("workspace", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const note = remembered(rememberIn(memory, inC1, "default branch is main", "workspace"));
      expect(note).toMatchObject({ scope: "shared", conversationId: null, profileId: null });

      const privateChannel: MemoryContext = { ...inC3, visibility: "private" };
      expect(rememberIn(memory, privateChannel, "x", "workspace")).toEqual({
        kind: "denied",
        reason: "workspace-write-requires-public-channel",
      });
      expect(rememberIn(memory, { ...inC3, visibility: "unknown" }, "x", "workspace")).toEqual({
        kind: "denied",
        reason: "workspace-write-requires-public-channel",
      });
      const { visibility: _, ...noVisibility } = inC3;
      expect(rememberIn(memory, noVisibility, "x", "workspace").kind).toBe("denied");
      expect(rememberIn(memory, inDm, "x", "workspace")).toEqual({
        kind: "denied",
        reason: "workspace-write-requires-public-channel",
      });

      // Private channels read workspace notes, read-only.
      expect(ids(memory.listForConversation({ context: privateChannel, now }).workspace)).toEqual([note.memoryId]);
      expect(memory.forgetRef({ context: privateChannel, ref: note.memoryId, now })).toEqual({
        kind: "denied",
        reason: "memory-read-only",
      });
      // DMs read them only with dmReadsWorkspace.
      expect(memory.listForConversation({ context: inDm, now }).workspace).toEqual([]);
      const dmReads = new AgentTagMemory({ config: withMemoryLimits({ dmReadsWorkspace: true }), store });
      expect(ids(dmReads.listForConversation({ context: inDm, now }).workspace)).toEqual([note.memoryId]);
      expect(dmReads.forgetRef({ context: inDm, ref: note.memoryId, now }).kind).toBe("denied");
      // A public channel may edit it.
      expect(memory.editRef({ context: inC3, ref: note.memoryId, content: "default branch is trunk", now }).kind).toBe("accepted");
    });
  });

  test("profile.memory.shared=false denies workspace writes and reads", async () => {
    await withMemoryStore("workspace-off", (store) => {
      const memory = new AgentTagMemory({ config: withMemoryLimits({ shared: false }), store });
      expect(rememberIn(memory, inC1, "x", "workspace")).toEqual({ kind: "denied", reason: "shared-memory-disabled" });
      expect(store.listAuditRecords().map((record) => record.result)).toEqual(["shared-memory-disabled"]);
    });
  });

  test("operator and task notes are listed but never writable from a conversation", async () => {
    await withMemoryStore("operator", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const operator = acceptedMemory(memory.create({
        context: inC1,
        scope: "profile",
        content: "operator convention",
        sourceType: "operator-cli",
        sourceId: "cli",
        now,
      }));
      expect(ids(memory.listForConversation({ context: inC1, now }).operator)).toEqual([operator.memoryId]);
      expect(memory.forgetRef({ context: inC1, ref: operator.memoryId, now })).toEqual({
        kind: "denied",
        reason: "memory-read-only",
      });
    });
  });
});

describe("memory refs", () => {
  test("an 8-hex prefix resolves; an ambiguous prefix lists candidates; invisible and malformed refs are not found", async () => {
    await withMemoryStore("refs", (store, path) => {
      const memory = new AgentTagMemory({ config, store });
      const first = remembered(rememberIn(memory, inC1, "one"));
      const second = remembered(rememberIn(memory, inC1, "two"));
      const elsewhere = remembered(rememberIn(memory, inC3, "three"));
      expect(memory.resolveRef({ context: inC1, ref: `#${first.memoryId.slice(0, 8).toUpperCase()}`, now })).toEqual({
        kind: "found",
        memory: first,
      });
      expect(memory.resolveRef({ context: inC1, ref: elsewhere.memoryId.slice(0, 8), now })).toEqual({ kind: "not-found" });
      expect(memory.resolveRef({ context: inC1, ref: "zz-not-hex", now })).toEqual({ kind: "not-found" });
      expect(memory.resolveRef({ context: inC1, ref: "abc", now })).toEqual({ kind: "not-found" });

      // Force a shared prefix: two visible notes and one invisible note start with "abcd".
      const database = new Database(path, { strict: true });
      const rename = database.query("UPDATE memory_entries SET memory_id = ? WHERE memory_id = ?");
      rename.run(`abcd0001${first.memoryId.slice(8)}`, first.memoryId);
      rename.run(`abcd0002${second.memoryId.slice(8)}`, second.memoryId);
      rename.run(`abcd0003${elsewhere.memoryId.slice(8)}`, elsewhere.memoryId);
      database.close();
      const ambiguous = memory.resolveRef({ context: inC1, ref: "abcd", now });
      expect(ambiguous.kind).toBe("ambiguous");
      if (ambiguous.kind !== "ambiguous") throw new Error("expected an ambiguous ref");
      expect(ambiguous.candidates.map((id) => id.slice(0, 8))).toEqual(["abcd0001", "abcd0002"]);
      expect(memory.forgetRef({ context: inC1, ref: "abcd", now }).kind).toBe("ambiguous");
      expect(memory.resolveRef({ context: inC3, ref: "abcd", now })).toMatchObject({ kind: "found", memory: { content: "three" } });
    });
  });
});

describe("memory caps and content guard", () => {
  test("long and over-cap notes are denied with stable reasons; duplicates return the existing ref", async () => {
    await withMemoryStore("caps", (store) => {
      const memory = new AgentTagMemory({
        config: withMemoryLimits({ maxEntryChars: 50, maxEntriesPerConversation: 2, maxWorkspaceEntries: 1 }),
        store,
      });
      expect(rememberIn(memory, inC1, "x".repeat(51))).toEqual({ kind: "denied", reason: "entry-too-long" });
      expect(rememberIn(memory, inC1, "   ")).toEqual({ kind: "denied", reason: "entry-empty" });
      const first = remembered(rememberIn(memory, inC1, "  Reports go out as &lt;b&gt;tables&lt;/b&gt; &amp; charts "));
      expect(first.content).toBe("Reports go out as <b>tables</b> & charts");
      expect(rememberIn(memory, inC1, "reports go out as <b>TABLES</b> & charts")).toEqual({ kind: "duplicate", memory: first });
      remembered(rememberIn(memory, inC1, "second"));
      expect(rememberIn(memory, inC1, "third")).toEqual({ kind: "denied", reason: "memory-full" });
      // The cap is per conversation.
      remembered(rememberIn(memory, inC3, "third"));
      remembered(rememberIn(memory, inC1, "workspace one", "workspace"));
      expect(rememberIn(memory, inC1, "workspace two", "workspace")).toEqual({ kind: "denied", reason: "memory-full" });
      // An edit is held to the same limit.
      expect(memory.editRef({ context: inC1, ref: first.memoryId, content: "y".repeat(51), now })).toEqual({
        kind: "denied",
        reason: "entry-too-long",
      });
    });
  });

  test("credential-shaped content is denied and the audit row never holds the content", async () => {
    await withMemoryStore("secret", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const secret = `deploy token is ghp_${"a1B2".repeat(8)}`;
      expect(rememberIn(memory, inC1, secret)).toEqual({ kind: "denied", reason: "secret-detected" });
      expect(memory.listForConversation({ context: inC1, now }).channel).toEqual([]);
      const note = remembered(rememberIn(memory, inC1, "plain note"));
      expect(memory.editRef({ context: inC1, ref: note.memoryId, content: secret, now })).toEqual({
        kind: "denied",
        reason: "secret-detected",
      });
      const audit = JSON.stringify(store.listAuditRecords());
      expect(audit).toContain("secret-detected");
      expect(audit).not.toContain("ghp_");
      expect(audit).not.toContain("plain note");
    });
  });

  test("an edit refreshes retention and records the editor; digests change with versions only", async () => {
    await withMemoryStore("digest", (store) => {
      const memory = new AgentTagMemory({ config, store });
      const note = remembered(rememberIn(memory, inC1, "first"));
      const later = "2026-09-25T00:00:00.000Z";
      const edited = memory.editRef({ context: inC1, ref: note.memoryId, content: "second", now: later });
      if (edited.kind !== "accepted") throw new Error("edit failed");
      expect(edited.memory.expiresAt).toBe("2026-10-25T00:00:00.000Z");
      expect(AgentTagMemory.digest([])).toBeNull();
      expect(AgentTagMemory.digest([note])).toMatch(/^[0-9a-f]{64}$/);
      expect(AgentTagMemory.digest([note])).not.toBe(AgentTagMemory.digest([edited.memory]));
      const other = remembered(rememberIn(memory, inC1, "other"));
      expect(AgentTagMemory.digest([note, other])).toBe(AgentTagMemory.digest([other, note]));
      expect(AgentTagMemory.digest([{ ...note, content: "changed" }])).toBe(AgentTagMemory.digest([note]));
    });
  });
});
