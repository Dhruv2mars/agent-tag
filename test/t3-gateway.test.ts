import { describe, expect, test } from "bun:test";

import { t3CommandSchema } from "../src/t3/gateway.ts";

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
});
