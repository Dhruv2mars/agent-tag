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

After copying and editing `config/agent-tag.example.json`, validate the database, T3 session, provider catalog, and Slack bot identity without starting Socket Mode:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json
```

Run the foreground service with:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

On macOS, install the validated config as a per-user LaunchAgent with:

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
```

The service validates every configured provider/model against T3 before connecting to Slack, writes structured JSON lifecycle records to stdout/stderr, and shuts down on `SIGINT` or `SIGTERM`. See [operations](docs/operations.md) for upgrade, uninstall, recovery, and host constraints.

Provider authentication is not a license grant. Review [provider access and licensing](docs/provider-licensing.md) before making an authenticated provider available to other Slack users.

For the exact Slack manifest, scopes, token files, route fields, and first live mention, follow [Slack setup](docs/slack-setup.md). The checked-in manifest deliberately omits file scopes because Slack file transfer remains outside the implemented path.

With the pinned T3 server running and an exact-scope service token configured:

```sh
AGENT_TAG_T3_URL=http://127.0.0.1:37841 \
AGENT_TAG_T3_TOKEN_FILE=/absolute/path/to/t3-token \
bun run test:t3
```

Read [SECURITY.md](SECURITY.md) before inviting anyone: every allowed Slack user can make the agent run code as the service's OS user. Check a deployment with:

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json
```

Agent Tag uses T3 as its only execution backend. It does not contain an independent agent loop or provider manager.
