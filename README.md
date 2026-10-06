# Agent Tag

Agent Tag is an open-source Slack coworker that delegates work to agents running through T3 Code on an organization-controlled machine.

This repository is under active development. It is not yet generally available. See [the acceptance matrix](docs/ga-acceptance.md) for the evidence required before that claim changes.

For a concise continuation guide, current verified behavior, and the next required work, read [project status](docs/project-status.md).

## Install

Install a prebuilt binary (macOS arm64/x64, Linux x64/arm64) without cloning:

```sh
curl -fsSL https://raw.githubusercontent.com/Dhruv2mars/agent-tag/main/install.sh | AGENT_TAG_VERSION=0.1.0-rc.1 sh
agent-tag version
```

Until GA every release is a prerelease, and the installer's default (`latest`) only finds stable releases, so pin one from [the releases page](https://github.com/Dhruv2mars/agent-tag/releases) with `AGENT_TAG_VERSION`. For the same reason, move between prereleases with `agent-tag update --version X` rather than a bare `agent-tag update`. After the first stable release, drop the pin and use `agent-tag update --check`.

The installer verifies the release's `SHA256SUMS` and installs to `~/.local/bin`. Set `AGENT_TAG_INSTALL_DIR` to change the destination. Then create the Slack app and config with [Slack setup](docs/slack-setup.md) and check them with `agent-tag doctor /absolute/path/to/agent-tag.json`. A Docker image is also available. See [install](docs/install.md) for both, plus self-update and how releases are cut.

## Development

Requirements:

- Bun
- T3 Code `0.0.45` (orchestration protocol 1; `0.0.42`–`0.0.45` are accepted)
- macOS or Linux for background operation

```sh
bun install
bun run verify:t3-pin
bun test
bun run typecheck
```

Verify the exact committed tree from a fresh archive and frozen dependency install with:

```sh
bun run verify:clean-install
```

## Quickstart

With T3 Code running, the onboarding wizard writes `~/.agent-tag/agent-tag.json`, creates the data directory, prints a create-from-manifest link for the Slack app, stores the Slack tokens in mode-`0600` files, mints a restricted T3 token, and offers to install the background service:

```sh
bun run onboard
```

Every prompt also has a flag, so CI and scripted installs can run without a TTY (see [operations](docs/operations.md#onboarding)):

```sh
AGENT_TAG_SLACK_APP_TOKEN=... AGENT_TAG_SLACK_BOT_TOKEN=... \
bun run onboard -- --yes --accept-risk --repo /srv/repo --users U0123 --channels C0123 --t3-issue-token --install-service
```

Check the install. `--fix` repairs safe problems: file modes, a missing data directory, a drifted unit template, and a stopped service. It never moves the service to a different checkout or Bun.

```sh
bun run doctor            # or: bun run doctor -- /absolute/path/to/agent-tag.json --fix
```

Manage the per-user background service. It uses a LaunchAgent on macOS and a `systemd --user` unit on Linux:

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
bun run service:logs -- --follow
```

To run it in the foreground instead:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

`bun link` puts the `agent-tag` command on your `PATH`, so `agent-tag onboard|doctor|service ...` work the same way.

The service validates every configured provider/model against T3 before connecting to Slack, writes structured JSON lifecycle records to stdout/stderr, and shuts down on `SIGINT` or `SIGTERM`. See [operations](docs/operations.md) for upgrade, uninstall, recovery, and host constraints.

Provider authentication is not a license grant. Review [provider access and licensing](docs/provider-licensing.md) before making an authenticated provider available to other Slack users.

For the exact Slack manifest, scopes, token files, route fields, and first live mention without the wizard, follow [Slack setup](docs/slack-setup.md). The checked-in manifest deliberately omits file scopes because Slack file transfer remains outside the implemented path.

With the pinned T3 server running and an exact-scope service token configured:

```sh
AGENT_TAG_T3_URL=http://127.0.0.1:37841 \
AGENT_TAG_T3_TOKEN_FILE=/absolute/path/to/t3-token \
bun run test:t3
```

Agent Tag uses T3 as its only execution backend. It does not contain an independent agent loop or provider manager.
