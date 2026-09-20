# Durability core evidence, 2026-09-21

Actor type: `automated-fixture`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Bun: `1.3.13`
- Store: Bun SQLite in WAL mode with foreign keys, full synchronous writes, and a mode-`0600` database file

## Checks run

`bun run check` passed with 18 tests and one intentionally disabled live-T3 suite. The store and Slack ingress fixtures proved:

1. A Slack retry with the same delivery ID and an overlapping `app_mention`/`message` delivery with a different delivery ID but the same semantic event key created one event, task, and operation. Both duplicates returned the original stable operation, command, and message IDs.
2. Two turns in one task could not be claimed concurrently. Closing and reopening the database preserved the first lease; after expiry, another worker reclaimed the same operation with the same command and message IDs and a higher attempt number. The second turn became claimable only after the first completed.
3. Two independent tasks respected the configured global active-task bound.
4. A Slack outbox message survived close/reopen and could not be stolen before lease expiry. After expiry, it was quarantined as `delivery-outcome-unknown` instead of being blindly sent a second time.
5. Injected exceptions after an operation insert and after a lease update rolled back their transactions. A normal reopen saw no partial inbox state and claimed the operation at attempt one.
6. State-changing ingestion, claim, completion/failure, T3 binding, outbox enqueue/claim, and delivery transitions write structured audit records with actor, authority, source, target, result, and correlation identifiers.

These fixtures exercise the database boundary and process reopen. They do not yet prove a kill-at-every-boundary process crash, T3 restart reconciliation, or Slack retry behavior against the live workspace.
