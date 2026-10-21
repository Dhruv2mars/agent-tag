# Routines from Slack: live acceptance (J3, JOB-01 / ACL-01) — PENDING

Status: **pending the owner session.** The bot token must be reinstalled from the current manifest so it has `users:read` (profile time zones). That reinstall is batched into the single owner session (WAVES P1). Do not mark JOB-01 or ACL-01 `PASS` from the fixture suite.

Automated proof already on `main` (fake clock, real store, fake Slack): `bun test test/slack-routines.test.ts`.

Run only in the owner's own workspace (dhruv2mars), in a test channel and the owner's DM.

- Date / operator:
- Agent Tag build (commit SHA, `agent-tag --version`):
- Slack app reinstalled with `users:read` (yes/no, date):
- Owner's Slack profile time zone:
- Performed by: human / fixture

## 1. Transcript

| Step | Slack message | Expected | Observed (redacted IDs) |
| --- | --- | --- | --- |
| 1 | `@Agent Tag every weekday at 9am summarize open PRs` | One confirmation in the thread: "Routine scheduled", *When* in the profile zone, *Next*, *ID*, "Using your Slack time zone.", a Cancel routine button | |
| 2 | `@Agent Tag remind me in 10 minutes to check the deploy` | ":alarm_clock: I'll remind @you once on …"; the reminder arrives in the thread about 10 minutes later | |
| 3 | `@Agent Tag every day at 9am standup notes in Europe/London` | Confirmation names Europe/London | |
| 4 | `@Agent Tag list routines` (new thread) | "*Routines in this channel* (3 active)" with creators as names (no pings) and a Cancel routine button per row | |
| 5 | `@Agent Tag cancel routine <id from step 3>` | ":wastebasket: @you cancelled routine `…`" | |
| 6 | Click Cancel routine on the step 1 card, then Cancel routine in the confirmation | One notice in the thread; clicking again gives an only-you "no longer active" note and no second notice | |
| 7 | In the DM: `list routines` | "No routines in this DM yet." | |

## 2. Store and audit

- `agent-tag schedule-list` (or `sqlite3`): step 1 schedule has `time_zone` = the profile zone and `ended_reason = user-cancelled` after step 6:
- `slack_command_events` rows: `routine-create` ×3 succeeded, `routine-list` succeeded, `routine-cancel` succeeded:
- Audit: `slack.command.executed` per request, `schedule.created` for steps 1–3, `schedule.cancelled` for steps 5 and 6:

## Verdict

PASS / FAIL, with anything not verified listed explicitly.
