# Memory from Slack: live acceptance (K2, K3, MEM-01) — PENDING

Status: **pending the owner session.** Steps 1-7 need a human in Slack (PR-K §2-B); step 8 runs on the host right after. The running service must include K2 (a44d493) and the `agent-tag` binary must include K3 (`memory-*`). Do not mark MEM-01 `PASS` from the fixture suite.

Automated proof on `main` (fake clock, real store, fake Slack): `bun test test/slack-memory-commands.test.ts test/memory.test.ts`, and the operator CLI against a temp store: `bun test test/cli.test.ts -t "memory-"`. Live T3 (pinned 0.0.45): `RUN_T3_INTEGRATION=1 … bun test test/t3-live.integration.test.ts -t "reconciles one durable operation"` checks that a seeded channel note opens the thread's first T3 user message with `<agent-tag-memory updated="false">` and that the second turn carries no block.

Run only in the owner's own workspace (dhruv2mars, T0BS9MA4BUP): public routed channel, private channel C0C2RHJ1BUP, DM D0C4MK74G02. Record note refs, never note content beyond what is listed here.

- Date / operator:
- Agent Tag build (commit SHA, `agent-tag --version`):
- `channels:read` / `groups:read` on the installed app (yes/no):
- Performed by: human / fixture

## 1. Transcript

| Step | Slack message | Expected | Observed (redacted IDs) |
| --- | --- | --- | --- |
| 1 | `@Agent Tag remember for this channel: reports go out as tables` | "Saved to this channel's memory (`ref`)" in about 2 s; no "Agent Tag is working" message | |
| 2 | `@Agent Tag what do you remember?` | "*What I remember here*" lists the note with its author (no ping) and date | |
| 3 | New top-level `@Agent Tag summarize X` | The T3 thread's first user message holds `<agent-tag-memory>` with the note; the reply uses tables | |
| 4 | `@Agent Tag remember for the workspace: our default branch is main` (public channel) | "Saved to workspace memory"; a second routed channel lists it under *Workspace* | |
| 5 | Same phrase in the private channel | "Workspace notes can only be saved from a public channel…"; a channel note still saves there | |
| 6 | In the DM: `remember: I prefer terse replies` | "Saved to your DM memory"; not in the channel list, and the channel note not in the DM list | |
| 7 | `@Agent Tag forget <ref>` | "Forgot `ref`"; the next list no longer shows it | |

## 2. Store and audit (step 8, on the host)

Run right after step 7, with the same CONFIG the service uses:

```sh
agent-tag memory-list CONFIG                  # every note above, with its store (channel/workspace/dm)
agent-tag memory-list CONFIG --json > /tmp/memory.json
agent-tag audit CONFIG > /tmp/audit.jsonl
bun run audit:verify -- CONFIG                # the live audit verifier (docs/evidence/2026-09-29-live-audit.md)
```

Record note content as hashes only: `jq -r '.[] | "\(.ref) \(.store) \(.content | @sh)"' /tmp/memory.json` lists the notes; write each one here as `ref store sha256:<first 12 hex of printf %s CONTENT | shasum -a 256>`.

- `memory-list` (ref, store, where, author; content as SHA-256 prefix): the step 1 channel note, the step 4 workspace note, the step 5 channel note in the private channel, the step 6 DM note; the step 7 note absent:
- `slack_command_events` rows: `memory-remember`, `memory-list`, `memory-forget`, one per Slack message:
- Audit action counts (`memory.created`, `memory.forgotten`, `memory.denied` from step 5, `slack.command.executed` per message):
- `grep -c` of each note's text in `/tmp/audit.jsonl` (all must be 0):
- `audit:verify` output (record total, zero private-content matches):

## Verdict

PASS / FAIL, with anything not verified listed explicitly.
