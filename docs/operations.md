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

Hosts installed with `install.sh` run a standalone binary from `~/.local/bin/agent-tag`. Its subcommands replace the package scripts: `agent-tag run CONFIG` for `bun run start -- CONFIG`, `agent-tag doctor CONFIG` for `bun run doctor -- CONFIG`, and likewise for `onboard`, `service`, `status`, `audit`, `backup`, `restore`, and `schedule-add|list|cancel`; `agent-tag help` lists them. `agent-tag update` verifies and atomically replaces the binary; restart the foreground process, or run `agent-tag service restart`, afterward. `agent-tag service install` from the binary writes a LaunchAgent or systemd unit that runs the binary itself (`agent-tag run CONFIG`, symlinks resolved to the file `update` replaces) from the config's directory, so the service needs neither Bun nor a checkout. See [install](install.md).

## Onboarding

`bun run onboard` (or `agent-tag onboard`) is a plain readline wizard. It walks through these steps, and every answer also has a flag:

1. Acknowledge that agents run as your OS user with access to the configured repositories, so only users you would trust with a shell should be allowed. Non-interactive runs require `--accept-risk`.
2. Choose the Agent Tag home (`--dir`, default `$AGENT_TAG_HOME` or `~/.agent-tag`). It creates `data/` and `secrets/` at mode `0700`. An existing home directory is left as is, and an existing config is replaced only with `--force` or after an interactive confirmation.
3. Create the Slack app. The wizard prints `config/slack-manifest.example.json` together with a `https://api.slack.com/apps?new_app=1&manifest_json=...` link that opens Slack's create-from-manifest flow. It then reads the app-level token (`xapp-`) and the bot token (`xoxb-`) from a hidden prompt, from `AGENT_TAG_SLACK_APP_TOKEN` / `AGENT_TAG_SLACK_BOT_TOKEN`, or from token files that already exist. It writes them to `secrets/` at mode `0600` and runs `auth.test` to learn the workspace ID (`--skip-slack-check` skips this check).
4. Connect T3. The wizard reads `<T3 base dir>/userdata/server-runtime.json` (`--t3-base-dir`, else `$T3CODE_HOME` or `~/.t3`, the same order T3 uses) to find the server URL (`--t3-url` overrides it) and probes it with the same environment check as `doctor`. When that check fails, because T3 is unreachable or does not speak orchestration protocol `1` (for example a nightly or `main` build), the wizard skips token minting and provider discovery and does not install the service. With `--t3-issue-token` or `--t3-admin-token-file` it stops with an error instead. Run the T3 version pinned in `t3.lock.json`. If no restricted token exists yet, it can run `t3 auth session issue --base-dir D --ttl 10m --label agent-tag-onboard --json` (`--t3-issue-token`, `--t3-bin`) or use `--t3-admin-token-file`. It issues a session only when the base dir's running server is the one at the T3 URL. If you pass `--t3-url` for an isolated instance, also pass that instance's `--t3-base-dir`; otherwise the session would come from another instance with different signing keys, so the wizard refuses (or stops, with `--t3-issue-token`). In both cases it mints a restricted token with the same checks as `bun run enroll:t3`. The administrative token is used once and never written. A session the wizard issued is revoked with `t3 auth session revoke` right after enrollment, whether enrollment succeeded or not. If revocation fails, the wizard prints the session ID and the revoke command; the session (administrative scopes, label `agent-tag-onboard`) expires on its own after 10 minutes. A token passed with `--t3-admin-token-file` belongs to you and is not revoked; issue it with a short `--ttl`.
5. Set the repositories (`--repo`, comma-separated absolute paths), `--base-branch`, `--provider` (by default the first ready T3 provider) and `--model` (by default T3's default model for the selected provider; required when T3 reports none), `--runtime-mode`, and `--profile`.
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
- Managed T3 only (`t3-token-rotation`): the last token rotation and how many replaced tokens still await revocation, from `<runtimeDir>/credential-state.json`. A replaced token still pending an hour after its grace period is a warning. External mode skips this check.
- Every profile's provider and model are ready in T3.
- Slack `auth.test` belongs to the configured workspace, and the app token can open a Socket Mode connection.
- The background service is installed, runs this install (the same checkout and Bun, or the same release binary) with the same config, matches the current unit template, and is running. A missing or stopped service is a warning, so doctor still passes before the first install.

`--fix` repairs only safe, local problems. It creates a missing data or secret directory, chmods permissive secret files and directories, regenerates a service unit whose template drifted, and restarts a stopped service. It regenerates a unit only when the installed unit already runs this install: this checkout with the same Bun, or this release binary, and the same config. A unit that runs another checkout (for example the live install, when doctor runs from a worktree or a temporary clone), another Bun, a release binary when doctor runs from a checkout (or the reverse), or another config gets a warning and is left alone. To move the service, run `agent-tag service upgrade CONFIG` from the checkout or binary it should run. A stopped service is restarted with `service restart`, which on macOS bootstraps an installed plist whose job is no longer loaded before starting it. It never writes tokens, changes the config, or touches T3 or Slack. Service repair runs only when no other check failed, because `service upgrade` reruns doctor. `--json` prints the structured report. Output never contains tokens or message text.

This build speaks T3 orchestration protocol 1 (T3 `0.0.42`–`0.0.45`). A descriptor without `orchestrationProtocolVersion` is protocol 1. Any other version makes `doctor` and `start` fail closed with `T3 server speaks orchestration protocol N; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)` before the T3 token is presented. Upgrade Agent Tag before pointing it at a newer protocol.

A failed provider turn settles with one sanitized Slack notice and a stable code in audit and status output: `T3ProviderAuthPolicy` when the provider's organization rejects the login method (for Claude, HTTP 403 `oauth_not_allowed_for_organization` on a subscription login), `T3ProviderAuth` when the provider is signed out or its credential is invalid, `T3ProviderLimit` for usage limits, and `T3TurnError` otherwise. T3 sometimes reports only `Claude gave up after repeated API errors.`; that text does not carry the cause, so it stays `T3TurnError` and the operator must inspect the T3 server log.

The configured data directory must be owned by the Agent Tag user and grant no group or world access. Startup rejects a permissive existing directory because SQLite WAL and shared-memory files live beside the main mode-`0600` database.

Start the service in the foreground:

```sh
bun run start -- /absolute/path/to/agent-tag.json
```

Send `SIGINT` or `SIGTERM` to stop it. The service first prevents another worker iteration, stops Socket Mode, lets work already inside a durable worker boundary settle, and then closes SQLite. An abrupt process or machine exit is recovered from leases and stable command IDs at the next start.

The configured `maxConcurrentTasks` creates that many independent coordinator workers. SQLite still serializes turns within each task and enforces the same global bound. Interaction responses and the Slack outbox have separate workers, so a task waiting for a human does not block another task.

`limits.stalledTurn` controls a T3 turn that stops making progress. Progress means any change in the T3 thread snapshot: its sequence, the number or newest timestamp of activities and messages, streamed message text, or turn and session state. A turn that keeps progressing is polled until it settles, however long it runs, and its final reply is posted normally.

| Key | Default | Meaning |
|---|---|---|
| `timeoutSeconds` | `300` | A turn is stalled after this many seconds with no T3 progress. |
| `retryDelaySeconds` | `30` | Delay before a stalled turn is claimed again and its stable command replayed. |
| `maxAttempts` | `5` | Stall windows allowed before the operation fails with a durable Slack notice. |
| `maxTurnSeconds` | `21600` (6 h) | Backstop on a turn's active polling time, summed across restarts and retries and excluding time spent waiting for a human. Must be at least `timeoutSeconds`. |

A terminal stall says only that Agent Tag could not confirm completion; the operator must inspect T3 before retrying because the remote outcome may be unknown. A turn that reaches `maxTurnSeconds` fails with `T3TurnCeiling`, posts a notice, and queues a durable `thread.turn.interrupt` for T3.

`limits.interactionExpirySeconds` (default `86400`, 24 h; minimum `60`, maximum 30 days) bounds how long an approval or question waits for a human. While it waits, the operation is deferred until the earliest unanswered request expires, and a Slack response wakes it immediately. If every request T3 still shows as pending already has a response in Agent Tag (queued or delivered), the turn keeps polling instead of deferring, so a response that lands while T3 catches up is never lost. Each request stops accepting responses at its own deadline (posting time plus the expiry), even before the coordinator's next poll closes it, so a late click is never delivered to T3. When the wait expires, Agent Tag closes the requests (late button clicks are ignored), posts a notice, fails the operation with `InteractionExpired`, and queues a durable `thread.turn.interrupt`. The next queued message in the thread starts once that interrupt has been delivered to T3, or has failed terminally.

`t3.watch` (optional; defaults shown in the table) controls how the service talks to T3 while turns run. The service keeps one shared T3 connection. The T3 session is inspected once and cached, and re-inspected before it expires, when the token file changes on disk (checked at most every 5 s), or after T3 answers 401 or 403. One long-lived WebSocket is shared by all workers, and a WebSocket ticket is minted only when that socket (re)opens.

With `t3.watch.enabled`, coordinators subscribe to each running T3 thread's event stream (`orchestration.subscribeThread`, one subscription per thread shared by all waiters) and re-read the thread snapshot when a settlement-relevant event arrives, instead of polling every 500 ms. Streamed text and tool-progress events do not trigger a re-read, but they still count as progress for the stalled-turn timer.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When `false`, the service falls back to the 500 ms snapshot poll. |
| `safetyPollMs` | `15000` (1000–60000) | Longest wait between snapshot reads while a turn runs, even if no event arrives. Also capped at half the lease and at the stall deadline. If the stream dies, turns still settle at this cadence. |
| `lingerMs` | `30000` (0–600000) | How long a thread's subscription stays open after its turn ends, so a follow-up turn reuses it. |

Every 60 s the service logs `t3.connection.stats` with the counters `sessionInspects`, `wsTickets`, `wsConnects`, `snapshotFetches`, `rpcCalls`, and `watchedThreads`. Other connection events are `t3.connection.opened`, `t3.connection.reconnect`, `t3.connection.lost`, `t3.connection.rotated` (the token file changed, so the socket is replaced after the new token passes inspection), and `t3.connection.closed`; watch events are `t3.watch.subscribed`, `t3.watch.ended`, `t3.watch.failed`, `t3.watch.resync`, and `t3.watch.released`. Logs never contain the token or the WebSocket ticket URL.

## T3 token rotation

The restricted T3 token (scopes `orchestration:read orchestration:operate`) lasts 30 days. Each token Agent Tag mints is labeled `agent-tag-orchestration-YYYYMMDDTHHMMSSZ-xxxxxx` (UTC time plus 6 random hex characters, so two rotations in the same second get distinct labels).

With `t3.mode: "managed"` the service owns the token:

- At startup, after the managed runtime is ready, it mints a token when the token file is missing or T3 rejects it.
- Every 6 h it checks expiry and rotates when fewer than `t3.managed.rotation.rotateBeforeDays` days are left. When the T3 connection reports a 401/403 (or a revoked token), it checks at once and rotates, at most once per 5 minutes.
- A rotation issues a 10-minute admin session with `t3 auth session issue`, mints the new token, verifies its scopes and that it cannot reach admin endpoints, writes it atomically over the token file (`0600`), and revokes the admin session in `finally`. Admin tokens are held in memory only.
- The replaced token is recorded in `<runtimeDir>/credential-state.json` and revoked after `revokeGraceMinutes`, so turns already running keep working. Only that token is revoked, matched by its exact label; other clients, including other `agent-tag-orchestration-*` tokens and the current one, are never touched. A token without an Agent Tag label (for example one from `bun run enroll:t3`) is never revoked: the service logs `t3.token.revoke_skipped` and it expires on its own.
- A revoke that T3 does not confirm is retried with backoff (1, 2, 4, 8, 16 minutes after each failed attempt, recorded as `nextAttemptAt`). After 6 attempts the service gives up, logs it, and leaves the token to expire.
- Nothing is sent to a T3 that failed the version or protocol gate, and an unreachable T3 never causes a rotation.

| Key | Default | Meaning |
|---|---|---|
| `t3.managed.rotation.rotateBeforeDays` | `7` (1–25) | Rotate when fewer than this many days are left. |
| `t3.managed.rotation.revokeGraceMinutes` | `15` (1–1440) | How long a replaced token keeps working before it is revoked. |

With `t3.mode: "external"` the service cannot mint tokens. It logs `t3.token.expiring` as a warning from 7 days before expiry, and as an error from 1 day before, when the token is missing, or when T3 rejects it. The log line includes the rotate command.

Rotate by hand with:

```sh
agent-tag t3 rotate CONFIG                                   # managed: the runtime must be running
agent-tag t3 rotate CONFIG --admin-token-file FILE           # external: an admin token for that T3
agent-tag t3 rotate CONFIG --t3-base-dir DIR [--t3-bin BIN]  # external: issue an admin session from the T3 base dir
```

It prints `{mode, tokenFile, label, expiresAt, daysRemaining, previousToken}`. In managed mode the running service revokes the old token after the grace period. In external mode the old token is not revoked; it expires on its own. A running service picks up the new token file within 5 s. `agent-tag t3 status CONFIG` reports `token.expiresAt`, `token.daysRemaining`, `token.label`, `token.rotatedAt` and `token.pendingRevocations`.

Log events: `t3.token.rotated`, `t3.token.rotate_failed`, `t3.token.expiring`, `t3.token.revoked`, `t3.token.revoke_skipped` (the token has no Agent Tag label, the client list was unreadable, T3 failed, or retries ran out; the token expires on its own), and `t3.token.admin_revoke_failed` (the admin session expires within 10 minutes). None contains a token.

## Background service

One command works on both platforms: `agent-tag service install|upgrade|uninstall|status|restart|logs [CONFIG]`. Each `bun run service:<action>` script runs exactly that command, so the scripts behave the same on macOS (launchd) and Linux (systemd). `logs` accepts `--lines N` (default 200) and `--follow`. `status` prints JSON with `installed`, `loaded`, `running`, the unit path, and hints. Both platforms run `doctor` before installing or upgrading.

### macOS (launchd)

Install the current checkout (or, from a release binary, that binary) and validated config for the logged-in user:

```sh
bun run service:install -- /absolute/path/to/agent-tag.json
bun run service:status
bun run service:logs -- --follow    # tails ~/Library/Logs/AgentTag/*.log
bun run service:restart             # launchctl kickstart -k
```

`restart` kickstarts a loaded job. If the plist is installed but its job is not loaded in the GUI domain (for example after `launchctl bootout`, a failed bootstrap, or a logout), it bootstraps the plist first and then starts it, instead of failing with "Could not find service".

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

Install writes `agent-tag.service` at mode `0600` to `$XDG_CONFIG_HOME/systemd/user/` (default `~/.config/systemd/user/`). The unit runs `bun run src/cli.ts run CONFIG` from the checkout, or `agent-tag run CONFIG` from the config's directory when installed from a release binary, with absolute, quoted paths and sets `Restart=always`, `RestartSec=10`, `StartLimitIntervalSec=0`, `UMask=0077`, and `NoNewPrivileges=true`. `agent-tag run` exits when T3 is unreachable at startup, so the unit disables systemd's start rate limit and keeps retrying every 10 seconds while T3 boots or upgrades, like the LaunchAgent's `KeepAlive`. The unit has no `network-online.target` dependency because a `--user` manager cannot order against system targets; the retry loop covers a late network. Install then runs `systemctl --user daemon-reload` and `enable --now` and waits for the unit to report `running`. Install, upgrade, and restart run `systemctl --user reset-failed` first, so a unit left in the failed state still starts. If the first install fails, the unit file is removed. Upgrade rewrites the unit and restarts it, and puts back the prior unit if the restart fails. Uninstall runs `disable --now`, removes the unit, and reloads. The data directory and journal remain.

By default a user manager stops when the user's last session ends. When lingering is off, `status` and `install` print the fix:

```sh
sudo loginctl enable-linger "$USER"
```

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

`status` opens the local store. It does not contact T3 or Slack. It reports counts, not task IDs or message text. `ready` operations can run now; `deferred` operations have a future retry or interaction time. `activeLease` means a worker owns the work, while `expiredLease` means the next worker can recover it. `stalledRetry` counts turns waiting for another configured attempt, and `stalledFailed` counts turns that exhausted the policy. Expired waits and ceiling failures appear in the audit export as `operation.failed` with `InteractionExpired` or `T3TurnCeiling`, and expired requests as `interaction.expired`. Requests left open when a turn hits its ceiling appear as `interaction.closed` with `abandoned`; responses still queued or in flight when an operation fails, is interrupted or completes are closed with `operation-settled` and never reach T3 (a turn is not completed or cancelled while T3 still awaits one of its accepted responses, or a message-mode answer's continuation turn, so those closes only drop responses T3 no longer awaits); a request a later turn takes over from an earlier one appears as `interaction.adopted`. `awaitingHuman` counts unanswered approvals and questions. `outcomeUnknown` counts Slack sends that need manual reconciliation. Check `oldestReadyAt` when ready work is not moving. Run `doctor` after restoring T3 and Slack access.

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

Scan the Agent Tag checkout for common Slack, GitHub (classic and fine-grained `github_pat_`), AWS, Anthropic, and OpenAI credential shapes and PEM private key headers:

```sh
bun run scan:secrets -- /absolute/path/to/agent-tag
```

Add `--config` to load the three configured service credentials as exact canaries and scan the live data directory plus every authorized repository. Extra roots after the config are also scanned:

```sh
bun run scan:secrets -- --config /absolute/path/to/agent-tag.json /absolute/path/to/agent-tag
```

The JSON report names only the file, credential class, and configured canary label. It never returns matched values. The command skips `.git` and `node_modules`. A file or directory that cannot be read (for example `EACCES`) does not stop the scan: findings from every readable file are still reported, and the unreadable paths are listed under `skippedEntries` with an error code. A finding, skipped symbolic link, or skipped entry sets a nonzero exit code, so a release check cannot silently claim a partial clean scan. The scan re-lists the tree after reading it and reads any file it has not seen yet or whose size or modification time changed, so a log rotated or appended to mid-scan is still checked; a file that is still changing after four passes is reported as `changed during the scan`. Keep source secret files outside scanned roots when practical; if they are inside, the configured scan excludes those exact files and scans their siblings.

## Security audit

Check a deployment against the [threat model](../SECURITY.md):

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json
bun run security:audit -- /absolute/path/to/agent-tag.json --json
bun run security:audit -- /absolute/path/to/agent-tag.json --offline
bun run security:audit -- /absolute/path/to/agent-tag.json --log-dir /var/log/agent-tag
```

The audit reads the config, the files it references, the data directory, and the service logs. Logs default to the macOS LaunchAgent directory, `~/Library/Logs/AgentTag`. On Linux, or under any other process manager, pass `--log-dir` with the directory your logs are written to. The audit checks the mode of every file at the top of that directory, including rotated logs, and scans the whole directory for credentials. If the directory does not exist, the audit reports `log-directory-missing` instead of passing silently. Logs that go only to journald or another log service are not checked. It prints each finding with a severity of `high`, `medium`, `low`, or `info`, plus a fix where one applies. It exits `1` when any finding is `high`, so it can gate a deploy or a cron job. Reports name files and credential classes but never print credential values.

| Check | Severity |
| --- | --- |
| Secret files or their directory are missing, not owned by the service user, or grant group/world access (expected `0600`/`0700`) | high |
| A checked path is a symbolic link in a directory other users can write (they can repoint it) / any other symbolic link (owner and mode are then checked on the target) | high (medium for logs) / info |
| The auditing user cannot inspect a config, secret, data, or database path (for example `EACCES`); run the audit as the service user | high (low for logs) |
| Data directory or database grants group/world access | high (low for SQLite `-wal`/`-shm` files inside a private data directory) |
| Config is group/world writable / world readable / group readable | high / medium / low |
| The config, secret directory, data directory, or log directory (or a symlink's target) is in a directory that is group/world writable without the sticky bit, or owned by another non-root user, so it can be replaced regardless of its own mode | high (medium for the log directory) |
| Service logs are world / group accessible | medium / low |
| Log directory not found, so logs were not checked (pass `--log-dir`) | low |
| A credential pattern, or a `*token`/`*secret`/`*password` field with a value, appears inline in the config | high |
| Config is not readable JSON (later checks are skipped) | high |
| Config fails validation. The service refuses to start; the audit still runs every check below on the fields it can read, but does not query T3 | high |
| Allowlist contains a wildcard / is empty | high / medium |
| Allowed user and conversation counts, admin users | info |
| T3 URL is non-loopback without TLS / non-loopback with TLS | high / medium |
| T3 refuses the token (HTTP 401 or 403: expired, revoked, or not a T3 token) | high |
| T3 token expired or expires within 3 days / within 7 days | high / medium |
| T3 token has scopes beyond `orchestration:read` and `orchestration:operate` | high |
| T3 session unreachable (or `--offline`) and the token file is older than 30 days | medium |
| A repository root is `/`, the home directory, or an ancestor of it | high |
| A repository root contains the data directory or a secret file / the config | high / medium |
| Profile runtime mode is `full-access` or `auto` / `auto-accept-edits` | high / medium |
| Profile declares `os-account` or `container` isolation, which is not enforced | medium |
| `externalWrites` is advisory | low |
| No retention configured / partly configured | low / info |
| Secret scan of the data and log directories finds a configured token or a known credential pattern. For the SQLite store the fix links to [purging content](#purging-content-from-the-store) | high |
| Secret scan could not read a file or directory, or the scan could not run at all. Findings from readable files are still reported; each unchecked path is listed (up to 20) | high |

Repository-root containment is decided after resolving every symbolic link in each root, the home directory, and each protected path, including parent directories, so a root that links to the home directory (or a data directory under macOS `/tmp`, which links to `/private/tmp`) is still caught.

The T3 check calls `/api/auth/session` on the configured loopback URL with a 5-second timeout. Use `--offline` to skip it. Runtime approval settings are only checked in the profile: Agent Tag sends the profile's `runtimeMode` with every turn it starts, so the defaults of the T3 provider instance never apply to its turns.

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

- `messageDays` replaces the stored Slack event text with `[pruned]` once the event is older than the window. It does the same for the turn text (and resolved turn text) of operations that settled before the window. Pending and in-flight operations keep their text so they can still run. Schedules that ended (cancelled, auto-disabled or completed) before the window get the same treatment for their prompt; active schedules keep it. Thread updates that a turn already consumed have their text replaced the same way; updates still pending past the window are deleted. Draft PR jobs that settled before the window have their stored request and summary text replaced too; pending jobs keep it for the PR title and body.
- `outboxDays` replaces the payload of delivered or failed Slack replies with `{"text":"[pruned]"}` once they settled before the window. Rows quarantined as `delivery-outcome-unknown` keep their payload, because an operator must reconcile them first.
- `auditDays` deletes audit rows older than the window.

Row IDs, idempotency keys, statuses, and timestamps are kept, so duplicate Slack deliveries are still recognised after pruning. Memory entries keep using each profile's `memory.retentionDays`.

The running service applies the policy once an hour from its maintenance loop. To apply it immediately, or to preview it:

```sh
bun run prune -- /absolute/path/to/agent-tag.json --dry-run
bun run prune -- /absolute/path/to/agent-tag.json
```

`prune` is safe to run while the service is running. It prints the cutoffs and row counts as JSON, never content. Each real prune turns on SQLite `secure_delete`, so the pages it rewrites are zeroed rather than left in free space. It then checkpoints and truncates the write-ahead log (`agent-tag.sqlite-wal`), so old copies of those pages do not stay on disk. If a long read holds the log open for more than 5 seconds, the truncate is skipped and the next prune retries it. Pruning does not shrink the SQLite file on disk, and older backups still contain the pruned data, so expire backups on the same schedule.

### Purging content from the store

`prune` only redacts rows older than the retention window. It never touches interactions, schedules, schedule runs, memory entries, or recent messages. When `security audit` reports `secret-at-rest` on `agent-tag.sqlite` (or its `-wal` file), for example because someone pasted a credential into Slack:

1. Rotate the credential first. Treat it as exposed, whatever happens to the copy on disk.
2. Stop the service (`bun run service:uninstall`, or your process manager) and copy `dataDir` to a private location.
3. Overwrite every row that holds the value. Message text can be in `slack_events.text`, `operations.payload_json` and `operations.resolved_text`, `slack_outbox.payload_json`, `interactions`, `memory_entries`, and `schedules`. Use `sqlite3` with `instr()`, and read the value from a file rather than typing it on the command line.
4. Rebuild the file so no freed page keeps the old bytes. Either run `sqlite3 /path/to/agent-tag.sqlite 'VACUUM'`, or run `bun run backup` (it writes a compacted copy with `VACUUM INTO`) followed by `bun run restore` into a new data directory, and point the config at it.
5. Start the service, re-run `bun run security:audit`, then delete the copy from step 2 and any older backups that hold the value.

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

## Commands

A message that starts with `@Agent Tag !<command>` runs a command instead of a request. In a DM route the owner can drop the mention and send `!status` directly. The command word must come right after the mention; `@Agent Tag please !help` is an ordinary request.

| Command | Where | What it does |
| --- | --- | --- |
| `!help` | anywhere | Lists the commands enabled here. Only the sender sees it. |
| `!status` | anywhere | In a thread: whether the agent is working, waiting on an approval or question, or has requests queued, plus the thread's model and mute state. At the top level: a count across the channel's threads. Only the sender sees it. |
| `!mute` | a thread the agent is part of | Stops the agent answering unmentioned replies in that thread. Posts a public notice. |
| `!unmute` | a thread the agent is part of | Reverses `!mute`. Any message that mentions the agent in a muted thread also unmutes it. |

Commands never create a T3 turn and never store the message text. Each run is recorded once per Slack message in `slack_command_events` and audited as `slack.command.executed` or `slack.command.denied`; mute changes are audited as `thread.muted` and `thread.unmuted`. Other `!words` (for example `!model`) are still treated as ordinary requests until their commands ship.

Configure commands under `commands`:

```json
{
  "access": { "allowedUserIds": ["U0EXAMPLE"], "allowedChannelIds": ["C0EXAMPLE"], "adminUserIds": ["U0EXAMPLE"] },
  "commands": { "enabled": true, "disabled": [], "adminOnly": ["mute", "unmute"] }
}
```

- `enabled: false` turns every `!word` back into an ordinary request.
- `disabled` answers with an only-you "not enabled" note. `!help` cannot be disabled.
- `adminOnly` limits a command to `access.adminUserIds`, which must also be in `access.allowedUserIds`. `!help` and `!status` cannot be admin-only.

Only-you replies use `chat.postEphemeral` (covered by the existing `chat:write` scope). They are sent at most once, with one retry after a rate limit.

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

## GitHub pull requests (draft PRs, `auto` mode)

With `pullRequests.mode: "auto"` on a profile, every completed turn on a configured repository root ends with a snapshot of the task worktree. Leftover changes are committed on `agent-tag/<taskId>`, the branch is pushed with Agent Tag's own token, and the thread gets one draft PR card. Later turns in the same thread push to the same PR and post a one-line "Pushed N commits" update. A turn that changed nothing posts nothing. Configs without these keys stay valid, and `pullRequests` defaults to `{ "mode": "off" }`; with `off` no git process runs at all.

How it runs:

- The snapshot runs in the coordinator after the agent's final reply and before the reply is queued. The PR job is recorded in the same transaction as the reply, keyed by the operation, so a crash or replay never makes two jobs.
- A separate PR worker claims jobs one task at a time, re-checks that the requester is still authorized and the profile still maps the root to the same repository, pushes, then finds the PR by head branch before creating one. A lost response from GitHub therefore never opens a second PR.
- GitHub rate limits and transient failures retry with backoff (30 s doubling, six attempts). A rejected token, a missing repository, or exhausted retries post one notice in the thread.
- Blocked pushes (a credential in the diff, or a diff over `maxChangedFiles`/`maxDiffBytes`) post one notice with the reply and never push. A snapshot failure posts the reply, then a short context line.
- If the PR was merged or closed, the next job posts one notice and stops; later jobs in that thread stop quietly. Start a new thread for new work. A non-fast-forward push (someone else pushed to the branch) posts a notice and is never forced.
- The agent is told in its turn text that Agent Tag pushes for it and that it has no GitHub write credentials.
- `agent-tag doctor` checks the token file, `git --version` (2.38 or newer), and push access to every configured repository. Fine-grained tokens do not report permissions, so for them push access is confirmed on the first push.

```jsonc
"github": {                                   // top-level, optional
  "apiBaseUrl": "https://api.github.com",     // GHES: https://ghe.example/api/v3
  "webBaseUrl": "https://github.com",         // GHES: https://ghe.example
  "auth": { "type": "token", "tokenFile": "/abs/secrets/github-token" }
},
"profiles": [{
  "pullRequests": {
    "mode": "auto",                           // "off" (default) | "auto"; "button" is reserved and rejected
    "repositories": [{ "root": "/abs/repo", "repo": "owner/name", "baseBranch": "main" }],
    "draft": true,
    "commitAuthor": { "name": "Agent Tag", "email": "agent-tag@users.noreply.github.com" },
    "maxChangedFiles": 300,
    "maxDiffBytes": 2000000,
    "secretScan": "block"                     // "block" (default) | "off"
  }
}]
```

Validation rules:

- A mode other than `off` requires the top-level `github` block.
- Every `repositories[].root` must be in the profile's `repositoryRoots`, and each root can appear only once.
- `repo` must be `owner/name`. `baseBranch` defaults to the profile's `baseBranch`.
- A profile with `externalWrites.mode: "deny"` must keep `pullRequests.mode` set to `off`.
- `mode: "button"` (a human approves each PR in Slack) is not available yet and is rejected.
- `apiBaseUrl` and `webBaseUrl` must be `https` URLs without credentials. Only `auth.type: "token"` is supported for now. GitHub App auth comes in a later release.

### Creating the token

Use a fine-grained personal access token limited to the repositories you configure, with **Contents: read and write**, **Pull requests: read and write**, and **Metadata: read**. Store it the same way as the Slack and T3 tokens: one line in a file with mode `0600`, inside a directory with mode `0700`, both owned by the Agent Tag user. The file is re-read for every job, so you can rotate the token without a restart. Protect the base branch with branch protection and required reviews. Agent Tag only opens drafts and never force-pushes, but the token can push to any unprotected branch of the granted repositories.

### How the credential is handled

- The token is read by Agent Tag only. It never goes into the agent's worktree, a git config file, a remote URL, a process's argv, or a log line. Errors from git and GitHub are redacted before they are returned.
- Git runs without a shell, in its own process group. Each call has a timeout, which also kills any filter or helper git started, and a cap on captured output, and its environment is limited to `PATH`, `HOME`, and `LANG` plus `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_GLOBAL=/dev/null`. Each call also passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false`. Diffs use `--no-ext-diff --no-textconv`. As a result, hooks, fsmonitor, diff drivers, and `url.*.insteadOf` rules in the repository's `.git/config` or the user's `~/.gitconfig` do not run or take effect.
- Leftover changes are committed in the worktree, with no credential present, and only if that worktree is listed by the configured repository and shares its git directory. They are then fetched into a bare mirror owned by Agent Tag at `<dataDir>/git/<owner>/<repo>.git` (mode `0700`). The push runs from that mirror to `{webBaseUrl}/{owner}/{repo}.git`. Git gets the token through `GIT_ASKPASS=<dataDir>/git/askpass.sh`, a fixed script with no secret in it, and `AGENT_TAG_GIT_TOKEN`, which is set only in the environment of that one `git push` child. `-c credential.helper=` stops git from asking or writing to the keychain or `gh` helpers. If the mirror's config has a key Agent Tag did not write, the push is refused.
- Before anything is pushed, the net diff, the patch of every new commit, and the message and author of every new commit are scanned with the same credential patterns as `scan:secrets`. These patterns also cover `github_pat_` tokens and private key headers. A hit blocks the push. A credential that one commit adds and a later commit deletes is still blocked, because the push would carry it, so history must be rewritten to remove it. Changes over `maxChangedFiles` or `maxDiffBytes` are blocked too, including when the patches of the new commits together exceed `maxDiffBytes`. If any output a guard depends on is cut off at the capture limit, the step fails rather than checking only part of it. Rejected (non-fast-forward) pushes are reported and never forced.

In `trusted-same-user` isolation the agent runs as the same OS user and could read `tokenFile` directly. These measures make sure the token is never handed to the agent; they do not make the file unreadable to it. Use `os-account` or `container` isolation for that.

## Host constraints

The verified runtime is macOS arm64 with Bun `1.3.13` and T3 Code `0.0.45` ([live adapter evidence](evidence/2026-10-06-t3-0.0.45.md)). The per-user LaunchAgent install, loaded-service upgrade, uninstall, and reinstall were exercised on macOS against T3 `0.0.42`. A logged-in user and awake host are still required for local T3 and Socket Mode availability. The Linux `systemd --user` manager is implemented and covered by unit tests against a scripted `systemctl`, but it has not been run on a live Linux host, so it remains outside the passing claim.
