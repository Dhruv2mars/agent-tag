# Operations

Agent Tag runs in the foreground on macOS or Linux. The same `service` command installs it as a per-user LaunchAgent on macOS or as a `systemd --user` unit on Linux. The LaunchAgent path has been exercised on a live host. The systemd path is covered by fixture tests only; see [Host constraints](#host-constraints).

Commands that take `CONFIG` fall back to `$AGENT_TAG_CONFIG` and then to `~/.agent-tag/agent-tag.json` when the argument is omitted. `bun link` installs the `agent-tag` executable, so `agent-tag doctor` is the same as `bun run doctor`.

Complete the [Slack setup](slack-setup.md) before running live checks.

Before enabling a provider for other Slack users, complete the [provider access and licensing review](provider-licensing.md). T3 readiness proves connectivity only; it does not prove that a personal subscription or session may be shared.

## Clean-checkout verification

Run the committed tree through a new frozen dependency install before release:

```sh
bun run verify:clean-install
```

The verifier refuses a dirty checkout, exports `HEAD` with `git archive`, installs from `bun.lock` in a fresh private temporary directory, runs typecheck and tests, and verifies the pinned T3 release metadata. It removes the temporary checkout afterward. The same locked install and gate run on clean GitHub-hosted macOS 15 and Ubuntu 24.04 workers in `.github/workflows/ci.yml`.

## Binary installs and updates

Hosts installed with `install.sh` run a standalone binary from `~/.local/bin/agent-tag`. Its subcommands replace the package scripts: `agent-tag run CONFIG` for `bun run start -- CONFIG`, `agent-tag doctor CONFIG` for `bun run doctor -- CONFIG`, and likewise for `onboard`, `service`, `status`, `audit`, `backup`, `restore`, and `schedule-add|list|cancel`; `agent-tag help` lists them. `agent-tag update` verifies and atomically replaces the binary; restart the foreground process afterward. The macOS LaunchAgent manager still runs from a source checkout. See [install](install.md).

## Onboarding

`bun run onboard` (or `agent-tag onboard`) is a plain readline wizard. It walks through these steps, and every answer also has a flag:

1. Acknowledge that agents run as your OS user with access to the configured repositories, so only users you would trust with a shell should be allowed. Non-interactive runs require `--accept-risk`.
2. Choose the Agent Tag home (`--dir`, default `$AGENT_TAG_HOME` or `~/.agent-tag`). It creates `data/` and `secrets/` at mode `0700`. An existing home directory is left as is, and an existing config is replaced only with `--force` or after an interactive confirmation.
3. Create the Slack app. The wizard prints `config/slack-manifest.example.json` together with a `https://api.slack.com/apps?new_app=1&manifest_json=...` link that opens Slack's create-from-manifest flow. It then reads the app-level token (`xapp-`) and the bot token (`xoxb-`) from a hidden prompt, from `AGENT_TAG_SLACK_APP_TOKEN` / `AGENT_TAG_SLACK_BOT_TOKEN`, or from token files that already exist. It writes them to `secrets/` at mode `0600` and runs `auth.test` to learn the workspace ID (`--skip-slack-check` skips this check).
4. Connect T3. The wizard reads `<T3 base dir>/userdata/server-runtime.json` (`--t3-base-dir`, else `$T3_HOME` or `~/.t3`) to find the server URL (`--t3-url` overrides it) and probes it. If no restricted token exists yet, it can run `t3 auth session issue --base-dir D --token-only` (`--t3-issue-token`, `--t3-bin`) or use `--t3-admin-token-file`. In both cases it mints a restricted token with the same checks as `bun run enroll:t3`. The administrative token is used once and never written.
5. Set the repositories (`--repo`, comma-separated absolute paths), `--base-branch`, `--provider` and `--model` (by default the first ready T3 provider), `--runtime-mode`, and `--profile`.
6. Set the allowed users (`--users U…`) and channels (`--channels C…`), plus `--max-concurrent-tasks`. Each channel gets a route to the profile. DM routes stay manual; see [DM routes](#dm-routes).
7. Validate the result with the config schema and write `agent-tag.json` atomically at mode `0600`. Then offer to install the service (`--install-service` / `--no-install-service`).

`--yes`, `--non-interactive`, or a stdin that is not a TTY makes every prompt fall back to its flag or default. A required value with no default stops the run with an error rather than guessing. A fully scripted install looks like this:

```sh
AGENT_TAG_SLACK_APP_TOKEN=... AGENT_TAG_SLACK_BOT_TOKEN=... \
bun run onboard -- --yes --accept-risk \
  --repo /srv/agent/repo --users U0123ABC --channels C0123ABC \
  --t3-issue-token --install-service
```

## Doctor

Run a live dependency check before starting:

```sh
bun run doctor -- /absolute/path/to/agent-tag.json [--fix] [--json]
```

Doctor reports each check as `PASS`, `WARN`, `FAIL`, or `SKIP` and exits non-zero only on a failure. It checks, in order:

- Bun against the `package.json` engine minimum and pin.
- Config schema validity. If the config is invalid, doctor stops after this check.
- The data directory is owned by this user, private, and writable.
- Each secret file (Slack app token, Slack bot token, T3 token) is a regular `0600` file in a `0700` directory owned by this user, and each token has its expected prefix.
- The SQLite store opens and migrates.
- T3 is reachable, and `/.well-known/t3/environment` reports orchestration protocol `1`. A missing field counts as `1`, and an older server without the endpoint gives a warning.
- The T3 server version matches `t3.lock.json`. A mismatch is a warning.
- The restricted T3 session has exactly the orchestration scopes, has not expired, and warns within 7 days of expiry.
- Every profile's provider and model are ready in T3.
- Slack `auth.test` belongs to the configured workspace, and the app token can open a Socket Mode connection.
- The background service is installed, runs this checkout with the same Bun and config, matches the current unit template, and is running. A missing or stopped service is a warning, so doctor still passes before the first install.

`--fix` repairs only safe, local problems. It creates a missing data or secret directory, chmods permissive secret files and directories, regenerates a service unit whose template drifted, and restarts a stopped service. It regenerates a unit only when the installed unit already runs this checkout, with the same Bun and config. A unit that runs another checkout (for example the live install, when doctor runs from a worktree or a temporary clone), another Bun, or another config gets a warning and is left alone. To move the service, run `agent-tag service upgrade CONFIG` from the checkout it should run. It never writes tokens, changes the config, or touches T3 or Slack. Service repair runs only when no other check failed, because `service upgrade` reruns doctor. `--json` prints the structured report. Output never contains tokens or message text.

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

## Background service

One command works on both platforms: `agent-tag service install|upgrade|uninstall|status|restart|logs [CONFIG]`. The `bun run service:<action>` scripts call it, and `scripts/manage-launchd.ts` still works on macOS. `logs` accepts `--lines N` (default 200) and `--follow`. `status` prints JSON with `installed`, `loaded`, `running`, the unit path, and hints. Both platforms run `doctor` before installing or upgrading.

### macOS (launchd)

Install the current checkout and validated config for the logged-in user:

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
bun run service:logs -- --follow    # tails ~/Library/Logs/AgentTag/*.log
bun run service:restart             # launchctl kickstart -k
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

### Linux (systemd --user)

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
bun run service:logs -- --follow    # journalctl --user --unit agent-tag.service
```

Install writes `agent-tag.service` at mode `0600` to `$XDG_CONFIG_HOME/systemd/user/` (default `~/.config/systemd/user/`). The unit runs `bun run src/cli.ts run CONFIG` with absolute, quoted paths and sets `Restart=always`, `RestartSec=10`, `UMask=0077`, and `NoNewPrivileges=true`. Install then runs `systemctl --user daemon-reload` and `enable --now` and waits for the unit to report `running`. If the first install fails, the unit file is removed. Upgrade rewrites the unit and restarts it, and puts back the prior unit if the restart fails. Uninstall runs `disable --now`, removes the unit, and reloads. The data directory and journal remain.

By default a user manager stops when the user's last session ends. When lingering is off, `status` and `install` print the fix:

```sh
sudo loginctl enable-linger "$USER"
```

## Recovery rules

- Pending and expired T3 operations replay their original T3 command and message IDs.
- Pending interaction responses replay their original response command IDs.
- A Slack send whose process died after claiming it is quarantined as `delivery-outcome-unknown` on startup. It is not automatically resent because the supported Slack API surface has no documented idempotency key.
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

The verified runtime is macOS arm64 with Bun `1.3.13` and T3 Code `0.0.45` ([live adapter evidence](evidence/2026-10-06-t3-0.0.45.md)). The per-user LaunchAgent install, loaded-service upgrade, uninstall, and reinstall were exercised on macOS against T3 `0.0.42`. A logged-in user and awake host are still required for local T3 and Socket Mode availability. The Linux `systemd --user` manager is implemented and covered by unit tests against a scripted `systemctl`, but it has not been run on a live Linux host, so it remains outside the passing claim.
