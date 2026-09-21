# Durable scheduler evidence, 2026-09-21

Actor type: `automated-fixture`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Store: SQLite migration 7

## Checks run

The fake-clock fixture created a recurring agent schedule inside an authorized active task, closed and reopened SQLite, and dispatched the overdue run through the same durable operation inbox used by Slack. `run-once` coalesced the missed interval into one operation and advanced to the first future cadence. At the next due time, `overlapPolicy: skip` observed the prior scheduled operation still pending and recorded an `overlap-skipped` run instead of adding concurrent work.

The fixture then cancelled the recurring schedule, dispatched a one-shot reminder through the Slack outbox without invoking T3, and completed a stale one-shot job as `missed-skipped` under its explicit missed-run policy. A forged task context was denied. Create, claim, settle, cancel, and denial transitions appeared in the audit export.

Schedule delivery uses stable IDs derived from `(scheduleId, dueAt)`. If a process exits after inserting an operation or reminder but before settling the schedule, the next lease owner repeats the same semantic event or outbox client ID and receives the existing durable record. Scheduled agent operations still pass through per-task serialization and the global task concurrency bound.

Operator CLI controls support add, list, and cancel using a JSON schedule spec. Live Slack creation/cancellation, process-kill fault injection, a human exercise, and long-running quiet/resource observation remain before `JOB-01` can pass.
