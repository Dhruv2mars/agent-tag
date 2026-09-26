# Agent Tag

Agent Tag is an open-source Slack coworker that delegates work to agents running through T3 Code on an organization-controlled machine.

This repository is under active development. It is not yet generally available. See [the acceptance matrix](docs/ga-acceptance.md) for the evidence required before that claim changes.

## Development

Requirements:

- Bun
- T3 Code `0.0.42`
- macOS or Linux for background operation

```sh
bun install
bun run verify:t3-pin
bun test
bun run typecheck
```

After copying and editing `config/agent-tag.example.json`, validate the database, T3 session, provider catalog, and Slack bot identity without starting Socket Mode:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json
```

Run the foreground service with:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

The service validates every configured provider/model against T3 before connecting to Slack, writes structured JSON lifecycle records to stdout/stderr, and shuts down on `SIGINT` or `SIGTERM`. See [operations](docs/operations.md) for recovery and host constraints.

Provider authentication is not a license grant. Review [provider access and licensing](docs/provider-licensing.md) before making an authenticated provider available to other Slack users.

For the exact Slack manifest, scopes, token files, route fields, and first live mention, follow [Slack setup](docs/slack-setup.md). The checked-in manifest deliberately omits file scopes because Slack file transfer remains outside the implemented path.

With the pinned T3 server running and an exact-scope service token configured:

```sh
AGENT_TAG_T3_URL=http://127.0.0.1:37841 \
AGENT_TAG_T3_TOKEN_FILE=/absolute/path/to/t3-token \
bun run test:t3
```

Agent Tag uses T3 as its only execution backend. It does not contain an independent agent loop or provider manager.
