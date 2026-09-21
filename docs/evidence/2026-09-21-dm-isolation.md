# DM isolation evidence, 2026-09-21

Actor type: `automated-fixture`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Runtime: Bun `1.3.13`
- Boundaries: config parser, production Slack router, SQLite task model, scoped memory, and coordinator prompt projection

## Checks run

A DM route must declare `conversationType: "dm"`, a single `ownerUserId`, a Slack conversation ID beginning with `D`, and a profile with private DM memory enabled. Configuration rejects an owner outside the workspace user allowlist, a DM route backed by a profile without private memory isolation, and duplicate routes for one conversation.

The Slack fixture sent an unmentioned top-level DM from the configured owner. It created one durable task marked `dm` and stored that owner's ID. A second otherwise allowed Slack user was denied before persistence, including when forging a threaded reply. Direct store calls that bypassed the Slack router also failed for a user-turn insert and task cancellation when the actor did not match the durable task owner. The configured owner could steer the same task thread.

The coordinator fixture created private memory for the DM owner and confirmed that memory reached the T3 turn as attributed, untrusted context because the durable task was a DM. Channel tasks continue to omit private memory. Schedules and memory task authorization now apply the same durable DM-owner check.

The example Slack manifest adds `im:history` and `message.im`, matching Slack's official [`message.im` event](https://api.slack.com/events/message.im) and [`im:history` scope](https://api.slack.com/scopes/im%3Ahistory) documentation.

The full local suite passed with 44 tests and one intentionally disabled live-T3 suite. This does not claim a live Slack DM, Slack Assistant thread behavior, group DMs, credential separation outside the existing profile policy, or a human privacy review.
