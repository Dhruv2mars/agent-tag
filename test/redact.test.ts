import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containsKnownSecret, knownSecretClasses, redactAuditMetadata, redactSecrets } from "../src/security/redact.ts";
import { AgentTagStore } from "../src/store/store.ts";

const slackToken = `xoxb-${"A1".repeat(15)}`;
const githubToken = `ghp_${"b".repeat(36)}`;

test("redacts every known credential shape and keeps surrounding text", () => {
  const input = `bot ${slackToken} and ${githubToken} twice ${slackToken}`;
  const redacted = redactSecrets(input);
  expect(redacted).toBe(
    "bot [REDACTED:slack-token] and [REDACTED:github-token] twice [REDACTED:slack-token]",
  );
  expect(redactSecrets("no credentials here")).toBe("no credentials here");
  expect(containsKnownSecret(input)).toBe(true);
  expect(containsKnownSecret(redacted)).toBe(false);
  expect(knownSecretClasses(input)).toEqual(["slack-token", "github-token"]);
});

test("redacts only string audit metadata values", () => {
  expect(redactAuditMetadata({ errorCode: `leak ${slackToken}`, attempt: 2, retryable: false, none: null })).toEqual({
    errorCode: "leak [REDACTED:slack-token]",
    attempt: 2,
    retryable: false,
    none: null,
  });
});

test("the store redacts credentials before any audit row is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-tag-redact-"));
  const store = await AgentTagStore.open(join(directory, "agent-tag.sqlite"));
  try {
    store.ingestSlackEvent({
      deliveryId: "delivery-1",
      eventKey: `C1:${slackToken}`,
      workspaceId: "T1",
      conversationId: "C1",
      threadTs: "1000.0001",
      actorUserId: "U1",
      conversationType: "channel",
      profileId: "engineering",
      repositoryRoot: "/srv/repos/example",
      text: "hello",
      receivedAt: "2026-09-21T00:00:00.000Z",
    });
    const serialized = JSON.stringify(store.listAuditRecords());
    expect(serialized).toContain("[REDACTED:slack-token]");
    expect(serialized).not.toContain(slackToken);
  } finally {
    store.close();
    if (!directory.startsWith(`${tmpdir()}/agent-tag-redact-`)) {
      throw new Error(`refusing to remove unexpected fixture path ${directory}`);
    }
    await rm(directory, { recursive: true });
  }
});
