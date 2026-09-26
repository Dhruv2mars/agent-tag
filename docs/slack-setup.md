# Slack setup

This is the shortest supported path to a live Agent Tag mention. File transfer is not implemented yet, so the manifest does not request Slack file scopes.

## 1. Create the app

In Slack's app dashboard, create an app from [`config/slack-manifest.example.json`](../config/slack-manifest.example.json). The manifest enables Socket Mode and interactivity. Its bot token scopes are exactly:

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `groups:history`
- `im:history`

Its bot events are exactly `app_mention`, `message.channels`, `message.groups`, and `message.im`. Slack documents `connections:write` for Socket Mode app-level tokens and requires an `xapp` token to establish the WebSocket connection. See [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

Install the app to the target workspace. Under **Basic Information > App-Level Tokens**, create one token with only `connections:write`. This is the app token and begins with `xapp-`. Under **OAuth & Permissions**, copy the bot token created by the workspace install. It begins with `xoxb-`.

Invite Agent Tag to each configured public or private channel. No channel-list scope is requested, so the operator supplies exact IDs in the config.

## 2. Store tokens

Create the files before opening them in a trusted editor. Do not put tokens in shell arguments, Git, `.env`, or the JSON config.

```sh
install -d -m 700 /var/lib/agent-tag/secrets
install -m 600 /dev/null /var/lib/agent-tag/secrets/slack-app-token
install -m 600 /dev/null /var/lib/agent-tag/secrets/slack-bot-token
install -m 600 /dev/null /var/lib/agent-tag/secrets/t3-token
```

Paste one token into each matching file. A trailing newline is allowed. Agent Tag rejects a secret directory accessible by group or world, a secret file more permissive than mode `0600`, a file owned by another user, and a T3 token with broader or different scopes.

## 3. Configure one route

Copy [`config/agent-tag.example.json`](../config/agent-tag.example.json) outside the repository and replace:

- `dataDir` with a private writable directory.
- The three secret file paths with the files above.
- `workspaceId` with the Slack workspace ID beginning with `T`.
- `allowedUserIds` with the humans allowed to direct the coworker.
- `allowedChannelIds` with the exact public, private, or DM conversation IDs.
- The route conversation ID, profile repository root, T3 provider instance, and model.

Keep ambient participation disabled for the first run. A normal channel route uses `conversationType: "channel"`. A DM route also requires `conversationType: "dm"`, one `ownerUserId`, and `memory.privateDm: true`.

## 4. Verify and start

Start the pinned T3 Code `0.0.42` server, then run:

```sh
bun install --frozen-lockfile
bun run verify:t3-pin
bun run doctor -- /absolute/path/to/agent-tag.json
bun run start -- /absolute/path/to/agent-tag.json
```

`doctor` opens and migrates SQLite, verifies the restricted T3 session, checks every configured provider and model, calls Slack `auth.test`, and rejects a bot installed in the wrong workspace. `start` repeats the T3/provider checks before opening Socket Mode.

Mention the app in an allowed channel. Agent Tag should acknowledge work in the message thread, dispatch through T3, and post the final result to that same thread. A DM route does not require a mention. Approval, question, and cancel controls use Slack interactivity over the same Socket Mode connection.

## Known live blockers

- Slack installation, tokens, and a human mention have not been exercised in this repository's evidence yet.
- Slack files are not accepted or returned. `files:read` and `files:write` are intentionally absent.
- Real Codex execution through T3 passes. T3 currently reports Claude as ready and authenticated but real Claude turns fail with `provider-api-errors`; Agent Tag records that provider row as failed rather than falling back.
