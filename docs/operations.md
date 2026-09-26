# Operations

Agent Tag is currently a foreground Bun service. A service manager may wrap the documented command, but install, upgrade, backup/restore, and uninstall automation are not complete enough for a GA claim.

Complete the [Slack setup](slack-setup.md) before running live checks.

## Start and stop

Run a live dependency check first:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json
```

The check opens and migrates the SQLite store, authenticates with the restricted T3 service token, decodes the provider catalog, validates every profile's provider and model, and verifies that the Slack bot belongs to the configured workspace. Missing, disabled, unauthenticated, non-ready, and model-mismatch states fail before Socket Mode or task dispatch. Its JSON output contains aggregate row counts and provider states, not tokens or message text.

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

## Audit and backup

Export the complete structured audit log as newline-delimited JSON:

```sh
bun run audit -- /absolute/path/to/agent-tag.json > audit.ndjson
```

Audit rows contain identity and correlation fields plus bounded transition metadata. They do not contain Slack message bodies. Treat the export as private operational data because its IDs can still be sensitive.

Create a consistent backup while the service is stopped or running:

```sh
bun run backup -- /absolute/path/to/agent-tag.json /private/backup/agent-tag.sqlite
```

The destination parent must be owned by the service user with no group or world permissions. SQLite creates a consistent snapshot, Agent Tag runs `quick_check`, installs the mode-`0600` file atomically, and refuses to overwrite an existing path.

Restore into a new data directory:

```sh
bun run restore -- /private/backup/agent-tag.sqlite /new/private/data-directory
```

Restore validates the source, creates the new directory with mode `0700` when needed, writes `agent-tag.sqlite` with mode `0600`, and refuses to overwrite an existing database. Point a reviewed config at the new directory and run `doctor` before starting it. In-place destructive restore is intentionally unsupported.

## Secret scan

Scan the Agent Tag checkout for common Slack, GitHub, AWS, Anthropic, and OpenAI credential shapes:

```sh
bun run scan:secrets -- /absolute/path/to/agent-tag
```

Add `--config` to load the three configured service credentials as exact canaries and scan the live data directory plus every authorized repository. Extra roots after the config are also scanned:

```sh
bun run scan:secrets -- --config /absolute/path/to/agent-tag.json /absolute/path/to/agent-tag
```

The JSON report names only the file, credential class, and configured canary label. It never returns matched values. The command skips `.git` and `node_modules`. A finding or skipped symbolic link sets a nonzero exit code, so a release check cannot silently claim a partial clean scan. Keep source secret files outside scanned roots when practical; if they are inside, the configured scan excludes those exact files and scans their siblings.

## DM routes

Direct messages are off until an operator adds the DM conversation ID to `access.allowedChannelIds`, enables `memory.privateDm` on the profile, and binds the route to one allowed human:

```json
{
  "conversationId": "D0EXAMPLE",
  "conversationType": "dm",
  "ownerUserId": "U0EXAMPLE",
  "profileId": "engineering"
}
```

The app manifest includes the `im:history` bot scope and `message.im` subscription. Reinstall the Slack app after changing scopes. Agent Tag accepts unmentioned messages only for the named owner in that exact DM. It does not support group DMs as private single-owner conversations.

## Schedules

Schedules belong to an existing active Agent Tag task. Create a JSON spec such as:

```json
{
  "kind": "agent",
  "prompt": "Run the release check and report only actionable changes.",
  "runAt": "2026-09-22T04:30:00.000Z",
  "cadenceSeconds": 86400,
  "missedRunPolicy": "run-once",
  "misfireGraceSeconds": 300,
  "overlapPolicy": "skip"
}
```

Then use the task, actor, and profile IDs from the private audit export:

```sh
bun run schedule:add -- CONFIG TASK_ID USER_ID PROFILE_ID SPEC.json
bun run schedule:list -- CONFIG TASK_ID USER_ID PROFILE_ID
bun run schedule:cancel -- CONFIG TASK_ID USER_ID PROFILE_ID SCHEDULE_ID
```

`kind: "agent"` adds a normal durable T3 operation when due. `kind: "reminder"` sends `Reminder: ...` through the durable Slack outbox without running a provider. Cadence is optional for a one-shot schedule and must be at least 60 seconds when present. Workspace active schedules are capped by `limits.maxActiveSchedules`.

An overdue `run-once` schedule coalesces missed intervals into one run; `skip` records the miss without dispatch. `overlapPolicy: skip` suppresses a recurring agent run while an earlier run from the same schedule is pending or in flight. `queue` preserves every due run behind normal per-task serialization.

## Host constraints

The verified runtime is macOS arm64 with Bun `1.3.13` and T3 Code `0.0.42`. A macOS user service requires the user to remain logged in; an awake host is required for local T3 and Socket Mode availability. Linux service-manager behavior has not yet been exercised, so it remains outside the passing claim.
