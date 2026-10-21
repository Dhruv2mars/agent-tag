# P2c live check: plain-language model switch from Slack (2026-10-21)

Actor type: `automated-real`. Real Slack and real T3, with injected human events (see "How"). This is not independent human acceptance.

## System under test

- Agent Tag branch `feat/p2c-model-switch-slack` (P2a and P2b on `main` plus P2c), Bun 1.3.13, macOS arm64.
- T3 Code `0.0.45` (pinned release binary), a private server on `127.0.0.1:37877` with its own base directory and a restricted `orchestration:read orchestration:operate` token. Providers `codex` and `claudeAgent` both reported ready. The live service and its T3 were not touched.
- Slack: the dhruv2mars workspace (`T0BS9MA4BUP`), the existing bot, private channel `#agent-tag-test` (`C0C2RHJ1BUP`).

## T3 gateway (PR-P2 Done 7)

`RUN_T3_INTEGRATION=1 AGENT_TAG_T3_URL=http://127.0.0.1:37877 AGENT_TAG_T3_TOKEN_FILE=<restricted token file> bun test test/t3-live.integration.test.ts -t "same driver in place|another driver with provider"`: 2 pass in 15.5 s.

1. Same driver, in place. A `claudeAgent` thread is started on `claude-haiku-4-5`. Then `thread.meta.update` sets `claude-sonnet-4-6`, and the next turn completes. The T3 snapshot `modelSelection` is `claudeAgent` / `claude-sonnet-4-6`, the reply is the expected text, and `lastError` is null.
2. Another driver is refused. A `turn.start` on that started `claudeAgent` thread asks for `codex` / `gpt-5.6-sol`.
   - T3 emits the activity `provider.turn.start.failed` with the detail `Thread '…' is bound to driver 'claudeAgent' and cannot switch to 'codex'.`
   - `classifyT3TurnFailure` maps it to `T3ModelSwitchRejected`.
   - The thread stays on `claude-haiku-4-5`.

So on 0.0.45, a model change within one driver can be applied to a started thread. A change of driver (provider) cannot. That is the rule P2c's Slack replies enforce. No other driver was tested.

## Slack (PR-P2 Done 4a-4e)

### How

`AGENT_TAG_LIVE=1 bun run scripts/live/p2c.ts --config <throwaway config> --actor U0BSJQXNZDH` runs Agent Tag's own service loops (`AgentTagService` with one coordinator given the T3 provider catalog, plus the outbox) through the real bot token, without Socket Mode. That way the live service on the same Slack app keeps receiving every event.

Each of the human's messages is posted in the thread as a labelled bot stand-in, `[p2c live …, as @Dhruv]`. It is then injected as the human's event at that `ts` through the real `handleSlackEvent`, which runs `SlackEventRouter` and then `SlackModelSwitch`. Every reply in Slack was posted by the real outbox.

The checks read Slack back (`conversations.replies`), the store, and the T3 thread snapshot.

The profile's default is `claudeAgent/claude-haiku-4-5`. Its allowlist is Haiku (`haiku`), Sonnet (`claude-sonnet-4-6`, `sonnet`) and Sol (`codex/gpt-5.6-sol`, `sol`).

Not covered here: Slack delivering these messages over Socket Mode to the service. Ingress is unchanged by P2c apart from the router step tested here. That path needs the live service upgraded to a P2c build.

### Result (run 5, all PASS)

Thread: [`1792571971.606119`](https://dhruv2marsworkspace.slack.com/archives/C0C2RHJ1BUP/p1792571971606119?thread_ts=1792571971.606119&cid=C0C2RHJ1BUP)

| Done | Message in Slack | Observed |
| --- | --- | --- |
| 4a pre-start | `@Agent Tag use sonnet: Reply with exactly: p2c-one` (new thread) | Reply: "Switched this thread to *Sonnet* (`claudeAgent/claude-sonnet-4-6`), requested by @Dhruv. The first turn will use it." The turn then ran and replied `p2c-one`. The T3 thread was created on `claudeAgent/claude-sonnet-4-6`. |
| 4e switch only | `switch to haiku` (plain reply, no mention) | Reply: "Switched this thread to *Haiku* (`claudeAgent/claude-haiku-4-5`), requested by @Dhruv." No new operation, so no turn ran. |
| 4b same driver | `@Agent Tag Reply with exactly: p2c-two` | The turn ran on Haiku and replied `p2c-two`. The T3 snapshot model is `claude-haiku-4-5`, `latestTurn` is `completed`, and `lastError` is null. |
| 4c other driver | `@Agent Tag use sol: Reply with exactly: p2c-three` | Reply: "This thread already started on *Haiku* (claudeAgent); T3 can't move a running conversation to *Sol*. Start a new thread with `@Agent Tag use sol: <request>` or say `@Agent Tag !restart` here for a fresh session (it won't remember this conversation), then switch. Your request was not started." No new operation. The desired model stays Haiku. Audit: `task.model.denied`. |
| 4d not allowed | `@Agent Tag use claude-opus-4-5` (T3 serves it; the profile does not allow it) | Reply: "*claude-opus-4-5* isn't allowed here. Allowed: *Haiku* (…), *Sonnet* (…), *Sol* (…). This thread stays on *Haiku*." Audit: `task.model.denied`. |
| prompt stays a prompt | `@Agent Tag use the README to tell me the project title, in five words or fewer` | No model-switch ledger row. It ran as a turn and replied `P2c Fixture`. |

No ephemeral errors were posted.

The audit trail for the run's thread: `task.model.selected` ×2 (4a, 4e), then `task.model.denied` ×2 (4c, 4d).

### Earlier runs

- Run 1 failed in two ways, both caused by the script:
  - It put a run label before `use sonnet:`, so the directive was not at the start of the message and the whole message ran as a prompt. This is correct behaviour.
  - That turn's retries then failed on a T3 project left over from an earlier attempt for the same repository root.
- Runs 2-3 reused that repository root with a wiped store, and T3 refused `project.create` ("Active project … already exists for workspace root").
- Run 4 ran 4a correctly but waited on the wrong operation status (`completed` instead of `succeeded`).

The script now labels only the stand-in, keeps its store between runs, and counts `succeeded`.
