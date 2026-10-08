import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { classifyT3DispatchError } from "../src/t3/dispatch-errors.ts";

function dispatchError(message: string): unknown {
  return { _tag: "OrchestrationDispatchCommandError", message };
}

describe("T3 dispatch error classification", () => {
  test("treats T3 command rejections as terminal", () => {
    const rejections = [
      "Orchestration command invariant failed (thread.turn.interrupt): Thread 'thread-1' does not exist for command 'thread.turn.interrupt'.",
      "Orchestration command invariant failed (thread.user-input.respond): This question is no longer pending.",
      "Orchestration command invariant failed (thread.user-input.respond): This question has already been answered.",
      "Command previously rejected (command-1): approval already resolved",
      "Invalid orchestration command payload: Expected string at requestId",
      "Command id 'command-1' already used for thread 'a'; refusing to replay its receipt for thread 'b'.",
      "Unknown pending approval request: request-1",
      "stale pending approval request: request-1",
      "turn is not running",
      "validation failed for decision",
    ];
    for (const message of rejections) {
      expect(classifyT3DispatchError(dispatchError(message))).toEqual({ kind: "rejected", code: "T3CommandRejected" });
    }
  });

  test("retries storage, transport, and unknown failures without exposing their text", () => {
    expect(classifyT3DispatchError(dispatchError("Failed to persist orchestration event."))).toEqual({
      kind: "transient",
      code: "T3DispatchFailed",
    });
    expect(classifyT3DispatchError({ _tag: "RpcClientError", message: "socket closed" })).toEqual({
      kind: "transient",
      code: "RpcClientError",
    });
    expect(classifyT3DispatchError(new TypeError("fetch failed"))).toEqual({ kind: "transient", code: "TypeError" });
    expect(classifyT3DispatchError("boom")).toEqual({ kind: "transient", code: "InteractionDispatchError" });
    // A rejection-like message only counts when T3 itself reported it as a dispatch error.
    expect(classifyT3DispatchError(new Error("Thread does not exist"))).toEqual({ kind: "transient", code: "Error" });
    expect(z.object({ code: z.string() }).parse(classifyT3DispatchError(dispatchError("secret-canary"))).code)
      .not.toContain("secret-canary");
  });
});
