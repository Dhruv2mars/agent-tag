import { describe, expect, test } from "bun:test";

import {
  fetchThreadWindow,
  type FetchThreadWindowInput,
  selectThreadWindow,
  SlackContextUnavailable,
  type SlackRepliesPage,
  type ThreadContextPolicy,
  type ThreadWindow,
  type ThreadWindowContext,
} from "../src/slack/context.ts";

const ROOT_TS = "1000.000000";

const POLICY: ThreadContextPolicy = {
  maxMessages: 30,
  maxChars: 12_000,
  maxMessageChars: 2_000,
  includeBotMessages: "root-only",
  includeNonAllowedUsers: true,
};

function ts(index: number): string {
  return `1000.${String(index).padStart(6, "0")}`;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

function threadContext(policy: Partial<ThreadContextPolicy> = {}): ThreadWindowContext {
  return {
    rootTs: ROOT_TS,
    botUserId: "UBOT",
    selfBotId: "BSELF",
    allowedUserIds: ["U0A1", "U0B2"],
    policy: { ...POLICY, ...policy },
  };
}

const ROOT = { ts: ROOT_TS, user: "U0A1", text: "root message" };

function human(index: number, user = "U0A1", extra: Record<string, unknown> = {}) {
  return { ts: ts(index), user, text: `reply ${index}`, ...extra };
}

function timestamps(window: ThreadWindow): string[] {
  return window.messages.map((message) => message.ts);
}

function ascending(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

interface RecordedCall {
  readonly args: Parameters<SlackRepliesPage>[0];
  readonly signal: AbortSignal | undefined;
}

/** A fake `conversations.replies`: `respond` receives the zero-based call index. */
function recorder(respond: (call: number, signal: AbortSignal | undefined) => unknown) {
  const calls: RecordedCall[] = [];
  const replies: SlackRepliesPage = async (args, signal) => {
    calls.push({ args, signal });
    return respond(calls.length - 1, signal);
  };
  return { replies, calls };
}

function page(messages: unknown[], nextCursor?: string) {
  return {
    ok: true,
    messages,
    ...(nextCursor === undefined ? {} : { response_metadata: { next_cursor: nextCursor } }),
  };
}

function rateLimited(retryAfter: number): Error {
  return Object.assign(new Error("rl"), { code: "slack_webapi_rate_limited_error", retryAfter });
}

function fetchInput(replies: SlackRepliesPage, overrides: Partial<FetchThreadWindowInput> = {}): FetchThreadWindowInput {
  return {
    ...threadContext(),
    replies,
    channel: "C1",
    beforeTs: "1000.999999",
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function expectUnavailable(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(SlackContextUnavailable);
  expect((error as SlackContextUnavailable).code).toBe(code);
}

describe("selectThreadWindow", () => {
  test("drops the agent's own messages by user ID and by self bot ID", () => {
    const window = selectThreadWindow(
      [
        ROOT,
        { ts: ts(1), user: "UBOT", text: "agent reply" },
        { ts: ts(2), bot_id: "BSELF", text: "agent reply via bot id" },
        human(3),
      ],
      threadContext(),
    );
    expect(timestamps(window)).toEqual([ROOT_TS, ts(3)]);
    expect(window.omitted).toBe(0);
  });

  test("root-only keeps a bot-authored root and drops bot replies", () => {
    const botRoot = { ts: ROOT_TS, bot_id: "B0C3", bot_profile: { name: "Ops Alerts" }, text: "deploy failed" };
    const botReply = { ts: ts(1), bot_id: "B0C3", bot_profile: { name: "Ops Alerts" }, text: "retrying" };
    const window = selectThreadWindow([botRoot, botReply, human(2)], threadContext({ includeBotMessages: "root-only" }));
    expect(timestamps(window)).toEqual([ROOT_TS, ts(2)]);
    expect(window.messages[0]).toMatchObject({
      ts: ROOT_TS,
      speakerKind: "bot",
      speakerId: "B0C3",
      speakerLabel: "Ops Alerts",
      steeringAllowed: false,
      isRoot: true,
    });
  });

  test("none drops the bot root too, and all keeps bot replies", () => {
    const botRoot = { ts: ROOT_TS, bot_id: "B0C3", bot_profile: { name: "Ops Alerts" }, text: "deploy failed" };
    const botReply = { ts: ts(1), bot_id: "B0C3", bot_profile: { name: "Ops Alerts" }, text: "retrying" };

    const none = selectThreadWindow([botRoot, botReply, human(2)], threadContext({ includeBotMessages: "none" }));
    expect(timestamps(none)).toEqual([ts(2)]);
    expect(none.messages[0]?.isRoot).toBe(false);

    const all = selectThreadWindow([botRoot, botReply, human(2)], threadContext({ includeBotMessages: "all" }));
    expect(timestamps(all)).toEqual([ROOT_TS, ts(1), ts(2)]);
    expect(all.messages[1]).toMatchObject({ speakerKind: "bot", speakerId: "B0C3", steeringAllowed: false, isRoot: false });
  });

  test("subtype bot_message without bot_id counts as a bot, using the user field as its ID", () => {
    const hookRoot = { ts: ROOT_TS, subtype: "bot_message", user: "UWEBHOOK", text: "hook root" };
    const hookReply = { ts: ts(1), subtype: "bot_message", user: "UWEBHOOK", text: "hook reply" };

    const rootOnly = selectThreadWindow([hookRoot, hookReply], threadContext({ includeBotMessages: "root-only" }));
    expect(timestamps(rootOnly)).toEqual([ROOT_TS]);
    expect(rootOnly.messages[0]).toMatchObject({ speakerKind: "bot", speakerId: "UWEBHOOK", steeringAllowed: false });

    const none = selectThreadWindow([hookRoot, hookReply], threadContext({ includeBotMessages: "none" }));
    expect(none.messages).toEqual([]);

    const all = selectThreadWindow([hookRoot, hookReply], threadContext({ includeBotMessages: "all" }));
    expect(all.messages[1]).toMatchObject({ ts: ts(1), speakerKind: "bot", speakerId: "UWEBHOOK" });
  });

  test("non-allowed humans are context without steering, unless excluded by policy", () => {
    const included = selectThreadWindow(
      [ROOT, human(1, "U0D4"), human(2, "U0B2")],
      threadContext({ includeNonAllowedUsers: true }),
    );
    expect(included.messages.map((message) => [message.ts, message.steeringAllowed])).toEqual([
      [ROOT_TS, true],
      [ts(1), false],
      [ts(2), true],
    ]);

    const excluded = selectThreadWindow(
      [ROOT, human(1, "U0D4"), human(2, "U0B2")],
      threadContext({ includeNonAllowedUsers: false }),
    );
    expect(timestamps(excluded)).toEqual([ROOT_TS, ts(2)]);
  });

  test("a non-allowed root is kept even when non-allowed users are excluded", () => {
    const window = selectThreadWindow(
      [{ ts: ROOT_TS, user: "U0D4", text: "root from outsider" }, human(1, "U0D4"), human(2, "U0A1")],
      threadContext({ includeNonAllowedUsers: false }),
    );
    expect(timestamps(window)).toEqual([ROOT_TS, ts(2)]);
    expect(window.messages[0]).toMatchObject({ isRoot: true, steeringAllowed: false, speakerId: "U0D4" });
  });

  test("keeps only the supported subtypes", () => {
    const kept = [undefined, "thread_broadcast", "file_share", "me_message"];
    const dropped = ["channel_join", "tombstone", "message_deleted"];
    const raw = [
      ROOT,
      ...kept.map((subtype, offset) => human(offset + 1, "U0A1", subtype === undefined ? {} : { subtype })),
      ...dropped.map((subtype, offset) => human(offset + 1 + kept.length, "U0A1", { subtype })),
    ];
    const window = selectThreadWindow(raw, threadContext());
    expect(timestamps(window)).toEqual([ROOT_TS, ts(1), ts(2), ts(3), ts(4)]);
  });

  test("file names come from name, else title", () => {
    const window = selectThreadWindow(
      [ROOT, human(1, "U0A1", { subtype: "file_share", files: [{ name: "a.png" }, { title: "b.csv" }] })],
      threadContext(),
    );
    expect(window.messages[1]?.fileNames).toEqual(["a.png", "b.csv"]);
  });

  test("caps each message at maxMessageChars code points, ending with an ellipsis", () => {
    const ascii = selectThreadWindow([ROOT, { ts: ts(1), user: "U0A1", text: "a".repeat(5_000) }], threadContext({ maxMessageChars: 200 }));
    const capped = ascii.messages[1]?.text ?? "";
    expect(codePoints(capped)).toBe(200);
    expect(capped).toBe(`${"a".repeat(199)}…`);

    const emoji = selectThreadWindow([ROOT, { ts: ts(1), user: "U0A1", text: "😀".repeat(5_000) }], threadContext({ maxMessageChars: 200 }));
    const cappedEmoji = emoji.messages[1]?.text ?? "";
    expect(codePoints(cappedEmoji)).toBe(200);
    expect(cappedEmoji.endsWith("…")).toBe(true);
  });

  test("maxChars keeps the root and the newest replies that fit, in chronological order", () => {
    const raw = [
      { ts: ROOT_TS, user: "U0A1", text: "r".repeat(500) },
      ...range(1, 10).map((index) => ({ ts: ts(index), user: "U0A1", text: "x".repeat(400) })),
    ];
    const window = selectThreadWindow(raw, threadContext({ maxChars: 2_500, maxMessageChars: 1_000 }));
    expect(timestamps(window)).toEqual([ROOT_TS, ts(6), ts(7), ts(8), ts(9), ts(10)]);
    expect(window.omitted).toBe(5);
    expect(window.truncated).toBe(false);
    const total = window.messages.reduce((sum, message) => sum + codePoints(message.text), 0);
    expect(total).toBeLessThanOrEqual(2_500);
    expect(ascending(timestamps(window))).toBe(true);
    expect(window.messages[0]?.isRoot).toBe(true);
  });

  test("maxMessages keeps the root and the newest replies, counting omissions", () => {
    const raw = [ROOT, ...range(1, 299).map((index) => human(index, index % 2 === 0 ? "U0B2" : "U0A1"))];
    const window = selectThreadWindow(raw, threadContext({ maxMessages: 30 }));
    expect(window.messages).toHaveLength(30);
    expect(window.messages[0]?.isRoot).toBe(true);
    expect(timestamps(window).slice(1)).toEqual(range(271, 299).map(ts));
    expect(window.omitted).toBe(270);
    expect(window.truncated).toBe(false);
  });

  test("sorts unordered input, ignores unparseable entries, and flags edited messages", () => {
    const raw = [
      human(3),
      ROOT,
      human(1),
      null,
      "junk",
      42,
      { text: "missing ts", user: "U0A1" },
      { ts: "not-a-timestamp", user: "U0A1", text: "bad ts" },
      human(2, "U0A1", { edited: { ts: "1000.000500" } }),
    ];
    const window = selectThreadWindow(raw, threadContext());
    expect(timestamps(window)).toEqual([ROOT_TS, ts(1), ts(2), ts(3)]);
    expect(window.messages.map((message) => message.edited)).toEqual([false, false, true, false]);
  });
});

describe("fetchThreadWindow", () => {
  test("pages with a cursor, sends the expected arguments, and does not duplicate the root", async () => {
    const { replies, calls } = recorder((call) => {
      if (call === 0) return page([ROOT, ...range(1, 100).map((index) => human(index))], "cur-1");
      if (call === 1) return page([ROOT, ...range(101, 200).map((index) => human(index))], "cur-2");
      return page([ROOT, ...range(201, 299).map((index) => human(index))]);
    });

    const window = await fetchThreadWindow(fetchInput(replies));

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toMatchObject({ channel: "C1", ts: ROOT_TS, latest: "1000.999999", inclusive: false, limit: 200 });
    }
    expect(Object.keys(calls[0]?.args ?? {})).not.toContain("cursor");
    expect(calls[1]?.args.cursor).toBe("cur-1");
    expect(calls[2]?.args.cursor).toBe("cur-2");

    expect(window.messages.filter((message) => message.isRoot)).toHaveLength(1);
    expect(window.messages).toHaveLength(30);
    expect(window.messages[0]?.isRoot).toBe(true);
    expect(timestamps(window).slice(1)).toEqual(range(271, 299).map(ts));
    expect(window.omitted).toBe(270);
    expect(window.truncated).toBe(false);
  });

  test("keeps the newest replies by ts even if pages arrive newest first", async () => {
    const { replies } = recorder((call) => {
      if (call === 0) return page([ROOT, ...range(201, 299).map((index) => human(index))], "cur-1");
      if (call === 1) return page([ROOT, ...range(101, 200).map((index) => human(index))], "cur-2");
      return page([ROOT, ...range(1, 100).map((index) => human(index))]);
    });

    const window = await fetchThreadWindow(fetchInput(replies));

    expect(timestamps(window).slice(1)).toEqual(range(271, 299).map(ts));
    expect(window.omitted).toBe(270);
  });

  test("stops at maxPages and reports the thread as truncated", async () => {
    const { replies, calls } = recorder((call) => page([ROOT, human(call + 1)], "more"));

    const window = await fetchThreadWindow(fetchInput(replies, { maxPages: 2 }));

    expect(calls).toHaveLength(2);
    expect(window.truncated).toBe(true);
    expect(timestamps(window)).toEqual([ROOT_TS, ts(1), ts(2)]);
  });

  test("has_more without a cursor is reported as truncated", async () => {
    const { replies, calls } = recorder(() => ({ ...page([ROOT, human(1)]), has_more: true }));

    const window = await fetchThreadWindow(fetchInput(replies));

    expect(calls).toHaveLength(1);
    expect(window.truncated).toBe(true);
    expect(timestamps(window)).toEqual([ROOT_TS, ts(1)]);
  });

  test("has_more false on the last page is complete", async () => {
    const { replies } = recorder(() => ({ ...page([ROOT, human(1)]), has_more: false }));

    expect((await fetchThreadWindow(fetchInput(replies))).truncated).toBe(false);
  });

  test("a Slack error object rejects with its error code and is not retried", async () => {
    const { replies, calls } = recorder(() => ({ ok: false, error: "channel_not_found" }));

    const error = await rejectionOf(fetchThreadWindow(fetchInput(replies)));

    expectUnavailable(error, "channel_not_found");
    expect(calls).toHaveLength(1);
  });

  test("a rate-limited page with a short retryAfter is retried once after sleeping", async () => {
    const sleeps: number[] = [];
    const sleep = async (milliseconds: number): Promise<void> => {
      sleeps.push(milliseconds);
    };
    const { replies, calls } = recorder((call) => {
      if (call === 0) throw rateLimited(1);
      return page([ROOT, human(1)]);
    });

    const window = await fetchThreadWindow(fetchInput(replies, { sleep }));

    expect(sleeps).toEqual([1_000]);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1]?.args ?? {})).not.toContain("cursor");
    expect(timestamps(window)).toEqual([ROOT_TS, ts(1)]);
  });

  test("a second rate limit after the retry rejects as ratelimited", async () => {
    const sleeps: number[] = [];
    const sleep = async (milliseconds: number): Promise<void> => {
      sleeps.push(milliseconds);
    };
    const { replies, calls } = recorder(() => {
      throw rateLimited(1);
    });

    const error = await rejectionOf(fetchThreadWindow(fetchInput(replies, { sleep })));

    expectUnavailable(error, "ratelimited");
    expect(sleeps).toEqual([1_000]);
    expect(calls).toHaveLength(2);
  });

  test("a long retryAfter rejects as ratelimited immediately without sleeping", async () => {
    const sleeps: number[] = [];
    const sleep = async (milliseconds: number): Promise<void> => {
      sleeps.push(milliseconds);
    };
    const { replies, calls } = recorder(() => {
      throw rateLimited(30);
    });

    const error = await rejectionOf(fetchThreadWindow(fetchInput(replies, { sleep })));

    expectUnavailable(error, "ratelimited");
    expect(sleeps).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a read that never settles rejects as timeout", async () => {
    const { replies } = recorder(() => new Promise(() => {}));

    const error = await rejectionOf(fetchThreadWindow(fetchInput(replies, { timeoutMs: 20 })));

    expectUnavailable(error, "timeout");
  });

  test("an external abort propagates its reason and is not reported as unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const { replies } = recorder(() => new Promise(() => {}));

    const promise = fetchThreadWindow(fetchInput(replies, { signal: controller.signal, timeoutMs: 5_000 }));
    setTimeout(() => controller.abort(reason), 10);

    const error = await rejectionOf(promise);

    expect(error).toBe(reason);
    expect(error).not.toBeInstanceOf(SlackContextUnavailable);
  });

  test("a malformed response rejects as invalid_response", async () => {
    const { replies } = recorder(() => ({ ok: true, messages: "x" }));

    const error = await rejectionOf(fetchThreadWindow(fetchInput(replies)));

    expectUnavailable(error, "invalid_response");
  });
});
