# Memory from Slack: live acceptance (K2, MEM-01) — PENDING

Status: **pending the owner session.** Steps 1-7 need a human in Slack (PR-K §2-B). The running service must include K2. Step 8 (`agent-tag memory-list`, audit verifier) lands with K3. Do not mark MEM-01 `PASS` from the fixture suite.

Automated proof already on `main` (fake clock, real store, fake Slack): `bun test test/slack-memory-commands.test.ts`.

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

## 2. Store and audit

- `slack_command_events` rows: `memory-remember`, `memory-list`, `memory-forget`, one per Slack message:
- Audit: `slack.command.executed` per message, `memory.created`, `memory.forgotten`, `memory.denied` (step 5), with no note content:

## Verdict

PASS / FAIL, with anything not verified listed explicitly.
