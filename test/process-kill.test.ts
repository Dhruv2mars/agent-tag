import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { AgentTagStore } from "../src/store/store.ts";

const claimSchema = z.object({
  operationId: z.string().min(1),
  commandId: z.string().min(1),
  messageId: z.string().min(1),
  attempt: z.number().int().positive(),
});

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("lease-holder exited before reporting its claim");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const line = text.split("\n", 1)[0];
  if (line === undefined) throw new Error("lease-holder produced no output");
  return line;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("process-kill fixture timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("a fresh process recovers stable work after SIGKILL and lease expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-process-kill-"));
  const databasePath = join(directory, "agent-tag.sqlite");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "lease-holder.ts"), databasePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const original = claimSchema.parse(JSON.parse(await within(firstLine(child.stdout), 5_000)));
    expect(original.attempt).toBe(1);
    child.kill("SIGKILL");
    expect(await within(child.exited, 5_000)).not.toBe(0);

    const store = await AgentTagStore.open(databasePath);
    try {
      expect(
        store.claimNextOperation({
          workerId: "recovery-worker",
          now: "2026-09-21T00:00:05.000Z",
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        }),
      ).toBeNull();
      expect(
        store.claimNextOperation({
          workerId: "recovery-worker",
          now: "2026-09-21T00:00:11.000Z",
          leaseMs: 10_000,
          maxConcurrentTasks: 1,
        }),
      ).toMatchObject({
        operationId: original.operationId,
        commandId: original.commandId,
        messageId: original.messageId,
        attempt: 2,
      });
    } finally {
      store.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    if (!directory.startsWith(`${tmpdir()}/agent-tag-process-kill-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});
