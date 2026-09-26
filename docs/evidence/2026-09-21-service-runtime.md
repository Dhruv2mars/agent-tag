# Service runtime evidence, 2026-09-21

Actor types: `automated-fixture`, `automated-real`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Bun: `1.3.13`
- T3 Code: `0.0.42`

## Fixture checks

`bun run check` passed with 46 tests and one intentionally disabled live-T3 suite. The service fixture started independent coordinator, interaction, schedule, maintenance, and Slack-outbox loops; observed useful work in each; stopped Socket Mode; ended the loops; and closed SQLite. A forced worker exception was contained and retried. A secret canary placed in the exception message did not appear in the structured service records.

The production service creates `maxConcurrentTasks` coordinator workers while the store enforces both the global bound and per-task serialization. Separate workers dispatch schedules and apply memory retention. Startup quarantines expired in-flight Slack sends before Socket Mode starts. `SIGINT` and `SIGTERM` trigger the same graceful stop path.

Provider-policy fixtures accepted an explicit ready/authenticated provider and model, then failed closed with distinct codes for non-ready, unauthenticated, and missing-model configurations. Production startup applies the same validation to every profile against the live T3 catalog before Slack connects.

A consistent SQLite backup was created in a private directory, validated with `quick_check`, restored to a new path, and reopened with identical durable row counts and audit records. Backup and restore both installed mode-`0600` files and a second restore refused to overwrite the destination. The audit export omitted the source Slack message body.

## Real T3 restart check

`bun run test:t3` passed all six live tests. In the durable coordinator case, the first worker dispatched the project and turn commands to real T3, then a forced bridge failure returned the operation to its durable pending state. The test closed and reopened SQLite, constructed a new coordinator worker, replayed the same stable IDs, reconciled the completed T3 snapshot, and atomically produced the exact Slack outbox reply. Temporary projects, worktrees, and database files were removed afterward.

This proves a store/worker restart after accepted T3 dispatch. It does not claim an OS process kill, T3 server restart, machine outage, or live Slack delivery.
