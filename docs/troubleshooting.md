# Troubleshooting

Each heading is a symptom as you see it: doctor output, a Slack message, or a log line. Each entry gives the cause, the fix, and the `agent-tag doctor` check that detects it, when there is one.

Text in `<angle brackets>` stands for a value that varies (a path, an ID, a code). From a source checkout, run `bun src/cli.ts` wherever this page says `agent-tag`.

Start with doctor. It prints one line per check (`PASS`, `WARN`, `FAIL` or `SKIP`), the check name, a summary, and a `hint:` line for most warnings and failures:

```sh
agent-tag doctor CONFIG
agent-tag doctor CONFIG --fix    # repairs file modes, missing directories, and a stale or stopped service
```

`--fix` never writes tokens or edits the config. Like a plain doctor run it calls Slack and T3 to check them, and when every other check passes it may reinstall or restart the service.

Unless an entry says otherwise, a change to the config or to a Slack token file takes effect only after a restart: `agent-tag service restart`, or stop and start `agent-tag run`. A rotated T3 token file is the exception; a running service picks it up on its own.

Other places to look:

```sh
agent-tag status CONFIG          # queued, failed and stalled work, outbox state, service state
agent-tag audit CONFIG           # audit rows as JSON lines (access denials, file skips, PR results)
agent-tag service logs --follow  # the service's JSON log lines
```

## Setup

### `config not found at <path>`

**Cause.** No config at that path. Doctor and the service commands default to `$AGENT_TAG_CONFIG`, then `agent-tag.json` in `$AGENT_TAG_HOME` (default `~/.agent-tag`).

**Fix.** Pass the right path, or create a config:

```sh
agent-tag onboard
```

**Check:** `config`

### `config is not valid JSON: <error>` or `config is invalid: <field>: <problem>`

**Cause.** The file does not parse, or a key fails the schema. Doctor lists up to five problems and stops after this check.

**Fix.** Edit the named keys. Compare with `config/agent-tag.example.json`.

**Check:** `config`

### `Bun <version> is older than the required <minimum>`

**Cause.** The Bun running Agent Tag is older than the `package.json` engine minimum. Release binaries embed their own Bun and do not hit this.

**Fix.**

```sh
bun upgrade
```

A `WARN` saying `differs from the verified <version>` means the version meets the minimum but is not the one tested; it does not prove that version works. Use the verified version if you see unexplained failures.

**Check:** `bun-version`

### `data directory <path> does not exist` or `has mode <mode>; group/world access is not allowed`

**Cause.** `dataDir` is missing or readable by other users. SQLite keeps WAL and shared-memory files beside the database, so the directory itself must be private. The service refuses to start with `private directory must not grant group or world access: <path>`.

**Fix.**

```sh
agent-tag doctor CONFIG --fix    # creates it, or chmods it to 0700
```

If doctor says `is owned by uid <uid>, not the Agent Tag user` or `is not writable`, run Agent Tag as the user who owns the directory, or `chown` it to that user.

**Check:** `data-dir`

### `secret file <path> is missing`

**Cause.** A token file named in the config does not exist. The check name says which one: `secret:slack-app-token`, `secret:slack-bot-token`, `secret:t3-token`, or `secret:github-token`.

**Fix.** Follow the doctor hint for that file:

- Slack app token: create a Socket Mode app-level token with `connections:write` and rerun `agent-tag onboard`.
- Slack bot token: install the Slack app and rerun `agent-tag onboard` with its `xoxb-` token.
- T3 token, managed mode: an installed service mints it when it restarts (`agent-tag service restart`). Before the first `service install`, whose doctor run fails on the missing token, run `agent-tag run CONFIG` once, or run `agent-tag t3 serve CONFIG` and then `agent-tag t3 rotate CONFIG` in another terminal.
- T3 token, external mode: `agent-tag t3 rotate CONFIG --admin-token-file FILE`, or `bun run enroll:t3`.
- GitHub token: see the GitHub token entry under [Pull requests](#pull-requests).

**Check:** `secret:<name>`

### `secret file <path> has mode <mode>; must be 0600`

**Cause.** A token file, or its directory (`secret parent <dir> has mode <mode>; must be 0700`), is readable by other users. The service refuses it at startup with `secret file must use mode 0600 or stricter: <path>`.

**Fix.**

```sh
agent-tag doctor CONFIG --fix
```

**Check:** `secret:<name>`

### `secret file <path> does not contain a xapp-… token` (or `xoxb-…`)

**Cause.** The Slack app token and bot token are swapped, or the file holds something else. The app token starts with `xapp-` and the bot token with `xoxb-`.

**Fix.** Put each token in its own file. The app-level token comes from **Basic Information > App-Level Tokens**. The bot token comes from **OAuth & Permissions**. See [Slack setup](slack-setup.md#1-create-the-app).

**Check:** `secret:slack-app-token`, `secret:slack-bot-token`

### `Slack bot belongs to workspace <team>, expected <workspaceId>`

**Cause.** The bot token comes from an install in another workspace than `slack.workspaceId`.

**Fix.** Install the app in the configured workspace and replace the bot token, or correct `slack.workspaceId` (it starts with `T`).

**Check:** `slack-bot-auth`

### `Slack auth.test failed: <error>`

**Cause.** Slack rejected the bot token (for example `invalid_auth`, `token_revoked`, or `account_inactive`), or Slack could not be reached.

**Fix.** Reinstall the Slack app and paste the new `xoxb-` token into the bot token file. If the error is a network error, check the host's access to `slack.com`.

**Check:** `slack-bot-auth`

### `Slack Socket Mode token rejected: <error>`

**Cause.** The app-level token is invalid, revoked, or lacks `connections:write`. Without it, Socket Mode does not connect and no Slack events arrive.

**Fix.** Create a new app-level token with only `connections:write` and replace the app token file.

**Check:** `slack-app-auth`

## Slack permissions (`missing_scope`)

The manifest grants 11 bot scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `files:write`, `groups:history`, `groups:read`, `im:history`, `reactions:write`, `users:read`. Slack adds new scopes to a token only after the app is reinstalled. Every fix in this section is the same:

1. Update the app from [`config/slack-manifest.example.json`](../config/slack-manifest.example.json) in Slack's app settings.
2. Reinstall the app to the workspace.
3. Restart the service so it reads the new token: `agent-tag service restart`.

### `Slack bot <user> authenticated in <team>; missing scopes: <scopes>`

**Cause.** The installed bot token lacks scopes the manifest grants. Usually the app was installed from an older manifest.

**Fix.** Reinstall the app as above. Doctor's hint: `reinstall the Slack app from config/slack-manifest.example.json to grant the new scopes`.

**Check:** `slack-bot-auth` (`WARN`)

### `access mode channel-members; allowlist-only in <channel> (missing_scope)`

**Cause.** In `channel-members` mode, Agent Tag reads each routed channel's members. It needs `channels:read` for public channels (`C…`) and `groups:read` for private ones (`G…`). Without them, only `access.allowedUserIds` can use the agent in that channel. The service writes an `access.membership.degraded` audit row.

**Fix.** Reinstall the app as above. Doctor's hint names the scopes: `grant <scopes> (reinstall the Slack app from config/slack-manifest.example.json)`.

A state of `too-large` means the channel has more than `access.membership.maxMembers` members. An `error` state means Slack refused the read for another reason. In both cases only the allowlist works there.

**Check:** `access` (`WARN`)

### Slack says "Agent Tag lacks the Slack permission to read files (the operator must reinstall the app)"

**Cause.** The bot token lacks `files:read`. Files shared with a request are skipped, and the turn runs without them.

**Fix.** Reinstall the app as above.

**Check:** `slack-bot-auth` (`WARN`, lists `files:read`)

### Slack says "Couldn't share `<file>`: the Slack app needs the files:write scope; ask the operator to reinstall it."

**Cause.** The bot token lacks `files:write`, so the agent's file shares fail.

**Fix.** Reinstall the app as above.

**Check:** `slack-bot-auth` (`WARN`, lists `files:write`)

### No 👀 reaction on a mention, and the log shows `slack.reaction.failed` with `"errorCode":"missing_scope"`

**Cause.** The bot token lacks `reactions:write`. The acknowledgement reaction is dropped. The task itself still runs. The service warns once per process, then logs later drops at `info`.

**Fix.** Reinstall the app as above. To turn the reaction off instead, set `slack.ui.ackReaction` to `null`.

**Check:** `slack-bot-auth` (`WARN`, lists `reactions:write`)

### Names show as raw user IDs (`U…`), and the log shows `slack.users.disabled`

**Cause.** `users.info` failed with a token or scope error (for example `missing_scope` when `users:read` is missing). Agent Tag stops name lookups for the rest of the process. Routines then use `routines.defaultTimeZone` instead of the requester's time zone.

**Fix.** Reinstall the app as above, then restart the service.

**Check:** `slack-bot-auth` (`WARN`, lists `users:read`)

## Nothing responds

### A mention gets no reply and no 👀, and `agent-tag status CONFIG` shows no new work

**Cause.** One of these:

- The bot is not in the channel. Slack does not send events from channels the bot has not joined.
- The channel ID is missing from `access.allowedChannelIds`, or has no entry in `routes`. Agent Tag ignores the event without a reply.
- The service is not running, or Socket Mode is not connected.

**Fix.**

1. Invite the bot: `/invite @<bot name>` in the channel.
2. Add the exact channel ID to `access.allowedChannelIds` and add a route for it. Restart the service.
3. Run doctor and fix any `service`, `service-state`, or `slack-app-auth` problem.

**Check:** `service`, `service-state`, `slack-app-auth`. Doctor does not check channel membership of the bot or missing routes.

### One person gets no reply while others do

**Cause.** The access policy denied them. With `access.mode: "allowlist"`, only users in `access.allowedUserIds` can use the agent. With `channel-members`, a member's access may be unknown while the membership snapshot is stale. Agent Tag stays silent. For an explicit request (a mention, a DM or a button click) it writes an `access.denied` audit row with the reason (`user-denied`, `guest-denied`, `membership-unknown`, `dm-owner-denied`, `dm-disabled`, …).

**Fix.** Find the reason:

```sh
agent-tag audit CONFIG | grep access.denied
```

Add the user to `access.allowedUserIds`, or switch to `access.mode: "channel-members"`. Restart the service after access changes.

**Check:** `access` (shows the mode; warns when membership cannot be read)

### A reply in a thread gets no response

**Cause.** Agent Tag follows a thread only after it was mentioned there. A reply without a mention in a thread it never joined is ignored. A thread muted with `!mute` is also ignored until it is unmuted.

**Fix.** Mention the bot in the reply. For a muted thread, send `@<bot name> !unmute` in the thread.

**Check:** none

### A DM gets no response

**Cause.** DMs are off unless configured. With `access.directMessages.mode: "routed-only"` (the default), only DM conversations listed in `routes` with an `ownerUserId` work, and only for that owner. With `off`, every DM is ignored.

**Fix.** Add a DM route (see [DM routes](operations.md#dm-routes)), or set `access.directMessages.mode` to `auto-route` with an `autoRouteProfileId` whose profile has `memory.privateDm: true`.

**Check:** `access` (a passing summary shows `DMs <mode>`)

### Work is accepted but replies never appear, and the log shows `"event":"worker.outcome"` with `"worker":"outbox"` and `"outcome":"failed"`

**Cause.** Slack rejected the reply. Only the `outbox` worker delivers to Slack; a failed outcome from another worker is not a delivery failure. The `errorCode` field says why. `not_in_channel` means the bot was removed from the channel. `channel_not_found` or `is_archived` means the channel is gone or archived. `invalid_auth` or `token_revoked` means the bot token is no longer valid. These rejections are not retried.

**Fix.** Re-invite the bot, or replace the bot token and restart. `agent-tag status CONFIG` shows pending and failed outbox rows.

**Check:** `slack-bot-auth` catches a bad token. Nothing checks per-channel membership.

### Slack says "`!<command>` isn't enabled in this workspace."

**Cause.** The command is listed in `commands.disabled`. ``Only <bot name> admins can use `!<command>`.`` means it is in `commands.adminOnly` and the person is not in `access.adminUserIds`.

**Fix.** Remove the command from `commands.disabled`, or add the person to `access.adminUserIds`. Restart the service.

**Check:** none

### Slack says "Agent Tag stopped this request because the current access configuration no longer authorizes it."

**Cause.** The config changed after the request was queued. Before each turn, Agent Tag rechecks the user, channel, route, profile and repository. The check failed, so the turn did not run.

**Fix.** Review the route and access settings. If the change was intended, nothing more is needed.

**Check:** none

## T3 and providers

### `T3 is not reachable at <url>: <error>`

**Cause.** No T3 server answers at `t3.baseUrl`. Redirects are not followed.

**Fix.** External T3: start the pinned T3 server (see `t3.lock.json`) and check `t3.baseUrl`. Managed T3: check the service logs and `agent-tag t3 status CONFIG`.

A `WARN` saying `managed T3 is not running at <url>; the Agent Tag service starts it` is expected before the service is installed. Start the service (if `secret:t3-token` also fails, mint the token first, as in the `secret file <path> is missing` entry above):

```sh
agent-tag service install CONFIG    # or: agent-tag service restart
```

**Check:** `t3-environment`

### `T3 <version> speaks orchestration protocol <n>; Agent Tag requires 1`

**Cause.** The T3 server is a version this Agent Tag build cannot talk to, such as a nightly or `main` build. At startup the same problem reads `T3 server speaks orchestration protocol <n>; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)`. Agent Tag never sends its token to that server.

**Fix.** Run the T3 version pinned in `t3.lock.json`, or upgrade Agent Tag to a release that supports the newer protocol.

`T3 at <url> does not publish /.well-known/t3/environment` has the same fix: the server is too old or is not T3.

**Check:** `t3-environment`

### `T3 <version> differs from the pinned <version>; only the pinned release is verified`

**Cause.** The server speaks a supported protocol but is not the exact pinned release.

**Fix.** Run the pinned version if anything misbehaves. This is a warning only.

**Check:** `t3-version` (`WARN`)

### `T3 token rejected: <error>` or `T3 token expired at <time>`

**Cause.** The restricted T3 token is invalid, revoked, expired, or has scopes other than `orchestration:read orchestration:operate`. Tokens last 30 days.

**Fix.**

```sh
agent-tag t3 rotate CONFIG                            # managed mode; the runtime must be running
agent-tag t3 rotate CONFIG --admin-token-file FILE    # external mode
```

A running service picks up the new token file on its next T3 call; it checks the file at most every 5 s. `T3 token expires in <n> days` is a warning with the same fix. Managed mode rotates on its own `t3.rotation.rotateBeforeDays` days before expiry (default 7).

**Check:** `t3-session`

### `last rotation <time> (<reason>); <n> replaced token(s) awaiting revocation` (WARN)

**Cause.** Managed mode only. A replaced token is still not revoked more than an hour after its grace period, so revocation keeps failing.

**Fix.** Look for `t3.token.revoke_skipped` in the service logs. The old token expires on its own, so this is not urgent.

**Check:** `t3-token-rotation` (`WARN`)

### `profile <id>: provider <instance> is not authenticated`

**Cause.** A profile's default provider is not signed in on the T3 host. Related summaries: `provider <instance> is not in the T3 catalog`, `provider <instance> is not enabled and installed`, `provider <instance> reports <status>`, `model <model> is not offered by provider <instance>`. At startup the service waits (log `t3.startup.waiting`) until T3 reports the provider ready.

**Fix.** Sign the provider in on the T3 host, as the user T3 runs as, or change the profile's `defaultProviderInstanceId` / `defaultModel`. Doctor's hint: `authenticate the provider in T3 or change the profile's provider/model`.

**Check:** `t3-providers`

### `<profile>: <instance>/<model> (<status>)` under `t3-models` (WARN)

**Cause.** An `allowedModels` entry names a model T3 cannot run now. Switching a thread to it is refused. Defaults are not affected.

**Fix.** Fix the provider in T3, or remove the entry from `allowedModels`.

**Check:** `t3-models` (`WARN`)

### Slack says "Agent Tag could not run this request because the configured provider is not authenticated on the T3 host."

**Cause.** The provider is signed out, or its credential is invalid. Audit and status show the code `T3ProviderAuth`.

**Fix.** Sign the provider in again on the T3 host, then retry in Slack.

**Check:** `t3-providers`

### Slack says "Agent Tag could not run this request because the provider's organization does not allow this login method"

**Cause.** The provider's organization blocks this login method. For Claude, a subscription (OAuth) login fails with HTTP 403 `oauth_not_allowed_for_organization`. Code: `T3ProviderAuthPolicy`. Retrying does not help.

**Fix.** Sign the provider in with an organization-approved credential, such as an API key.

**Check:** none. Doctor sees the provider as authenticated.

### Slack says "Agent Tag could not start this request because the configured provider has reached its usage limit."

**Cause.** The provider account hit a usage, rate, or credit limit. Code: `T3ProviderLimit`. Agent Tag does not switch providers on its own.

**Fix.** Wait for the limit to reset, or point the profile at another approved provider.

**Check:** none

### Slack says "Agent Tag could not complete this request because T3 reported a provider or runtime error."

**Cause.** T3 reported an error that matched no known class. Code: `T3TurnError`. T3 errors that do not name their cause also land here.

**Fix.** Read the T3 server log for the turn. In managed mode, T3's stderr appears in the service logs as `t3.runtime.stderr`.

**Check:** none

### Slack says "Agent Tag could not confirm completion: T3 reported no progress for …"

**Cause.** The turn made no progress for `limits.stalledTurn.timeoutSeconds` on each of `maxAttempts` attempts. Code: `T3TurnStalled`. The work may or may not have finished in T3.

**Fix.** Open the thread in T3 and check its state before you ask again. `agent-tag status CONFIG` counts stalled operations.

**Check:** none

### Slack says "Agent Tag stopped this request because the T3 turn ran longer than the configured limit of …"

**Cause.** The turn hit `limits.stalledTurn.maxTurnSeconds` (default 6 h). Code: `T3TurnCeiling`. Agent Tag asked T3 to interrupt it.

**Fix.** Check the turn in T3. Raise `maxTurnSeconds` if long turns are expected.

**Check:** none

### Slack says "T3 refused to move this thread to the requested model; it stays on …"

**Cause.** T3 0.0.45 cannot move a started conversation to that provider, or to a model whose resume state differs (for example another instance of the same driver with a different home). Code: `T3ModelSwitchRejected`. The thread keeps its model. See [the cross-provider rule](slack-usage.md#the-cross-provider-rule).

**Fix.** Start a new thread with the model you want: `@<bot name> use <model>: <request>`.

**Check:** none

### Slack says "Agent Tag cancelled this request because an approval or question went unanswered for …"

**Cause.** Nobody answered within `limits.interactionExpirySeconds` (default 24 h). Agent Tag asked T3 to stop the turn. A late button click gets `This request has expired and can no longer be answered.`

**Fix.** Send a new message to try again. Raise `limits.interactionExpirySeconds` if people need longer.

**Check:** none

### Slack says "Agent Tag could not deliver this response to T3 after several attempts."

**Cause.** An approval or answer could not reach T3. The card reads `Not applied: Agent Tag could not reach the agent.`

**Fix.** Check `t3-environment` and `t3-session` in doctor and the service logs, then ask again.

**Check:** `t3-environment`, `t3-session`

### Startup fails with `127.0.0.1:<port> is already in use by a process Agent Tag did not start`

**Cause.** Managed mode only. Another process listens on the managed T3 port. Agent Tag never sends its token to a server it did not start.

**Fix.** Stop that process, or set `t3.port` to a free port.

**Check:** none

### Startup fails with `managed T3 did not become ready on <url> within <n>s`

**Cause.** Managed mode only. The T3 child started but did not answer before the deadline. `managed T3 exited with <exit> before becoming ready` means it crashed while starting. The message ends with T3's last stderr lines: at most 10, each cut to 2 KiB, with secrets redacted.

**Fix.** Read the stderr lines in the message. Run T3 alone to see the full output:

```sh
agent-tag t3 serve CONFIG
```

**Check:** none

### Startup fails with `managed T3 <version> is not installed and verified in <dir>`

**Cause.** Managed mode only. The pinned T3 runtime is missing or its files failed the sha256 check, and `t3.autoInstall` is off.

**Fix.**

```sh
agent-tag t3 install CONFIG
```

**Check:** none

### The service exits with code 75, and the log shows `t3.runtime.crashloop`

**Cause.** Managed mode only. T3 crashed too many times within the crash window (`managed T3 crashed after <n> restarts within <n> min`). Agent Tag exits so launchd or systemd restarts it.

**Fix.** Read the `t3.runtime.exited` and `t3.runtime.stderr` lines before it in the service logs.

**Check:** `service-state`, `service`

### Startup fails with `refusing to start T3 <version>: T3 <version> already ran against <dir>`

**Cause.** Managed mode only. A newer T3 already migrated this T3 home, and T3 migrates its database forward only.

**Fix.** Keep the newer Agent Tag release, or point `t3.homeDir` at a fresh directory.

**Check:** none

## Files

Skipped inbound files are listed in one thread notice, for example `I couldn't read 1 file you shared, so I'm working without it:`. Each line gives the file name and a reason; when the list does not fit, it ends with `…and <n> more`. Outbound failures post `:warning: Couldn't share <file>: <reason>.`

### "Agent Tag lacks the Slack permission to read files (the operator must reinstall the app)"

**Cause.** The bot token lacks `files:read`.

**Fix.** Reinstall the app; see [Slack permissions](#slack-permissions-missing_scope).

**Check:** `slack-bot-auth` (`WARN`, lists `files:read`)

### "only the first <n> files of a message are read" or "larger than the <n> MB limit"

**Cause.** The message hit `files.inbound.maxFilesPerMessage` (default 5, at most 8) or the size limit. An image up to `files.inbound.maxImageBytes` (10 MiB) is sent as an image; a larger image, or any other file, is sent as a file up to `files.inbound.maxFileBytes` (default 25 MiB). The limit in the message is the larger of the two.

**Fix.** Share fewer or smaller files, or raise the limits within their allowed ranges. See [Slack files](operations.md#slack-files).

**Check:** none

### "this file type is not accepted" or "its contents do not match its file type"

**Cause.** The extension is in `files.inbound.deniedExtensions`, or the file is a Slack canvas (canvases are always rejected), or a file Slack labels as an image whose bytes are not that image type.

**Fix.** Remove the extension from `deniedExtensions`, or share the file with the right type. Paste a canvas's text into the message instead.

**Check:** none

### "file attachments are turned off"

**Cause.** `files.inbound.enabled` is `false`.

**Fix.** Set it to `true` and restart the service.

**Check:** none

### "it is stored outside Slack", "Slack did not make it available", or "the download from Slack failed"

**Cause.** The file is an external link (for example a Google Drive file), Slack refused `files.info`, or the download failed or took longer than 30 s.

**Fix.** Upload the file to Slack directly and ask again.

**Check:** none

### "Couldn't share `<file>`: the operator turned file sharing off."

**Cause.** `files.outbound.enabled` is `false`. Turning it off also fails files already queued.

**Fix.** Set it to `true` and restart the service.

**Check:** none

### "Couldn't share `<file>`: it looks like it contains a credential, so Agent Tag held it back."

**Cause.** The file matched a credential pattern. `files.outbound.scanForSecrets` is on by default.

**Fix.** Remove the secret from the file and ask the agent to share it again.

**Check:** none

### "Couldn't share `<file>`: the file doesn't exist in the workspace."

**Cause.** The agent named a path that is not in its worktree. Related reasons: `the path leaves the workspace`, `hidden files are never shared`, `it isn't a regular file`, `it's over the size limit`, `the file is empty`.

**Fix.** Ask the agent to write the file inside its worktree and share it again. The size limit is `files.outbound.maxFileBytes` (default 25 MiB).

**Check:** none

### "Didn't share `<path>` (only <n> files per reply)"

**Cause.** The reply asked to share more than `files.outbound.maxFilesPerTurn` files (default 5). `not a path inside the workspace` and `hidden files are never shared` are refused the same way.

**Fix.** Ask for fewer files per reply, or raise `files.outbound.maxFilesPerTurn` (at most 10).

**Check:** none

### "Couldn't share `<file>`: the Slack app isn't in this channel."

**Cause.** The bot was removed from the channel. `file uploads are disabled in this workspace` means a workspace admin turned uploads off.

**Fix.** Re-invite the bot, or ask the Slack admin to allow uploads.

**Check:** none

## Pull requests

These apply when a profile sets `pullRequests.mode: "auto"`. Notices post as a context line in the thread.

### `git is not installed or not on PATH` or `git <version> is older than 2.38.0`

**Cause.** The PR workflow needs git 2.38 or newer on the service's `PATH`.

**Fix.** Install or upgrade git, then restart the service so it sees the new `PATH`.

**Check:** `git-version`

### `secret file <path> is missing` for the GitHub token

**Cause.** `github.auth.tokenFile` does not exist.

**Fix.** Create a fine-grained token limited to the configured repositories, with **Contents** and **Pull requests** read and write. Save it as one line in a `0600` file inside a `0700` directory. See [Creating the token](operations.md#creating-the-token). The file is re-read for every job, so no restart is needed.

**Check:** `secret:github-token`

### `token cannot push to <owner>/<repo>`

**Cause.** The token can read the repository but lacks write access.

**Fix.** Grant the token **Contents** and **Pull requests** read and write on that repository.

`token can read <owner>/<repo>; push access is verified on the first push` is a pass: fine-grained tokens do not report their permissions.

**Check:** `github-access:<owner>/<repo>`

### `GitHub check for <owner>/<repo> failed (<code>)`

**Cause.** GitHub rejected the token (hint: ``the token was rejected; replace it in `github.auth.tokenFile` ``), or the repository does not exist or is not granted to it (hint: `the repository does not exist or is not granted to the token`).

**Fix.** Replace the token, or grant it the repository. Check the `repo` value in `pullRequests.repositories`.

**Check:** `github-access:<owner>/<repo>`

### Slack says "I couldn't update the pull request: GitHub credential rejected; the operator must fix `github.auth`."

**Cause.** GitHub rejected the token during a PR job. `GitHub credential rejected for git push` means the push itself was rejected. `the GitHub credential file is unusable` means the file is missing, empty, or has the wrong mode.

**Fix.** Replace the token file. Run doctor to confirm.

**Check:** `secret:github-token`, `github-access:<owner>/<repo>`

### Slack says "I couldn't update the pull request: the repository was not found or is not granted to the credential."

**Cause.** The repository was renamed or deleted, or the token is not granted it.

**Fix.** Fix `pullRequests.repositories[].repo`, or grant the token the repository.

**Check:** `github-access:<owner>/<repo>`

### Slack says "I didn't push: the diff contains something that looks like a credential in …"

**Cause.** The diff or a commit message matched a credential pattern. Nothing was pushed. A secret that one commit adds and a later commit removes is still blocked.

**Fix.** Remove the secret from the branch history in the task worktree, then ask again.

**Check:** none

### Slack says "I didn't push: the changes exceed the configured limit"

**Cause.** The change is over `maxChangedFiles` (default 300) or `maxDiffBytes` (default 2,000,000).

**Fix.** Split the work, or raise the limits on the profile's `pullRequests`.

**Check:** none

### Slack says "Someone else pushed to `<branch>`; I didn't overwrite it."

**Cause.** The branch moved on GitHub. Agent Tag never force-pushes.

**Fix.** Pull those changes into the thread's branch, or start a new thread.

**Check:** none

### Slack says "<repo>#<n> is merged, so I didn't push. Start a new thread for new work."

**Cause.** The thread's PR was merged or closed. Later jobs in that thread stop quietly.

**Fix.** Start a new thread for new work.

**Check:** none

### Slack says "Couldn't prepare a PR: <code>"

**Cause.** The worktree snapshot failed before any push. The code says which step failed. The agent's reply was still posted.

**Fix.** Look up the code in the `pr.snapshot.failed` audit row (`agent-tag audit CONFIG`). Check that the task worktree still belongs to the configured repository.

**Check:** none

## Service

### `<launchd|systemd> service is not installed` (WARN)

**Cause.** No background service unit exists for this config.

**Fix.**

```sh
agent-tag service install CONFIG
```

**Check:** `service`

### `<launchd|systemd> service is installed but not running` (WARN)

**Cause.** The unit exists but the process is not running.

**Fix.**

```sh
agent-tag service restart
agent-tag service logs --lines 200
```

`agent-tag doctor CONFIG --fix` also restarts it, once no other check fails.

**Check:** `service`

### `<launchd|systemd> unit <path> differs from the unit template this checkout generates` (WARN)

**Cause.** The installed unit came from an older release. On macOS, an older plist with `ProcessType` `Background` lets launchd throttle the service and managed T3, which can push startup past managed T3's 60 s readiness deadline.

**Fix.**

```sh
agent-tag service upgrade CONFIG    # or: agent-tag doctor CONFIG --fix
```

**Check:** `service`

### `<launchd|systemd> unit <path> runs a different Agent Tag install` (WARN)

**Cause.** The unit runs another checkout or release binary than the one running doctor, or another Bun (`runs a different Bun`), or another config (`runs a different config`). `--fix` leaves it alone on purpose.

**Fix.** Run the upgrade from the install the service should use:

```sh
agent-tag service upgrade CONFIG
```

**Check:** `service`

### `agent-tag service: Agent Tag doctor failed with exit code 1: …`

**Cause.** `service install` and `service upgrade` run doctor first and stop when any check fails. The doctor output follows the message.

**Fix.** Fix the failed checks listed in the output, then run the command again.

**Check:** whichever check failed

### `service pid <pid> has been waiting for T3 at <url> since <time>`

**Cause.** The service is running but cannot reach T3, so no work runs. It retries with backoff and logs `t3.startup.waiting` per attempt. The summary includes the last error and the next attempt time.

**Fix.** External T3: start the server at `t3.baseUrl`, or switch to `t3.mode: "managed"`. The service resumes on its own. Managed T3: check `agent-tag service logs` and `agent-tag t3 status CONFIG`.

**Check:** `service-state`

### ``user lingering is not enabled; run `loginctl enable-linger <user>` ``

**Cause.** Linux only. The user's systemd manager stops when the last session ends, which stops the service.

**Fix.**

```sh
sudo loginctl enable-linger "$USER"
```

**Check:** `service` (shown as a hint)

### `Agent Tag LaunchAgent is already installed; use service:upgrade`

**Cause.** macOS only. `service install` ran when a LaunchAgent already exists. On Linux the message is ``Agent Tag systemd unit is already installed; use `agent-tag service upgrade` ``.

**Fix.**

```sh
agent-tag service upgrade CONFIG
```

**Check:** none

### `LaunchAgent did not reach running state` or `systemd unit did not reach running state`

**Cause.** The service started and then exited, or kept restarting. A failed first install removes its unit. A failed upgrade restores the old one.

**Fix.** Read the logs for the startup error, fix it, and install again:

```sh
agent-tag service logs --lines 200
```

**Check:** `service`, `service-state`

### `SQLite store failed to open: <error>`

**Cause.** The database could not be opened or migrated. Common causes are a full disk, wrong ownership, or a database written by a newer Agent Tag. Migrations run forward only.

**Fix.** Check disk space and the data directory's owner. If a newer release wrote the database, run that release, or restore a backup taken before the upgrade:

```sh
agent-tag restore BACKUP NEW_DATA_DIR
```

**Check:** `store`

### `<n> cleanup failure(s)` in the `lifecycle` line (WARN)

**Cause.** Cleanup of a closed task's T3 thread, worktree or branch failed. Cleanup stops at the failing step, so earlier steps may already have run (for example the T3 thread is deleted but the worktree is kept).

**Fix.** Find the cause in the `task.cleanup.failed` audit rows:

```sh
agent-tag audit CONFIG | grep task.cleanup.failed
```

**Check:** `lifecycle` (`WARN`)

## Other doctor checks

Less common results not covered above:

| Check | Summary | Fix |
|---|---|---|
| `config` | `config <path> is not readable (<code>)` | Let the Agent Tag user read the file and search its parent directories. |
| `data-dir` | `data directory <path> is not a directory` | Point `dataDir` at a directory. |
| `data-dir` | `data directory <path> could not be checked (<code>)` | Let the Agent Tag user search the parent directories. |
| `secret:<name>` | `secret file <path> is empty` | Paste the token into the file. |
| `secret:<name>` | `secret file <path> is owned by another user` or `secret parent <dir> is owned by another user` | `chown` the file and directory to the Agent Tag user. |
| `secret:<name>` | `secret path <path> is not a regular file` or `secret parent <dir> is not a directory` | Replace the path with a regular file inside a `0700` directory. |
| `secret:<name>` | `secret file <path> is not readable (<code>)` | `chmod 0600` the file so its owner can read it. |
| `secret:<name>` | `secret file <path> could not be checked (<code>)` | Give the Agent Tag user ownership of the directory (`0700`) and the file (`0600`). |
| `t3-environment` | `T3 environment response is not recognized` | The server at `t3.baseUrl` is not a supported T3. Run the pinned version. |
| `t3-token-rotation` | `T3 credential state <path> is not readable; delete it to start over (replaced tokens then expire on their own)` | Delete the file as the message says. |
| `slack-bot-auth` | `Slack auth.test failed: Slack auth.test returned HTTP <status>` | Slack or the network failed. Retry later. |
| `slack-app-auth` | `Slack apps.connections.open failed: <error>` | Slack or the network failed. Retry later. |
| `access` | `access mode channel-members; allowlist-only in <channel> (error)` | Slack refused the membership read. Only the allowlist works there until it succeeds. |
| `git-version` | `could not parse <output>` (WARN) | Check that `git --version` on the service's `PATH` prints a normal version. |
| `service` | `could not inspect the <kind> service: <error>` (WARN) | Run `agent-tag service status` and read the error. |

A `SKIP` is not a failure. It means an earlier check failed, or the check does not apply (for example `t3-token-rotation` in external mode, or `github-access` when no profile has pull requests on).
