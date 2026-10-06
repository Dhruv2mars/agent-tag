# Operations

Agent Tag runs in the foreground on macOS or Linux. On macOS, the checked-in manager can install it as a per-user LaunchAgent. Linux service-manager automation is not implemented or tested.

Complete the [Slack setup](slack-setup.md) before running live checks.

Before enabling a provider for other Slack users, complete the [provider access and licensing review](provider-licensing.md). T3 readiness proves connectivity only; it does not prove that a personal subscription or session may be shared.

## Clean-checkout verification

Run the committed tree through a new frozen dependency install before release:

```sh
bun run verify:clean-install
```

The verifier refuses a dirty checkout, exports `HEAD` with `git archive`, installs from `bun.lock` in a fresh private temporary directory, runs typecheck and tests, and verifies the pinned T3 release metadata. It removes the temporary checkout afterward. The same locked install and gate run on clean GitHub-hosted macOS 15 and Ubuntu 24.04 workers in `.github/workflows/ci.yml`.

## Binary installs and updates

Hosts installed with `install.sh` run a standalone binary from `~/.local/bin/agent-tag`. Its subcommands replace the package scripts: `agent-tag run CONFIG` for `bun run start -- CONFIG`, `agent-tag doctor CONFIG` for `bun run doctor -- CONFIG`, and likewise for `status`, `audit`, `backup`, `restore`, and `schedule-add|list|cancel`; `agent-tag help` lists them. `agent-tag update` verifies and atomically replaces the binary; restart the foreground process afterward. The macOS LaunchAgent manager still runs from a source checkout. See [install](install.md).

## Start and stop

Run a live dependency check first:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json
```

The check opens and migrates the SQLite store, reads T3's unauthenticated `/.well-known/t3/environment` descriptor, authenticates with the restricted T3 service token, decodes the provider catalog, validates every profile's provider and model, and verifies that the Slack bot belongs to the configured workspace. Missing, disabled, unauthenticated, non-ready, and model-mismatch states fail before Socket Mode or task dispatch. Its JSON output contains aggregate row counts, the T3 orchestration protocol, and provider states, not tokens or message text.

This build speaks T3 orchestration protocol 1 (T3 `0.0.42`–`0.0.45`). A descriptor without `orchestrationProtocolVersion` is protocol 1. Any other version makes `doctor` and `start` fail closed with `T3 server speaks orchestration protocol N; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)` before the T3 token is presented. Upgrade Agent Tag before pointing it at a newer protocol.

A failed provider turn settles with one sanitized Slack notice and a stable code in audit and status output: `T3ProviderAuthPolicy` when the provider's organization rejects the login method (for Claude, HTTP 403 `oauth_not_allowed_for_organization` on a subscription login), `T3ProviderAuth` when the provider is signed out or its credential is invalid, `T3ProviderLimit` for usage limits, and `T3TurnError` otherwise. T3 sometimes reports only `Claude gave up after repeated API errors.`; that text does not carry the cause, so it stays `T3TurnError` and the operator must inspect the T3 server log.

The configured data directory must be owned by the Agent Tag user and grant no group or world access. Startup rejects a permissive existing directory because SQLite WAL and shared-memory files live beside the main mode-`0600` database.

Start the service in the foreground:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

Send `SIGINT` or `SIGTERM` to stop it. The service first prevents another worker iteration, stops Socket Mode, lets work already inside a durable worker boundary settle, and then closes SQLite. An abrupt process or machine exit is recovered from leases and stable command IDs at the next start.

The configured `maxConcurrentTasks` creates that many independent coordinator workers. SQLite still serializes turns within each task and enforces the same global bound. Interaction responses and the Slack outbox have separate workers, so a task waiting for a human does not block another task.

`limits.stalledTurn` controls a T3 turn that stays unsettled. `timeoutSeconds` bounds one polling attempt, `retryDelaySeconds` delays the same stable command before replay, and `maxAttempts` ends the operation with a durable Slack failure after the final deadline. A terminal stall says only that Agent Tag could not confirm completion; the operator must inspect T3 before retrying because the remote outcome may be unknown.

## macOS background service

Install the current checkout and validated config for the logged-in user:

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
```

The installer runs `doctor` before writing anything, installs `~/Library/LaunchAgents/dev.agent-tag.service.plist` at mode `0600`, precreates `~/Library/Logs/AgentTag` and its logs at `0700`/`0600`, bootstraps the GUI launchd domain, and waits until the process is actually running. A job that is merely registered or repeatedly exiting is not reported as healthy. A failed first install removes its generated plist.

After updating the checkout or config, validate and restart it atomically:

```sh
bun run service:upgrade -- /absolute/path/to/agent-tag.json
```

Upgrade waits for the old job to leave launchd before bootstrapping the replacement. If the replacement fails, it restores the prior plist and restarts the old job when it was previously loaded.

Remove only the generated launchd job and plist with:

```sh
bun run service:uninstall
```

Uninstall preserves the Agent Tag data directory and service logs. It is therefore reversible with `service:install`. The LaunchAgent needs the user to remain logged in, and the machine must remain awake for local T3 and Socket Mode.

## Recovery rules

- Pending and expired T3 operations replay their original T3 command and message IDs.
- Pending interaction responses replay their original response command IDs.
- A Slack send whose process died after claiming it is quarantined as `delivery-outcome-unknown` on startup. It is not automatically resent because the supported Slack API surface has no documented idempotency key.
- Slack send failures are classified (`src/slack/outbox-policy.ts`):
  - Known not delivered: 429 / `rate_limited` / `ratelimited`, connection refused or unresolvable host, `service_unavailable`. The row goes back to pending with `blocked_until` set (capped exponential backoff with jitter, never earlier than `Retry-After`). Later messages in the same thread wait behind it. After 10 attempts it fails with a `slack.outbox.retry-exhausted` audit row.
  - Ambiguous: `internal_error`, `fatal_error`, timeouts, resets after connecting, unknown errors. Quarantined as `delivery-outcome-unknown`, never resent.
  - Deterministic: `channel_not_found`, `not_in_channel`, `invalid_auth`, and similar. Failed. `invalid_blocks` and `msg_too_long` first get one resend as plain escaped text (`slack.outbox.fallback-scheduled`).
  - A rate limit (429 / `rate_limited` / `ratelimited`) also starts a cooldown for every outbox send, not just the failed row's thread: Slack may apply the limit to the channel or to `chat.postMessage` across the workspace, and does not say which. No row is claimed until `Retry-After` (or the computed backoff when Slack sent none) has passed.
  - `status` reports rows waiting out a backoff as `outbox.retryBlocked`, and an active rate-limit cooldown as `outbox.rateLimitedUntil`.
- Worker exceptions are logged by class only. Exception messages, task text, stored payloads, and credentials are not written to service logs.

The operator must reconcile quarantined Slack sends in SQLite before retrying or replacing them. An automated reconciliation command is still pending.

## Inspect work during an outage

Run `status` even when T3 is down:

```sh
bun run status -- /absolute/path/to/agent-tag.json
```

`status` opens the local store. It does not contact T3 or Slack. It reports counts, not task IDs or message text. `ready` operations can run now; `deferred` operations have a future retry or interaction time. `activeLease` means a worker owns the work, while `expiredLease` means the next worker can recover it. `stalledRetry` counts turns waiting for another configured attempt, and `stalledFailed` counts turns that exhausted the policy. `awaitingHuman` counts unanswered approvals and questions. `outcomeUnknown` counts Slack sends that need manual reconciliation. Check `oldestReadyAt` when ready work is not moving. Run `doctor` after restoring T3 and Slack access.

This status covers only events already stored by Agent Tag. [Slack's Events API](https://docs.slack.dev/apis/events-api/) is best effort, and [Socket Mode requires an acknowledgement](https://docs.slack.dev/apis/events-api/using-socket-mode/). A sleeping or disconnected host may miss events that never enter the local store; `status` cannot detect those gaps. After an outage, compare the affected Slack threads with the Agent Tag audit log before claiming recovery.

## Audit and backup

Export the complete structured audit log as newline-delimited JSON:

```sh
bun run audit -- /absolute/path/to/agent-tag.json > audit.ndjson
```

Audit rows contain identity and correlation fields plus bounded transition metadata. They do not contain Slack message bodies. Treat the export as private operational data because its IDs can still be sensitive.

Validate the entire live export without printing IDs or stored content:

```sh
bun run audit:verify -- /absolute/path/to/agent-tag.json
```

The verifier reads every page through the production audit parser, requires its count to match the durable store, reports aggregate action counts, and rejects any exact stored Slack message, memory entry, or schedule prompt found in the serialized audit records. Audit writes and reads enforce a closed action set plus non-empty actor, authority, source, target, result, and correlation fields.

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

Store migrations are append-only and run inside SQLite transactions when Agent Tag opens the database. The automated upgrade matrix constructs every historical schema version, preserves representative version-1 work, opens it through the production migrator, and requires the complete version set plus `PRAGMA quick_check = ok`. Back up before upgrading a release and run `doctor` afterward.

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

## Security audit

Check a deployment against the [threat model](../SECURITY.md):

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json
bun run security:audit -- /absolute/path/to/agent-tag.json --json
bun run security:audit -- /absolute/path/to/agent-tag.json --offline
```

The audit reads the config, the files it references, the data directory, and the macOS LaunchAgent logs. It prints each finding with a severity of `high`, `medium`, `low`, or `info`, plus a fix where one applies. It exits `1` when any finding is `high`, so it can gate a deploy or a cron job. Reports name files and credential classes but never print credential values.

| Check | Severity |
| --- | --- |
| Secret files or their directory are missing, not owned by the service user, or grant group/world access (expected `0600`/`0700`) | high |
| Data directory or database grants group/world access | high (low for SQLite `-wal`/`-shm` files inside a private data directory) |
| Config is group/world writable / world readable / group readable | high / medium / low |
| Service logs are world / group accessible | medium / low |
| A credential pattern, or a `*token`/`*secret`/`*password` field with a value, appears inline in the config | high |
| Config does not parse or validate (later checks are skipped) | high |
| Allowlist contains a wildcard / is empty | high / medium |
| Allowed user and conversation counts, admin users | info |
| T3 URL is non-loopback without TLS / non-loopback with TLS | high / medium |
| T3 token expired or expires within 3 days / within 7 days | high / medium |
| T3 token has scopes beyond `orchestration:read` and `orchestration:operate` | high |
| T3 session unreachable (or `--offline`) and the token file is older than 30 days | medium |
| A repository root is `/`, the home directory, or an ancestor of it | high |
| A repository root contains the data directory or a secret file / the config | high / medium |
| Profile runtime mode is `full-access` or `auto` / `auto-accept-edits` | high / medium |
| Profile declares `os-account` or `container` isolation, which is not enforced | medium |
| `externalWrites` is advisory | low |
| No retention configured / partly configured | low / info |
| Secret scan of the data and log directories finds a configured token or a known credential pattern (this includes the SQLite store) | high |

The T3 check calls `/api/auth/session` on the configured loopback URL with a 5-second timeout. Use `--offline` to skip it.

## Data retention

By default Agent Tag keeps Slack message text, outbox payloads, and audit rows forever. Set a retention window in days:

```json
"retention": {
  "messageDays": 30,
  "outboxDays": 30,
  "auditDays": 365
}
```

Every field is optional. A missing field keeps that data forever.

- `messageDays` replaces the stored Slack event text with `[pruned]` once the event is older than the window. It does the same for the turn text (and resolved turn text) of operations that settled before the window. Pending and in-flight operations keep their text so they can still run.
- `outboxDays` replaces the payload of delivered or failed Slack replies with `{"text":"[pruned]"}` once they settled before the window. Rows quarantined as `delivery-outcome-unknown` keep their payload, because an operator must reconcile them first.
- `auditDays` deletes audit rows older than the window.

Row IDs, idempotency keys, statuses, and timestamps are kept, so duplicate Slack deliveries are still recognised after pruning. Memory entries keep using each profile's `memory.retentionDays`.

The running service applies the policy once an hour from its maintenance loop. To apply it immediately, or to preview it:

```sh
bun run prune -- /absolute/path/to/agent-tag.json --dry-run
bun run prune -- /absolute/path/to/agent-tag.json
```

`prune` is safe to run while the service is running. It prints the cutoffs and row counts as JSON, never content. Pruning does not shrink the SQLite file on disk, and older backups still contain the pruned data, so expire backups on the same schedule.

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

## Access changes and live verification

Restart or upgrade the service after changing access configuration. Before each queued T3 turn, interaction response, or schedule, Agent Tag rechecks the stored task against the loaded workspace, user, channel, route, profile, repository, and DM-owner policy. Denied turns and interaction responses fail durably; revoked recurring schedules stop with an audit record. Queued Slack replies also recheck the task route and DM owner before sending. A sanitized failure notice may still reach an authorized shared channel after its requesting user is removed.

These checks do not revoke work already running inside T3, isolate filesystem paths or credentials, or enforce provider tool writes. The OS-isolation and credential-broker acceptance gates remain open.

Verify route revocation and normal delivery against an existing authorized test-channel thread with:

```sh
bun run verify:slack-authority -- CONFIG CHANNEL THREAD_TS
```

This command authenticates the real Slack bot, uses a temporary fixture store, rejects a queued message after removing its route, checks its denial audit, and verifies the rejected marker is absent from Slack. It then sends one test marker through the authorized route and verifies exactly one same-thread message. It does not start Socket Mode or change live tasks, schedules, or human approvals. Use a test thread with fewer than 100 replies; the verifier refuses an incomplete reply scan.

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

`cadenceSeconds` repeats at a fixed interval. For wall-clock schedules that must
stay put across DST changes, use `recurrence` instead (mutually exclusive with
`cadenceSeconds`): a standard 5-field cron expression evaluated in an IANA time
zone, for example
`"recurrence": { "kind": "cron", "expression": "0 9 * * 1-5", "timeZone": "America/New_York" }`.
`runAt` is the first run; later runs follow the cron expression. Natural-language
phrases ("every weekday at 9am", "in 2 hours") are converted to this format by
`src/routines/parse.ts`.

Then use the task, actor, and profile IDs from the private audit export:

```sh
bun run schedule:add -- CONFIG TASK_ID USER_ID PROFILE_ID SPEC.json
bun run schedule:list -- CONFIG TASK_ID USER_ID PROFILE_ID
bun run schedule:cancel -- CONFIG TASK_ID USER_ID PROFILE_ID SCHEDULE_ID
```

`kind: "agent"` adds a normal durable T3 operation when due. `kind: "reminder"` sends `Reminder: ...` through the durable Slack outbox without running a provider. Cadence is optional for a one-shot schedule and must be at least 60 seconds when present. Workspace active schedules are capped by `limits.maxActiveSchedules`.

An overdue `run-once` schedule coalesces missed intervals into one run; `skip` records the miss without dispatch. `overlapPolicy: skip` suppresses a recurring agent run while an earlier run from the same schedule is pending or in flight. `queue` preserves every due run behind normal per-task serialization.

## Host constraints

The verified runtime is macOS arm64 with Bun `1.3.13` and T3 Code `0.0.45` ([live adapter evidence](evidence/2026-10-06-t3-0.0.45.md)). The per-user LaunchAgent install, loaded-service upgrade, uninstall, and reinstall were exercised on macOS against T3 `0.0.42`. A logged-in user and awake host are still required for local T3 and Socket Mode availability. Linux service-manager behavior has not been exercised, so it remains outside the passing claim.
