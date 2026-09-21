import { describe, expect, test } from "bun:test";

import {
  pendingT3Approvals,
  pendingT3UserInputs,
  t3CommandSchema,
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
});
