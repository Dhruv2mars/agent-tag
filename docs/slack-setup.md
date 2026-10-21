# Slack setup

This is the shortest supported path to a live Agent Tag mention: create the Slack app, store its two tokens, configure one route, and verify. What people can then do in Slack is in [Slack usage](slack-usage.md).

`bun run onboard` automates steps 1–3. It prints a create-from-manifest link, stores both tokens at mode `0600` under `~/.agent-tag/secrets/`, checks `auth.test`, and writes a config with one route per channel. See [Onboarding](operations.md#onboarding). For unattended runs, pass the tokens through `AGENT_TAG_SLACK_APP_TOKEN` and `AGENT_TAG_SLACK_BOT_TOKEN` in a process environment that is not logged, and never as command-line arguments. The manual steps below remain the reference.

## 1. Create the app

In Slack's app dashboard, choose **Create New App > From an app manifest**, pick the workspace, and paste [`config/slack-manifest.example.json`](../config/slack-manifest.example.json):

```json
{
  "display_information": {
    "name": "Agent Tag",
    "description": "A T3-backed Slack coworker for authorized engineering tasks",
    "background_color": "#1f2937"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Agent Tag",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": ["app_mention", "message.channels", "message.groups", "message.im"]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

The manifest enables Socket Mode (Agent Tag opens an outbound WebSocket; it needs no public URL), interactivity for buttons and cards, and a writable App Home Messages tab for DMs. Agent Tag must be a customer-built internal app like this one, not a distributed app: Slack limits non-Marketplace distributed apps to one `conversations.replies` call per minute.

### For the Slack admin

Agent Tag asks for these 11 bot token scopes and no others:

| Scope | Why Agent Tag needs it |
| --- | --- |
| `app_mentions:read` | Receive `@Agent Tag` mentions in channels it was invited to. |
| `channels:history` | Read replies in public-channel threads Agent Tag follows, and earlier thread messages when it is mentioned partway into a thread. |
| `channels:read` | Read the members of a routed public channel (`access.mode: "channel-members"`) and check that a channel is public before saving a workspace memory note. |
| `chat:write` | Post replies, status messages and cards, and edit them in place. |
| `files:read` | Read files people share with a request, and check whether an upload already reached the thread after a crash. |
| `files:write` | Share files the agent wrote back into the same thread. |
| `groups:history` | The same as `channels:history`, for private channels Agent Tag was invited to. |
| `groups:read` | The same as `channels:read`, for private channels. |
| `im:history` | Read direct messages sent to Agent Tag. |
| `reactions:write` | React with :eyes: as soon as a mention is accepted. |
| `users:read` | Show the model who is speaking by name, render `<@U…>` mentions as names, use a person's time zone for routines, and tell guests and bots apart from members. |

What these scopes do not grant:

- No `channels:join`: Agent Tag reads only conversations it was invited to, and it cannot add itself to one.
- No `search:read`: it cannot search the workspace.
- No `users:read.email`: it never reads email addresses.
- No user token: it acts only as its own bot user, never on behalf of a person.
- No Slack Connect support: channels shared with other organizations are not tested or supported.
- Who may use it is set in Agent Tag's config (`access.allowedUserIds`, `access.allowedChannelIds`, `access.mode`), not by Slack.

Bot events are exactly `app_mention`, `message.channels`, `message.groups` and `message.im`. Draft pull requests use a separate GitHub token on the host, not a Slack permission ([operations](operations.md#github-pull-requests-draft-prs-auto-mode)).

### Reinstall after a scope change

To add scopes to an app that is already installed, paste the updated manifest under **App Manifest** (or add the scopes under **OAuth & Permissions > Bot Token Scopes**), then click **Reinstall to Workspace** and approve. The bot token keeps its value, so no secret file changes. File sharing picks up the new scopes on its next call; name lookups turn themselves off for the process after `missing_scope`, so restart the service after adding `users:read`. `agent-tag doctor` stops warning once Slack reports the new scopes. Limits, retries and cleanup for shared files are in [Slack files](operations.md#slack-files).

Without a scope, the feature that needs it degrades and the rest keeps working: no :eyes: without `reactions:write`, raw user IDs and `routines.defaultTimeZone` without `users:read`, skipped files with a notice without `files:read`, a failed upload notice without `files:write`, and `channel-members` mode working allowlist-only without `channels:read`/`groups:read`. `agent-tag doctor` warns about each missing scope.

### Tokens

Slack documents `connections:write` for Socket Mode app-level tokens and requires an `xapp` token to establish the WebSocket connection. See [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

Install the app to the target workspace. Under **Basic Information > App-Level Tokens**, create one token with only `connections:write`. This is the app token and begins with `xapp-`. Under **OAuth & Permissions**, copy the bot token created by the workspace install. It begins with `xoxb-`.

Invite Agent Tag to each configured public or private channel. Agent Tag does not look channels up yet, so the operator supplies exact IDs in the config.

## 2. Store tokens

Create the files before opening them in a trusted editor. Do not put tokens in shell arguments, Git, `.env`, or the JSON config.

```sh
install -d -m 700 /var/lib/agent-tag
install -d -m 700 /var/lib/agent-tag/data
install -d -m 700 /var/lib/agent-tag/secrets
install -m 600 /dev/null /var/lib/agent-tag/secrets/slack-app-token
install -m 600 /dev/null /var/lib/agent-tag/secrets/slack-bot-token
install -m 600 /dev/null /var/lib/agent-tag/secrets/t3-token
```

Paste one token into each matching file. A trailing newline is allowed. Agent Tag rejects a secret directory accessible by group or world, a secret file more permissive than mode `0600`, a file owned by another user, and a T3 token with broader or different scopes.

## 3. Configure one route

Copy [`config/agent-tag.example.json`](../config/agent-tag.example.json) outside the repository and replace:

- `dataDir` with the private writable directory, such as `/var/lib/agent-tag/data` above.
- The three secret file paths with the files above.
- `workspaceId` with the Slack workspace ID beginning with `T`.
- `allowedUserIds` with the humans allowed to direct the coworker.
- `allowedChannelIds` with the exact public, private, or DM conversation IDs.
- The route conversation ID, profile repository root, T3 provider instance, and model.

Keep ambient participation disabled for the first run. A normal channel route uses `conversationType: "channel"`. A DM route also requires `conversationType: "dm"`, one `ownerUserId`, and `memory.privateDm: true`.

## 4. Verify and start

Start the pinned T3 Code `0.0.45` server (or use `t3.mode: "managed"`; see [T3 runtime](t3-runtime.md#managed-t3)), then run:

```sh
bun install --frozen-lockfile
bun run verify:t3-pin
bun run doctor -- /absolute/path/to/agent-tag.json
bun run start -- /absolute/path/to/agent-tag.json
```

With the release binary, the same checks are `agent-tag doctor CONFIG` and `agent-tag run CONFIG` (or `agent-tag service install CONFIG`).

`doctor` opens and migrates SQLite, checks that T3 speaks orchestration protocol 1, verifies the restricted T3 session, checks every configured provider and model, calls Slack `auth.test`, rejects a bot installed in the wrong workspace, and lists any missing scope. `start` repeats the T3 and provider checks before opening Socket Mode.

Then check each of these in Slack:

| Check | Passed when | If not |
| --- | --- | --- |
| `doctor` | Every check is `PASS` (or `SKIP` for features you did not configure) and no scope is reported missing. | Fix the failing check first; see [troubleshooting](troubleshooting.md). |
| Mention | `@Agent Tag say hello` in a routed channel gets :eyes:, a status message, and a reply in the thread with a footer naming the model. | No :eyes: but a reply: `reactions:write` is missing. Nothing at all: the bot is not in the channel, the channel or user is not allowed, or there is no route; `agent-tag audit CONFIG` shows an `access.denied` row with the reason. |
| Follow-up | A reply in the same thread, without a mention, starts the next turn of the same task. | The replier is not in `access.allowedUserIds` (or not a channel member in `channel-members` mode). |
| Stop | Pressing **Stop** during a turn edits the status to `Stopped by @you`. | Check that interactivity is enabled in the app settings. |
| DM (if routed) | A message in the bot's Messages tab gets a reply without a mention. | The DM is not routed to that owner, or the Messages tab is read-only; reinstall from the manifest. |
