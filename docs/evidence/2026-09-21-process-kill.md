# Process-kill recovery evidence, 2026-09-21

Actor type: `automated-real`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Runtime: Bun `1.3.13`
- Store: production `AgentTagStore` with SQLite WAL

## Check run

`test/process-kill.test.ts` launched a separate Bun process against a temporary production-schema SQLite database. The child ingested one Slack-shaped event, claimed its operation with a ten-second lease, printed only its stable IDs, and then waited. The parent sent `SIGKILL`, so the child ran no signal handler, store close, or other cleanup.

A fresh store process opened the same database. It could not claim the work five seconds into the dead worker's lease. At eleven seconds it reclaimed the original operation ID, T3 command ID, and T3 message ID with attempt `2`. This proves fail-closed lease ownership before expiry and stable replay identity after an actual process death.

The full local suite passed with 40 tests and one intentionally disabled live-T3 suite. This check does not claim a full service/T3/Slack process-kill round trip or machine-outage recovery.
