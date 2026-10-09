import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchT3Command,
  fetchT3ThreadSnapshot,
  pendingT3Approvals,
  pendingT3UserInputs,
  t3CommandSchema,
  t3AttachmentSchema,
  t3ServerConfigSchema,
  T3ThreadNotFoundError,
  type T3ThreadSnapshot,
  threadModelSelectionCommand,
} from "../src/t3/gateway.ts";

describe("T3 provider catalog and model selection", () => {
  // Shape of T3 0.0.45 `server.getConfig` (tag v0.0.45, commit 6c8fed35): ServerConfig and ServerProvider in
  // packages/contracts/src/server.ts (ServerProvider :207-264, ServerProviderModel :71-82,
  // ServerProviderContinuation :148-150), stamped by apps/server/src/provider/Drivers/instanceIdentity.ts.
  const fixture = async (): Promise<Record<string, any>> =>
    Bun.file(new URL("./fixtures/t3-0.0.45-server-config.json", import.meta.url)).json();

  test("parses the 0.0.45 catalog, keeping the fields the model policy reads", async () => {
    const parsed = t3ServerConfigSchema.parse(await fixture());
    expect(parsed.providers.map((provider) => [
      provider.instanceId,
      provider.driver,
      provider.displayName,
      provider.continuation?.groupKey,
      provider.requiresNewThreadForModelChange,
      provider.models.map((model) => model.slug),
    ])).toEqual([
      ["codex", "codex", "Codex", "codex:home:/Users/fixture/.codex", undefined, ["gpt-5.6-sol", "gpt-5.6-mini"]],
      ["codex-work", "codex", "Codex (work)", "codex:home:/Users/fixture/.codex-work", undefined, ["gpt-5.6-sol"]],
      ["claudeAgent", "claudeAgent", "Claude", "claude:home:/Users/fixture/.claude", undefined, ["claude-opus-5-5", "claude-sonnet-5"]],
      ["grok", "grok", "Grok", "grok:default", true, ["grok-5", "grok-5-fast"]],
      ["opencode", "opencode", "OpenCode", "opencode:default", undefined, []],
    ]);
    const opus = parsed.providers[2]!.models[0]!;
    expect({ shortName: opus.shortName, aliases: opus.aliases }).toEqual({ shortName: "Opus 5.5", aliases: ["opus"] });
    // Fields this client does not use are stripped rather than trusted.
    expect(Object.keys(parsed)).toEqual(["environment", "providers"]);
    expect("versionAdvisory" in parsed.providers[0]!).toBe(false);
  });

  test("still accepts a catalog without the new optional fields, and ignores malformed ones", async () => {
    const raw = await fixture();
    for (const provider of raw.providers) {
      delete provider.displayName;
      delete provider.continuation;
      delete provider.requiresNewThreadForModelChange;
      for (const model of provider.models) {
        delete model.shortName;
        delete model.aliases;
      }
    }
    const bare = t3ServerConfigSchema.parse(raw);
    expect(bare.providers[0]!.continuation).toBeUndefined();
    expect(bare.providers[0]!.displayName).toBeUndefined();

    raw.providers[0].continuation = { groupKey: "" };
    raw.providers[0].requiresNewThreadForModelChange = "yes";
    raw.providers[0].models[0].aliases = "opus";
    const malformed = t3ServerConfigSchema.parse(raw);
    expect(malformed.providers[0]!.continuation).toBeUndefined();
    expect(malformed.providers[0]!.requiresNewThreadForModelChange).toBeUndefined();
    expect(malformed.providers[0]!.models[0]!.aliases).toBeUndefined();
  });

  test("builds a thread.meta.update that carries only the model selection", () => {
    // T3 0.0.45 ThreadMetaUpdateCommand: packages/contracts/src/orchestration.ts:1241-1259 (no createdAt).
    expect(threadModelSelectionCommand({
      commandId: "operation-1:model",
      threadId: "thread-1",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-mini" },
    })).toEqual({
      type: "thread.meta.update",
      commandId: "operation-1:model",
      threadId: "thread-1",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-mini" },
    });
    const valid = { type: "thread.meta.update", commandId: "c-1", threadId: "t-1", modelSelection: { instanceId: "codex", model: "m" } } as const;
    expect(t3CommandSchema.parse({ ...valid, title: "ignored" })).toEqual(valid);
    for (const invalid of [
      { ...valid, commandId: "" },
      { ...valid, modelSelection: undefined },
      { ...valid, modelSelection: { instanceId: "codex", model: " " } },
    ]) expect(t3CommandSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("T3 gateway command boundary", () => {
  test("rejects a missing stable command id", () => {
    expect(() =>
      t3CommandSchema.parse({
        type: "project.delete",
        projectId: "project-1",
      }),
    ).toThrow();
  });

  test("rejects a turn with more attachments than T3 accepts", () => {
    expect(() =>
      t3CommandSchema.parse({
        type: "thread.turn.start",
        commandId: "operation-1",
        threadId: "thread-1",
        message: {
          messageId: "message-1",
          role: "user",
          text: "Inspect these files",
          attachments: Array.from({ length: 9 }, (_, index) => ({ index })),
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: "2026-09-21T00:00:00.000Z",
      }),
    ).toThrow("Too big");
  });

  test("rejects unsupported images and oversized or malformed file metadata", () => {
    const attachment = { type: "file" as const, id: "attachment-1", name: "report.txt", mimeType: "text/plain", sizeBytes: 10 };
    expect(t3AttachmentSchema.parse(attachment)).toEqual(attachment);
    for (const invalid of [
      { ...attachment, sizeBytes: 0 },
      { ...attachment, sizeBytes: 50 * 1024 * 1024 + 1 },
      { ...attachment, type: "image", mimeType: "image/svg+xml" },
      { ...attachment, type: "image", mimeType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 },
      { ...attachment, id: "" },
    ]) expect(t3AttachmentSchema.safeParse(invalid).success).toBe(false);
  });

  test("reduces resolved approvals out of a thread snapshot", () => {
    const requestedAt = "2026-09-20T00:00:00.000Z";
    const snapshot: T3ThreadSnapshot = {
      snapshotSequence: 3,
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Fixture",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/tmp/fixture",
        latestTurn: null,
        messages: [],
        activities: [
          {
            id: "activity-1",
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "request-1", requestKind: "command" },
            turnId: "turn-1",
            createdAt: requestedAt,
          },
          {
            id: "activity-2",
            tone: "info",
            kind: "approval.resolved",
            summary: "Approval resolved",
            payload: { requestId: "request-1" },
            turnId: "turn-1",
            createdAt: requestedAt,
          },
        ],
        session: null,
      },
    };

    expect(pendingT3Approvals(snapshot)).toEqual([]);
  });

  test("surfaces pending permission approvals instead of skipping them", () => {
    const requestedAt = "2026-10-06T00:00:00.000Z";
    const activity = (id: string, payload: unknown) => ({
      id,
      tone: "approval" as const,
      kind: "approval.requested",
      summary: "Approval requested",
      payload,
      turnId: "turn-1",
      createdAt: requestedAt,
    });
    const snapshot: T3ThreadSnapshot = {
      snapshotSequence: 4,
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Fixture",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/tmp/fixture",
        latestTurn: null,
        messages: [],
        activities: [
          // T3 0.0.45 projects Codex `item/permissions/requestApproval` as requestKind "permission".
          activity("activity-1", { requestId: "request-1", requestKind: "permission", detail: "network access" }),
          // Older payloads carry only the provider request type.
          activity("activity-2", { requestId: "request-2", requestType: "permission_approval" }),
        ],
        session: null,
      },
    };
    expect(pendingT3Approvals(snapshot)).toEqual([
      { requestId: "request-1", requestKind: "permission", detail: "network access", options: [] },
      { requestId: "request-2", requestKind: "permission", options: [] },
    ]);
  });

  test("projects pending user questions and removes resolved requests", () => {
    const requestedAt = "2026-09-20T00:00:00.000Z";
    const snapshot: T3ThreadSnapshot = {
      snapshotSequence: 3,
      thread: {
        id: "thread-1",
        projectId: "project-1",
        title: "Fixture",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/tmp/fixture",
        latestTurn: null,
        messages: [],
        activities: [
          {
            id: "activity-1",
            tone: "approval",
            kind: "user-input.requested",
            summary: "Input requested",
            payload: {
              requestId: "request-1",
              responseMode: "message",
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which package?",
                  options: [{ label: "core" }, { label: "web", description: "Frontend" }],
                  multiSelect: false,
                  allowCustomAnswer: true,
                },
              ],
            },
            turnId: "turn-1",
            createdAt: requestedAt,
          },
        ],
        session: null,
      },
    };
    expect(pendingT3UserInputs(snapshot)).toEqual([
      {
        requestId: "request-1",
        dismissible: true,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which package?",
            options: [{ label: "core" }, { label: "web", description: "Frontend" }],
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ],
      },
    ]);
  });

  test("aborting a dispatch interrupts the pending RPC and closes its WebSocket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-t3-abort-"));
    const tokenFile = join(directory, "t3-token");
    await writeFile(tokenFile, "fixture-token\n");
    await chmod(tokenFile, 0o600);
    let sawDispatch = false;
    let socketClosed = false;
    // A T3 stand-in that authenticates and accepts the RPC but never replies.
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/api/auth/session") {
          return Response.json({
            authenticated: true,
            scopes: ["orchestration:read", "orchestration:operate"],
            sessionMethod: "bearer-access-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }
        if (url.pathname === "/api/auth/websocket-ticket") {
          return Response.json({ ticket: "ticket-1", expiresAt: "2099-01-01T00:00:00.000Z" });
        }
        if (url.pathname === "/ws" && server.upgrade(request)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(_socket, message) {
          if (String(message).includes("orchestration.dispatchCommand")) sawDispatch = true;
        },
        close() {
          socketClosed = true;
        },
      },
    });
    try {
      const controller = new AbortController();
      const dispatched = dispatchT3Command({
        config: { baseUrl: `http://127.0.0.1:${server.port}`, tokenFile },
        command: {
          type: "thread.turn.interrupt",
          commandId: "command-1",
          threadId: "thread-1",
          createdAt: "2026-09-21T00:00:00.000Z",
        },
        signal: controller.signal,
      });
      const settled = dispatched.then(() => "resolved" as const, () => "rejected" as const);
      for (let attempt = 0; attempt < 500 && !sawDispatch; attempt += 1) await Bun.sleep(2);
      expect(sawDispatch).toBe(true);

      controller.abort();
      expect(await Promise.race([settled, Bun.sleep(1_000).then(() => "pending" as const)])).toBe("rejected");
      for (let attempt = 0; attempt < 500 && !socketClosed; attempt += 1) await Bun.sleep(2);
      expect(socketClosed).toBe(true);
    } finally {
      server.stop(true);
      if (!directory.startsWith(`${tmpdir()}/agent-tag-t3-abort-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
  test("a thread snapshot HTTP 404 is a typed not-found error; other HTTP failures are not", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-tag-t3-snapshot-"));
    const tokenFile = join(directory, "t3-token");
    await writeFile(tokenFile, "fixture-token\n");
    await chmod(tokenFile, 0o600);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/auth/session") {
          return Response.json({
            authenticated: true,
            scopes: ["orchestration:read", "orchestration:operate"],
            sessionMethod: "bearer-access-token",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
        }
        if (url.pathname === "/api/orchestration/threads/missing-thread") {
          return new Response("not found", { status: 404 });
        }
        return new Response("unavailable", { status: 503 });
      },
    });
    try {
      const config = { baseUrl: `http://127.0.0.1:${server.port}`, tokenFile };
      const missing = await fetchT3ThreadSnapshot({ config, threadId: "missing-thread" }).catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(T3ThreadNotFoundError);
      const unavailable = await fetchT3ThreadSnapshot({ config, threadId: "other-thread" }).catch((error: unknown) => error);
      expect(unavailable).toBeInstanceOf(Error);
      expect(unavailable).not.toBeInstanceOf(T3ThreadNotFoundError);
      expect((unavailable as Error).message).toContain("HTTP 503");
    } finally {
      server.stop(true);
      if (!directory.startsWith(`${tmpdir()}/agent-tag-t3-snapshot-`)) {
        throw new Error(`refusing to remove unexpected fixture path ${directory}`);
      }
      await rm(directory, { recursive: true });
    }
  });
});
