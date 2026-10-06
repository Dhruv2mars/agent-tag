import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispatchT3Command,
  pendingT3Approvals,
  pendingT3UserInputs,
  t3CommandSchema,
  t3AttachmentSchema,
  type T3ThreadSnapshot,
} from "../src/t3/gateway.ts";

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
});
