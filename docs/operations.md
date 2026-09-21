# Operations

Agent Tag is currently a foreground Bun service. A service manager may wrap the documented command, but install, upgrade, backup/restore, and uninstall automation are not complete enough for a GA claim.

## Start and stop

Run a live dependency check first:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json
```

The check opens and migrates the SQLite store, authenticates with the restricted T3 service token, decodes the provider catalog, and verifies that the Slack bot belongs to the configured workspace. Its JSON output contains aggregate row counts and provider states, not tokens or message text.

Start the service in the foreground:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

Send `SIGINT` or `SIGTERM` to stop it. The service first prevents another worker iteration, stops Socket Mode, lets work already inside a durable worker boundary settle, and then closes SQLite. An abrupt process or machine exit is recovered from leases and stable command IDs at the next start.

The configured `maxConcurrentTasks` creates that many independent coordinator workers. SQLite still serializes turns within each task and enforces the same global bound. Interaction responses and the Slack outbox have separate workers, so a task waiting for a human does not block another task.

## Recovery rules

- Pending and expired T3 operations replay their original T3 command and message IDs.
- Pending interaction responses replay their original response command IDs.
- A Slack send whose process died after claiming it is quarantined as `delivery-outcome-unknown` on startup. It is not automatically resent because the supported Slack API surface has no documented idempotency key.
- Worker exceptions are logged by class only. Exception messages, task text, stored payloads, and credentials are not written to service logs.

The operator must reconcile quarantined Slack sends in SQLite before retrying or replacing them. An automated reconciliation command is still pending.

## Host constraints

The verified runtime is macOS arm64 with Bun `1.3.13` and T3 Code `0.0.42`. A macOS user service requires the user to remain logged in; an awake host is required for local T3 and Socket Mode availability. Linux service-manager behavior has not yet been exercised, so it remains outside the passing claim.
