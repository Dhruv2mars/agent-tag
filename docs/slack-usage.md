# Using Agent Tag in Slack

Agent Tag is a coworker in Slack that hands work to a coding agent (Codex or Claude, through T3 Code) on your team's host. This page is for the people who talk to it. Operators set it up with [Slack setup](slack-setup.md) and run it with [operations](operations.md).

## Starting work

- **Mention it** in a channel it was added to: `@Agent Tag fix the flaky test in src/store`. The mention starts a task, and the thread is that task.
- **Reply in the thread** to steer the same task. Replies from allowed people need no mention; each one becomes the next turn, in order.
- **DM it** in its Messages tab if the operator routed your DM. A DM needs no mention, and only you can use your DM.
- Who may use it is set by the operator: listed people only (`allowlist`), or any member of the channel (`channel-members`). Bots can't start or approve work. Guests can't either, unless the operator lets them steer (`access.membership.guests: "steer-only"`, which still never lets them approve) or lists them by user ID.

## What you see

Agent Tag reacts with :eyes: as soon as it accepts a mention, even when it is busy with other work.

Each turn gets one status message in the thread (no extra scope: `chat:write` covers `chat.update`). While the turn runs it shows the agent's plan, its last few tool lines and a **Stop** button; when the turn ends it is edited in place to `Done in 3m 12s` (plus `· 4 files changed` when T3 recorded a diff), `Stopped by @user`, `Failed` or `Expired`, and the Stop button is removed. Any allowed user can press Stop in an allowed channel (in a DM, only its owner), and the audit log records who did. Edits are throttled to one per `slack.ui.statusUpdateIntervalMs` (default 2000, minimum 1000) per message and `slack.ui.statusUpdatesPerMinute` (default 40) progress edits across all messages; the final edit is never delayed by the budget. Tool lines can contain shell commands and file paths; set `slack.ui.statusProgress` to `false` to show only the headline and the Stop button.

The last message of each final reply ends with a small footer naming the model and provider instance that answered and how long the turn took, e.g. `gpt-5.6-sol · codex · 3m 12s`. The model comes from the T3 thread, so a per-thread model switch shows up there. Set `slack.ui.footer` to `"none"` to leave replies plain.

## Commands

A message that starts with `@Agent Tag !<command>` runs a command instead of a request. In a DM route the owner can drop the mention and send `!status` directly. The command word must come right after the mention; `@Agent Tag please !help` is an ordinary request.

| Command | Where | What it does |
| --- | --- | --- |
| `!help` | anywhere | Lists the commands enabled here. Only the sender sees it. |
| `!status` | anywhere | In a thread: whether the agent is working, waiting on an approval or question, or has requests queued, plus the thread's model and mute state. At the top level: a count across the channel's threads. Only the sender sees it. |
| `!mute` | a thread the agent is part of | Stops the agent answering unmentioned replies in that thread. Posts a public notice. |
| `!unmute` | a thread the agent is part of | Reverses `!mute`. Any message that mentions the agent in a muted thread also unmutes it. |
| `!stop` | a thread the agent is working in | Stops the running turn, the same way as the status message's Stop button: the status message turns into "Stopped by @you". Requests in that thread sent before `!stop` and not started yet are dropped, with one public note saying how many. Requests sent after it still run. |
| `!restart` | a thread the agent is part of | Starts a fresh T3 session for the thread: a new T3 thread on a new worktree branch (`agent-tag/<task>-g2`, `-g3`, ...) from the profile's base branch. With nothing running it happens at once. Requests queued before `!restart` are dropped, and its notice says how many. Otherwise the running turn is stopped first, new messages wait, and the agent confirms in the thread once the fresh session is ready (after at most `commands.restartTimeoutSeconds`, default 120; past that the old turn may still post a late reply; if its worker restarts, the agent says it stopped that request instead of resuming it on the fresh session, and the old T3 thread's session is stopped once the turn ends). The first request on the fresh session rereads the earlier thread messages (without `!commands` and the agent's own replies) when `threadContext` is enabled. |

An operator can turn commands off or limit some to admins; see [operations](operations.md#commands).

## Managing memory from Slack

Mention the bot, write in your DM with it, or reply in a thread it is part of:

| Say | What happens |
|---|---|
| `remember: …` or `remember for this channel: …` | Saves a channel note (a DM note in a DM) and replies with its 8-character ref |
| `remember for the workspace: …` | Saves a workspace note; only from a public channel |
| `what do you remember?` or `!memory` | Lists this conversation's notes, workspace notes and operator notes, with author and date |
| `forget a1b2c3d4` | Forgets the note with that ref |
| `forget: deploy` | Forgets the one note here whose text contains "deploy", or lists the candidates |
| `update memory a1b2c3d4: …` | Replaces the note's text and bumps its version |

A colon or a `!` is always required, so sentences like "remember that outage last week?" or "forget it" stay ordinary requests. Unmentioned top-level channel messages are never memory commands. `!remember …`, `!remember --workspace …`, `!forget <ref>` and `!memory edit <ref> …` work too.

These phrases never start a T3 turn and reply in the thread. Each Slack message runs at most once: the note, its reply and its `slack_command_events` row (kinds `memory-remember|list|forget|edit`) commit together, so a redelivery or the duplicate `message` event for one mention is answered once. A ref for a note from another channel, or another person's DM, answers "I don't have a note … here". Workspace notes are read-only outside public channels, and operator notes are read-only from Slack. An operator can set `memory.slackCommands: false` on a profile to send every phrase to the agent instead. How notes are stored, scoped and kept is in [operations](operations.md#memory).

## Switching models from Slack

Mention the bot, write in your DM with it, or reply in a thread it is part of:

| Say | What happens |
|---|---|
| `use opus` | Switches this thread to Opus and replies in the thread; no turn runs |
| `use opus: fix the flaky test` | Switches, then runs the request on the new model |
| `switch to gpt-5.6-mini`, `change the model to sonnet` | Same as `use …` |
| `use Opus 5.5 for the rest of this thread` | Same; the tail is optional |
| `model: sonnet` | Same |

A model is named by its alias, label, slug, or `instance/model`. The directive ends at a `:`, `,`, `;`, `.`, `—` or a new line; anything after it is the request. A message only counts as a switch when the words right after the verb name a model, so "use the README to fix the install docs" or "switch to dark mode" stay ordinary requests. Unmentioned top-level channel messages, including ambient ones, are never parsed. `!commands` come first, then a switch, then memory phrases, then the request.

The choice belongs to the thread and lasts for the rest of it, across closing, reopening and `!restart`. `!status` shows the model the next turn will use. Each Slack message switches at most once: the choice, its `task.model.selected` audit row, the reply, its `slack_command_events` row (kind `model-switch`) and any request after it commit together, so a redelivery or the duplicate `message` event for one mention is answered once.

Refusals reply in the thread, say which model the thread stays on, and are audited as `task.model.denied` with a code. A request that came with a refused switch is not run:

- a name outside the allowlist (`not-allowed`, the reply lists what is allowed) or one that matches several entries (`ambiguous`);
- a provider T3 doesn't report as ready (`unavailable`);
- switching turned off (`switch-disabled`) or `crossProvider: "deny"` (`cross-provider-denied`).

A name that is neither an allowed model nor a model T3 reports (say `use sonnet` when no allowed entry is called that) is not a switch, so the whole message runs as a request on the thread's current model.

### The cross-provider rule

T3 0.0.45 keeps a started conversation on its provider's session, so Agent Tag only moves a started thread where T3 can follow it:

- **Before the first turn** (a new thread, or a closed one whose next request starts a fresh session) any allowed model works, and the first turn starts on it.
- **On a started thread** the switch must stay on the same driver and the same resume state (for example `codex` to `codex`, not `codex` to `codex-work` with another home). It is applied in place with `thread.meta.update` before the next turn.
- **Anything else** is refused (`cross-provider-started`, or `requires-new-thread` for a driver that needs a new thread for any model change, or `incompatible-continuation`). The reply offers a new thread (`@Agent Tag use opus: <request>`) or, when `!restart` is enabled for the person, `!restart` in the thread followed by the switch. A fresh session does not remember the conversation.

A turn already sent to T3 counts as started, even before its reply arrives. If T3 still rejects a switch at turn time, the thread keeps the model it had and says so (`task.model.reverted`). When a config change removes a thread's model from the allowlist, the next turn falls back to the default only when T3 can make that move, and otherwise stays on what the thread already runs; both are audited as `task.model.reverted`.

Tested live on T3 0.0.45: the `codex` and `claudeAgent` drivers ([evidence](evidence/2026-10-21-model-switch.md)). Other drivers (for example `grok` or `opencode`) follow the capabilities T3 reports for them but have not been run live.

## Routines from Slack

Mention the bot (or write in your DM with it) to manage routines in that conversation:

- **Create:** `@Agent Tag every weekday at 9am summarize open PRs`, `@Agent Tag remind me tomorrow at 3pm to deploy`, `@Agent Tag schedule tomorrow at 3pm: run the release checklist`. A one-off agent run needs the `schedule` lead; a recurring lead (`every`, `daily`, `weekdays`, …) or `remind` is enough otherwise. The routine binds to the thread it was requested in, and its results post there.
- **List:** `@Agent Tag list routines` shows the conversation's active routines (up to 20, each with a Cancel button) and any turned off for repeated failures in the last 7 days.
- **Cancel:** `@Agent Tag cancel routine a1b2c3` (the ID from the confirmation or list), `cancel routine 2` (list number), `cancel this routine` (in the routine's thread), `cancel the reminder about deploys` (prompt text), or the Cancel button on any confirmation or list.

Times use the requester's Slack profile time zone (`users.info` `tz`, needs `users:read`). Name a zone to override it (`… at 9am in Europe/London`, `9am PT`). Without `users:read`, or when the profile has no zone, `routines.defaultTimeZone` (default `UTC`) applies and the confirmation says so. Unmentioned channel messages and ambient triggers are never treated as routine requests. A free-text cancel that matches no routine ("remove the schedule field from the API") stays a normal prompt.

Anyone allowed in a shared channel can list and cancel that channel's routines. DM routines belong to the DM owner. A Socket Mode redelivery or the duplicate `message` event for one mention is answered once.

## Draft pull requests

When the operator has turned them on for a repository, a request that changes code ends with a draft PR card, and follow-ups in the thread push to the same PR. Setup is in [operations](operations.md#github-pull-requests-draft-prs-auto-mode).

## Files

`files:read` lets Agent Tag read files shared in a mention, or in a reply in a thread it follows, and attach them to that turn in T3. Each file is looked up with `files.info` and downloaded from `files.slack.com` with the bot token (redirects are followed only to Slack hosts, and the token is never sent anywhere else). PNG, JPEG, GIF and WebP files, identified by their bytes rather than their declared type, are sent as images; everything else is sent as a file. `files.inbound` in the config sets the limits: `maxFilesPerMessage` (default 5, at most 8), `maxImageBytes` (default and maximum 10 MiB; a larger image is sent as a file), `maxFileBytes` (default 25 MiB, at most 50 MiB), `deniedExtensions` (lowercase, without the dot) and `enabled`. A file over a limit, stored outside Slack, deleted, a canvas, of a denied type, or declared as an image whose bytes are not that image is skipped: the turn still starts, the model is told which files were skipped and why, and the thread gets one notice listing them. Each outcome is recorded, so a retried turn never uploads a file twice. An app installed before this scope existed must be reinstalled from the updated manifest; until then shared files are skipped with a note that the app lacks the permission, and `agent-tag doctor` warns about the missing scope.

`files:write` lets the agent share files it wrote back to the thread. Each turn's text tells the agent to end its reply with one line per file, `[[agent-tag:upload out/report.csv]]` (optionally followed by a quoted title). Agent Tag removes those lines from the reply, posts the reply, then reads each file from the task's T3 worktree and uploads it to the same thread with Slack's external upload flow (`files.getUploadURLExternal`, then `files.completeUploadExternal`). Paths outside the worktree, hidden files (any path part starting with `.`), files over the limit and files containing a known credential shape are not shared; the thread gets a short notice naming each one and why. `files.outbound` sets `maxFilesPerTurn` (default 5, at most 10), `maxFileBytes` (default 25 MiB, at most 50 MiB), `scanForSecrets` (default `true`) and `enabled`. Slack rate limits and network errors are retried with backoff; after a crash, Agent Tag asks Slack (`files.info`, which needs `files:read`) whether a file already reached the thread before uploading it again. Without `files:write` each file fails once with a notice asking the operator to reinstall the app.

## What Agent Tag sees

`users:read` lets Agent Tag call `users.info` to show the model who is speaking, as `Alice Chen (U0A1)`, and to render `<@U0A1>` mentions as names. `users:read.email` is not requested, and no email address is read. Names are cached in memory for one hour and are never written to the database, except inside the frozen text of a turn already sent to T3. The same lookup supplies the requester's profile time zone (`tz`) for routines created from Slack; a routine stores the zone it was created in.

If the bot token lacks `users:read` (an app installed before this scope was added), Agent Tag logs one `slack.users.disabled` warning with `errorCode: "missing_scope"` per process and keeps working with raw user IDs such as `U0A1`. Routines then use `routines.defaultTimeZone` and say so in the confirmation. Reinstall the app from the updated manifest to restore names and profile time zones. A failed or slow lookup for one user also falls back to the ID and is retried after five minutes. Name lookups for one turn stop after at most five seconds (a quarter of the operation lease if that is shorter) and resolve at most 50 users; anyone not resolved by then appears as a raw ID.

Each turn sent to T3 starts with `Slack message from <name> (<user ID>):`, or `Scheduled routine run (created by <name> (<user ID>)):` for a routine. The user ID is always present, so two people with the same display name stay distinct. Display names are treated as untrusted: control, bidirectional and zero-width characters, Slack markup characters, and line breaks are removed, parentheses become brackets so a name cannot imitate the `(U…)` suffix, and names are capped at 64 characters. A line of message text that looks like Agent Tag framing (`Slack message from …`, `Scheduled routine run …`, `[Agent Tag …`, `Agent Tag reference memory …`, or an `<agent-tag-memory>` tag) is prefixed with `\` so it cannot pass for a header. Scheduled routine prompts are plain text and are sent verbatim, apart from that escaping; Slack markup and entities in them are not interpreted. The text is frozen on first dispatch, so retries resend identical text without calling Slack.

When someone mentions Agent Tag partway into an existing thread, the first turn also carries a window of the thread's earlier messages, read with `conversations.replies` (covered by the existing `channels:history`, `groups:history` and `im:history` scopes). The window holds the thread's first message plus the newest replies before the mention: at most `threadContext.maxMessages` messages (default 30) and `maxChars` characters (default 12,000), each message capped at `maxMessageChars` (default 2,000). Agent Tag's own messages are never included. Other bots' replies are left out by default (`includeBotMessages: "root-only"` keeps a bot-posted first message, such as an alert); `"none"` drops bots entirely and `"all"` keeps them. Replies from people outside `access.allowedUserIds` are included as context marked `"steeringAllowed": false` unless `includeNonAllowedUsers` is false (the first message is always kept). Shared files appear by name only. Each message is one JSON line under an `[Agent Tag: earlier messages …]` header that labels it untrusted context, so message text cannot pose as a request. Set `threadContext.enabled: false` on a profile to turn this off. Top-level mentions and replies in a thread Agent Tag already follows read no history.

The read is bounded to eight seconds (a third of the operation lease if that is shorter) and at most ten pages of 200 replies. A thread longer than that is marked as incomplete in the header. If Slack refuses or times out, the turn still runs with the line `[Agent Tag could not load earlier thread messages: <code>]`, and an audit row `thread-context.unavailable` records the code; a successful read writes `thread-context.loaded` with counts only. A rate-limited read is retried once when Slack asks for a wait of three seconds or less. Slack's 2025 limit of one `conversations.replies` request per minute applies only to commercially distributed apps that are not in the Marketplace. Agent Tag must be installed as a customer-built internal app (what the manifest and `agent-tag onboard` create), which keeps the normal Tier 3 limit.

After Agent Tag follows a thread, it keeps note of what happens there between turns, without starting a turn. These thread updates are other bots' replies (unless `includeBotMessages` is `"none"`), replies from people outside `access.allowedUserIds` (unless `includeNonAllowedUsers` is false), and edits to any message in the thread. Edits never start a turn, even when the edited message mentions Agent Tag. A reply from an allowed person that shares a file (`file_share`) starts a turn like any other reply, with the file attached. The next turn started by an allowed person carries the pending updates, oldest first, under an `[Agent Tag: thread updates since your last turn …]` header, as untrusted JSON lines in the same budget as the earlier-messages window; an edit shows its text before and after. Updates beyond that budget are dropped, newest kept, and the header counts how many were omitted. At most 50 updates wait per thread; older ones are dropped with a `thread-note.dropped` audit row. Scheduled runs in the thread leave updates pending for the next human turn. In a DM, only the owner's messages are read; anyone else gets `dm-owner-denied`. Agent Tag ignores its own messages and edits by matching its bot user and bot ID.
