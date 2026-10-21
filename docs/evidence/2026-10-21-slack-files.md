# Slack files round trip (SLK-05), 2026-10-21

Actor types: `automated-real` and `automated-fixture` (sections 1–2). The human Slack round trip (section 3) is **PENDING**. SLK-05 stays `PENDING` until section 3 is filled in by a person in Slack.

## System under test

- Agent Tag commit `ee65b7e` (main, after PR-L1 #36 inbound files and PR-L2 #42 outbound files), macOS `26.6.2` arm64, Bun `1.3.13`
- T3 Code `0.0.45` release binary, run as a private loopback server on port `37893` with its own base directory and a restricted `orchestration:read orchestration:operate` token. It was started for this run and stopped and deleted afterward. The live service was not touched. No token, signed URL or raw T3 log was captured.

## 1. Live T3 transport (`automated-real`)

`AGENT_TAG_T3_URL=http://127.0.0.1:37893 AGENT_TAG_T3_TOKEN_FILE=<restricted token file> RUN_T3_INTEGRATION=1 bun test test/t3-live.integration.test.ts -t "attachments|agent files|probes the release"` passed 3 of 3 cases (22 assertions, 1.09 s; 7 other live cases filtered out):

1. Release probe and provider capability projection on `0.0.45` with the restricted token.
2. Inbound path: a text file and a PNG uploaded as pending T3 attachments download back byte for byte; deleting each makes the download fail.
3. Outbound path (PR-L2 Done 8): in a real T3 thread worktree, Agent Tag's reader returns `out/report.csv` and `out/chart.png` byte for byte and refuses `../repo/README.md` and a symlink pointing outside (`outside-workspace`). T3's own `workspace-file` asset serves the PNG but refuses the CSV and both escapes, which is why uploads read the worktree on disk.

## 2. Fixture suites (`automated-fixture`)

`bun test test/slack-files.test.ts test/slack-uploads.test.ts test/coordinator-files.test.ts test/attachments-store.test.ts test/slack-setup.test.ts`: 46 pass, 0 fail, 233 assertions. They cover PR-L Done 2–7: manifest scopes, a `file_share` with a PNG and a CSV reaching `thread.turn.start` as one image and one file attachment, replay after a crash re-uploading nothing, skips (sixth file, over size, external, image bytes that don't match), the directive stripped from the reply and delivered through Slack's external upload, and `../x`, `/etc/passwd`, `~/.ssh/id_rsa`, symlink escapes and a credential-shaped file never reaching Slack.

## 3. Human Slack round trip — PENDING

Run in workspace dhruv2mars (`T0BS9MA4BUP`), channel #agent-tag-test (`C0C2RHJ1BUP`), by an allowed user. Precondition: the live service runs a build at or after `efff6c1` (on 2026-10-21 it ran a pre-L1 build), and the installed app has `files:read` and `files:write` (`agent-tag doctor` shows no scope warning; both were added on 2026-10-21).

- Date / operator:
- Agent Tag build (commit SHA) and T3 provider/model:

| Step | Slack action | Expected | Observed |
| --- | --- | --- | --- |
| 1 | Mention Agent Tag with a small PNG and a CSV attached: "describe both files" | :eyes:, then a reply describing the image contents and the CSV columns | |
| 2 | Same thread: "write a CSV summary to out/summary.csv and share it" | Reply without the `[[agent-tag:upload …]]` line, then `summary.csv` posted in the thread after the reply | |
| 3 | Download `summary.csv` from Slack | Opens; content matches what the agent described | |
| 4 | Same thread: attach a file over `files.inbound.maxFileBytes` (or a denied extension) | Turn still runs; one notice names the skipped file and why | |

Also record: whether the `app_mention` event carried `files` or the `message`/`file_share` copy did (spec unconfirmed item), and the task's file-related audit rows from `bun run audit -- <config>` (IDs and codes only).
