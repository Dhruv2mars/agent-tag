# T3 runtime

Agent Tag does no agent work itself. Every turn runs in [T3 Code](https://github.com/pingdotgg/t3code), which drives the provider (Codex, Claude, or any other T3 supports) under the host's OS user. This page covers the T3 side: which T3 Agent Tag speaks, how a managed T3 is installed, supervised and rotated, how the service keeps its connection, and which models a profile may use. Choosing managed or external T3 at install time is in [Install](install.md#t3-managed-or-external).

## Version and protocol

The T3 release Agent Tag runs is pinned in `t3.lock.json`, with a sha256 per platform. `bun run verify:t3-pin` checks the pin against the GitHub release (and a local binary when `AGENT_TAG_T3_BIN` is set).

This build speaks T3 orchestration protocol 1 (T3 `0.0.42`–`0.0.45`). A descriptor without `orchestrationProtocolVersion` is protocol 1. Any other version makes `doctor` and `start` fail closed with `T3 server speaks orchestration protocol N; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)` before the T3 token is presented. Upgrade Agent Tag before pointing it at a newer protocol.

## Managed T3

With `t3.mode: "managed"`, Agent Tag owns its T3 server. Every key except `mode` and `tokenFile` is optional:

| Key | Default | Meaning |
|---|---|---|
| `t3.port` | `37841` | Loopback port for `t3 serve`; `baseUrl` becomes `http://127.0.0.1:<port>`. |
| `t3.homeDir` | `<dataDir>/t3/home` | T3's `--base-dir` (its SQLite, logs, environment id). Must not be the desktop T3's `~/.t3` or `$T3CODE_HOME`. |
| `t3.runtimeDir` | `<dataDir>/t3/runtime` | Verified binaries, `state.json` (downgrade guard) and `credential-state.json`. |
| `t3.autoInstall` | `true` | Download the pinned T3 at startup when it is missing or does not verify. |
| `t3.downloadBaseUrl` | GitHub releases | https mirror laid out as `<base>/<tag>/<asset>`. |
| `t3.rotation` | see [T3 token rotation](#t3-token-rotation) | Token rotation thresholds. |

**Install.** The only trust root is the sha256 in `t3.lock.json`. The archive is streamed to a private staging directory (256 MiB cap) and hashed. Every tar entry must be a regular file or directory under the one expected top directory, which is checked before anything is extracted. `t3 --version` must print the pinned version. The tree is then renamed into `versions/<version>/` with a record of every file's hash. Each start re-hashes the install; a changed file logs `t3.install.tampered` and is reinstalled. The pinned version and the newest one other version are kept; older ones are pruned. Each version is about 205 MB.

**Downgrade guard.** T3 migrates its database forward only. Once a version has started against `homeDir`, a build pinned to an older T3 refuses to start (`T3DowngradeError`) rather than open that database. Keep the newer Agent Tag, or point `homeDir` at a fresh directory.

**Supervision.** The service starts `t3 serve --host 127.0.0.1 --port <port> --base-dir <homeDir>` before anything else. It waits up to 60 s for `/.well-known/t3/environment` to report the pinned version and protocol `1`, and for `server-runtime.json` to name the pid it spawned. T3 inherits your environment (`HOME`, `PATH`, provider logins) minus every `AGENT_TAG_*` and `T3CODE_*` variable. Its stdout, which carries a pairing credential, is discarded. Its stderr is redacted, rate-limited, and logged as `t3.runtime.stderr`. If something else already listens on the port, startup fails with `T3PortInUseError`; Agent Tag never sends a token to a server it did not start. When T3 exits unexpectedly it is restarted with backoff (1 s doubling to 60 s), logged as `t3.runtime.restarted`. Five restarts within 10 minutes log `t3.runtime.crashloop` and stop the service with exit code 75, so launchd or systemd restarts it. If Agent Tag itself is killed, the next start finds the orphaned `t3 serve` through `server-runtime.json` and `ps`, stops it (`t3.runtime.orphan_reaped`), and starts a fresh one. Stopping the service stops its workers first, then T3 (SIGTERM, SIGKILL after 15 s).

**Gate.** Every 60 s (every 10 s while closed, and after each restart) the service re-reads the environment descriptor. Another protocol, another version, a changed environment id, or no answer closes the gate (`t3.gate.closed`). While it is closed, coordinators, interaction workers and schedules pause; Slack ingestion, the outbox and maintenance keep running, so mentions queue and drain once the gate reopens (`t3.gate.opened`).

**Commands.**

```sh
agent-tag t3 install CONFIG   # download and verify only; prints {version, binary, sha256, downloaded}
agent-tag t3 status CONFIG    # install, runtime and token as JSON; never starts T3 or prints a token
agent-tag t3 serve CONFIG     # the managed T3 in the foreground without Slack, for debugging
agent-tag t3 pair CONFIG      # a 5-minute link that pairs a browser with the managed T3's web UI
```

`t3 status` prints `mode`, `version`, `binarySha256Verified`, `filesVerified`, `pid`, `protocol`, `runtime` and `token.{expiresAt, daysRemaining, label, rotatedAt, pendingRevocations}`. Agent threads live in the managed T3, not your desktop T3. Open them with `t3 pair`, which prints the link only to a terminal (pass `--allow-non-tty` to override). Treat that link like a password until it expires.

Configure providers once in the managed T3 (through `t3 pair`) if T3's defaults are not enough. Provider logins under `HOME` (`~/.codex`, Claude) are shared with your own use.

Managed mode was verified live on macOS arm64 ([evidence](evidence/2026-10-21-t3-managed.md)). The Linux x64 and arm64 artifacts are pinned and their digests are checked by `bun run verify:t3-pin`, but they have not had a live run yet.

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

## The T3 connection

`t3.watch` (optional; defaults shown in the table) controls how the service talks to T3 while turns run. The service keeps one shared T3 connection. The T3 session is inspected once and cached, and re-inspected before it expires, when the token file changes on disk (checked at most every 5 s), or after T3 answers 401 or 403. One long-lived WebSocket is shared by all workers, and a WebSocket ticket is minted only when that socket (re)opens.

With `t3.watch.enabled`, coordinators subscribe to each running T3 thread's event stream (`orchestration.subscribeThread`, one subscription per thread shared by all waiters) and re-read the thread snapshot when a settlement-relevant event arrives, instead of polling every 500 ms. Streamed text and tool-progress events do not trigger a re-read, but they still count as progress for the stalled-turn timer.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When `false`, the service falls back to the 500 ms snapshot poll. |
| `safetyPollMs` | `15000` (1000–60000) | Longest wait between snapshot reads while a turn runs, even if no event arrives. Also capped at half the lease and at the stall deadline. If the stream dies, turns still settle at this cadence. |
| `lingerMs` | `30000` (0–600000) | How long a thread's subscription stays open after its turn ends, so a follow-up turn reuses it. |

Every 60 s the service logs `t3.connection.stats` with the counters `sessionInspects`, `wsTickets`, `wsConnects`, `snapshotFetches`, `rpcCalls`, and `watchedThreads`. Other connection events are `t3.connection.opened`, `t3.connection.reconnect`, `t3.connection.lost`, `t3.connection.rotated` (the token file changed, so the socket is replaced after the new token passes inspection), and `t3.connection.closed`; watch events are `t3.watch.subscribed`, `t3.watch.ended`, `t3.watch.failed`, `t3.watch.resync`, and `t3.watch.released`. Logs never contain the token or the WebSocket ticket URL.

## Models and providers

Each profile runs on `defaultProviderInstanceId` / `defaultModel` unless people pick something else. `allowedModels` lists what else a thread may use (up to 20 entries); with no entries, threads stay on the default:

```json
"allowedModels": [
  { "instanceId": "codex", "model": "gpt-5.6-mini", "label": "GPT Mini", "aliases": ["mini"] },
  { "instanceId": "claudeAgent", "model": "claude-opus-5-5", "label": "Opus 5.5", "aliases": ["opus"] }
]
```

`instanceId` is the T3 provider instance (as `doctor` lists it), `label` is the name Slack replies use, and `aliases` are short lowercase names people can type. A route can set its own `defaultModel` (`{ "instanceId", "model" }`) for one channel; it must be the profile default or one of its `allowedModels`. `modelSwitch.enabled: false` on a profile turns switching off; `modelSwitch.crossProvider: "deny"` keeps every thread on its default's provider. `agent-tag doctor` reports each allowed entry as `available` or the reason T3 can't serve it, and never fails startup over one; the service logs a `provider.allowed-model` line for each unavailable entry.

T3 0.0.45 takes its model list from a model manifest. It fetches the manifest from GitHub while running, but only applies it on its next start. A model released after T3 started, such as `claude-haiku-5-5` on 2026-10-21, shows as `model-missing` until T3 restarts. A missing profile or route default blocks startup, and Agent Tag keeps retrying. Restart T3 (managed: `agent-tag service restart`, which also restarts the managed T3), then rerun `agent-tag doctor`. Doctor's hint points there whenever it reports `model-missing`.

How people switch models from Slack, and which switches T3 0.0.45 can follow on a started thread, is in [Using Agent Tag in Slack](slack-usage.md#switching-models-from-slack).

### Licensing

Every provider in `allowedModels` is used on behalf of everyone who can reach the bot. Only list providers the organisation has approved for that shared use; see [Provider access and licensing](provider-licensing.md).
