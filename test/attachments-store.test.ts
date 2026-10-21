import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTagStore } from "../src/store/store.ts";

const start = "2026-10-01T00:00:00.000Z";
const later = "2026-10-01T00:00:01.000Z";
const image = { type: "image", id: "t3-1", name: "a.png", mimeType: "image/png", sizeBytes: 10 } as const;

async function withClaimed(run: (store: AgentTagStore, operationId: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-attachments-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    store.ingestSlackEvent({
      deliveryId: "d1",
      eventKey: "C1:1000.000001",
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.000001",
      actorUserId: "U1",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
      text: "look",
      receivedAt: start,
      files: [{ id: "F1", name: "secret-plan.png" }, { id: "F2" }],
    });
    const claimed = store.claimNextOperation({ workerId: "w1", now: start, leaseMs: 10_000, maxConcurrentTasks: 1 });
    if (claimed === null) throw new Error("no claim");
    run(store, claimed.operationId);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-attachments-`)) throw new Error(`unexpected path ${directory}`);
    await rm(directory, { recursive: true });
  }
}

const base = { workerId: "w1", extension: "png", sizeBytes: 10, now: later };

describe("operation attachments", () => {
  test("records under the lease; the first outcome for an ordinal wins", async () => {
    await withClaimed((store, operationId) => {
      expect(store.recordOperationAttachment({ ...base, operationId, ordinal: 0, slackFileId: "F1", outcome: { attachment: image } }))
        .toEqual({ ordinal: 0, slackFileId: "F1", state: "attached", attachment: image });
      // A racing replay cannot replace an attached id.
      expect(
        store.recordOperationAttachment({ ...base, operationId, ordinal: 0, slackFileId: "F1", outcome: { skipReason: "unavailable" } }),
      ).toEqual({ ordinal: 0, slackFileId: "F1", state: "attached", attachment: image });
      // A later timestamp keeps the audit order deterministic (ties sort by random audit id).
      store.recordOperationAttachment({
        ...base,
        now: "2026-10-01T00:00:02.000Z",
        operationId,
        ordinal: 1,
        slackFileId: "F2",
        outcome: { skipReason: "too-large" },
      });
      expect(store.listOperationAttachments(operationId)).toEqual([
        { ordinal: 0, slackFileId: "F1", state: "attached", attachment: image },
        { ordinal: 1, slackFileId: "F2", state: "skipped", reason: "too-large" },
      ]);
      // One audit row per recorded outcome, with no file names.
      const audits = store.listAuditRecords().filter((record) => record.action.startsWith("slack.file."));
      expect(audits.map((record) => [record.action, record.result])).toEqual([
        ["slack.file.attached", "image"],
        ["slack.file.skipped", "too-large"],
      ]);
      expect(JSON.stringify(audits)).not.toContain("secret-plan");
    });
  });

  test("refuses a write without a live lease", async () => {
    await withClaimed((store, operationId) => {
      expect(() =>
        store.recordOperationAttachment({ ...base, workerId: "w2", operationId, ordinal: 0, slackFileId: "F1", outcome: { attachment: image } }),
      ).toThrow("operation lease is missing");
      expect(() =>
        store.recordOperationAttachment({
          ...base,
          now: "2026-10-01T00:00:11.000Z",
          operationId,
          ordinal: 0,
          slackFileId: "F1",
          outcome: { attachment: image },
        }),
      ).toThrow("operation lease is missing");
      expect(store.listOperationAttachments(operationId)).toEqual([]);
    });
  });
});
