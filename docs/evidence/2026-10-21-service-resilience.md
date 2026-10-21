# Service resilience: T3 down at startup, managed T3 under launchd, launchd log cap (2026-10-21)

Host: macOS (darwin-arm64), Bun 1.3.13. Branch `fix/service-resilience`.

## The failure

The live LaunchAgent `dev.agent-tag.service` was crash-looping: its external T3 on `127.0.0.1:37841` was gone, `createAgentTagService` threw `T3EnvironmentRequestError` (ConnectionRefused) from `inspectT3`, and `KeepAlive` + `ThrottleInterval 10` respawned it every ~10 s.

```
launchctl print gui/501/dev.agent-tag.service
	state = spawn scheduled
	runs = 37436
	last exit code = 1
~/Library/Logs/AgentTag/service.stderr.log  59711555 bytes
```

## The fix, run for real against a dead port

A temporary LaunchAgent (`dev.agent-tag.lh-proof`, same plist shape as the generated one: `KeepAlive`, `ThrottleInterval 10`) ran this branch's `src/cli.ts run` with a scratch config whose `t3.baseUrl` pointed at a closed loopback port (65355). After ~60 s:

```
state = running
runs = 1
last exit code = (never exited)
```

stderr (one line per attempt, backoff 1 → 2 → 4 → 8 → 16 → 32 → 60 s):

```
{"level":"warn","event":"t3.startup.waiting","at":"2026-10-21T04:46:31.528Z","count":1,"errorCode":"T3EnvironmentRequestError","detail":"T3 is not reachable at http://127.0.0.1:65355 (Unable to connect. Is the computer able to access the url?); retrying in 1 s"}
...
{"level":"warn","event":"t3.startup.waiting","at":"2026-10-21T04:47:35.187Z","count":7,"errorCode":"T3EnvironmentRequestError","detail":"T3 is not reachable at http://127.0.0.1:65355 (Unable to connect. Is the computer able to access the url?); retrying in 60 s"}
```

`agent-tag status CONFIG`:

```json
"service": {
  "state": "waiting-for-t3",
  "pid": 70578,
  "since": "2026-10-21T04:46:31.529Z",
  "updatedAt": "2026-10-21T04:47:35.219Z",
  "t3": {
    "baseUrl": "http://127.0.0.1:65355",
    "attempts": 7,
    "lastError": "Unable to connect. Is the computer able to access the url?",
    "nextAttemptAt": "2026-10-21T04:48:35.186Z"
  },
  "alive": true
}
```

`agent-tag doctor CONFIG`:

```
FAIL  t3-environment  T3 is not reachable at http://127.0.0.1:65355: Unable to connect. Is the computer able to access the url?
                      hint: start the external T3 server on http://127.0.0.1:65355 (or switch to t3.mode "managed"); the service waits and resumes on its own
FAIL  service-state   service pid 70578 has been waiting for T3 at http://127.0.0.1:65355 since 2026-10-21T04:46:31.529Z (7 attempt(s); last error: Unable to connect. Is the computer able to access the url?; next attempt 2026-10-21T04:48:35.186Z)
```

`launchctl bootout` (SIGTERM) during the wait: the process exited cleanly and recorded `{"state":"stopped","pid":70578,...}`.

## launchd log descriptor is O_APPEND

The log cap truncates in place, which is only safe if launchd's `StandardErrorPath` descriptor is `O_APPEND`. A throwaway LaunchAgent (`/bin/sh` script) wrote 2,000 lines to stderr, ran `truncate -s 0` on its own log, then wrote one more line. The file was 15 bytes, `after truncate\n`, with no leading NUL hole, so the next write after a truncate lands at offset 0.

## Tests

- `test/service-resilience.test.ts`: backoff and cap, 5xx retry, no wait on a 404, real refused port + abort, state file lifecycle and stale pid, log cap with an `O_APPEND` writer, LaunchAgent-only log paths, and `createAgentTagService` waiting on a real dead port (fails on `main`: it throws `T3EnvironmentRequestError` instead).
- `test/doctor.test.ts`: `service-state` fail/skip/pass, mode-aware hint, managed T3 down without a service is a warning.
- `bun run check`: 1531 pass, 2 skip, 0 fail.

## Managed T3 under launchd: two more exit loops

After the cutover to `t3.mode: "managed"`, the LaunchAgent still exited and respawned (`runs = 3`, `last exit code = 1`) while other work kept the Mac at load average 30–76:

```
T3StartupError: managed T3 did not become ready on http://127.0.0.1:37841 within 60s
ProviderSelectionError: profile engineering: provider codex is not enabled and installed
ProviderSelectionError: profile engineering: provider codex reports error
```

**`ProcessType Background`.** The first run spent about 7 minutes before it even spawned T3, holding the install lock with almost no CPU. A/B on the same host, same config, `env -i` with launchd's PATH:

| run | policy | time to `service.started` | outcome |
| --- | --- | --- | --- |
| `t3 --version` | default | 0.63 s | ok |
| `t3 --version` | `taskpolicy -b` | 2.57 s | ok |
| full startup | default | 41 s at load 51 | started |
| full startup | `taskpolicy -b` | 112 s | exited: `provider codex reports error` |

The generated plist now says `ProcessType` `Standard`. The fix is in `src/launchd.ts`, and `test/launchd.test.ts` asserts it.

**Stale provider catalog.** A just-started managed T3 serves its providers from a cache and re-syncs them over the next seconds (T3 trace: several `syncProvider`/`upsertProviders` spans in the first ~15 s). `validateConfiguredProviders` ran against the first snapshot and exited. Startup now waits for a runnable catalog with the same backoff and state reporting (`waitForRunnableProviders` in `src/t3/startup.ts`). Three tests in `test/service-resilience.test.ts` cover it.

## Live run of this branch

`agent-tag service upgrade` from this branch, against the live host config (managed T3 0.0.45, Slack workspace T0BS9MA4BUP):

```
{"event":"t3.runtime.started","at":"2026-10-21T05:28:25.637Z","detail":"T3 0.0.45 pid 47162 on http://127.0.0.1:37841"}
{"level":"warn","event":"t3.startup.waiting","at":"2026-10-21T05:28:25.960Z","count":1,"errorCode":"ProviderSelectionError","detail":"T3 at http://127.0.0.1:37841 cannot run the configured models yet (profile engineering: provider codex is not enabled and installed); retrying in 1 s"}
{"level":"warn","event":"t3.startup.waiting","at":"2026-10-21T05:28:27.265Z","count":2,...}
{"event":"t3.startup.providers-ready","at":"2026-10-21T05:28:29.415Z","count":3}
{"event":"t3.gate.opened","at":"2026-10-21T05:28:29.424Z"}
{"event":"service.started","count":13,"at":"2026-10-21T05:28:33.231Z"}
```

The service hit the exact race that used to kill it, waited 4 s, and started: `runs = 1`, `last exit code = (never exited)`.

**Log cap on the live log.** 11,840,572 bytes of marked filler were appended to the live `service.stderr.log`. At the next 5-minute check:

```
{"event":"service.log.rotated","at":"2026-10-21T05:31:02.119Z","count":11840572,"detail":".../service.stderr.log was 11840572 bytes; kept the last 1048576 in .../service.stderr.log.1"}
-rw-------  service.stderr.log      0
-rw-------  service.stderr.log.1    1048506   (starts at a whole line: "lh-cap-proof filler line 0145832 ...")
```

The service kept running through the rotation (same pid, `runs = 1`).

**Slack, dhruv2mars.** `auth.test` with the live bot token returned team `dhruv2mars` / `T0BS9MA4BUP`, bot user `U0C4GL9D3HT`. After app A0C46BXNUMD was given `reactions:write` and `users:read` and reinstalled, `x-oauth-scopes` read `app_mentions:read,chat:write,channels:history,groups:history,im:history,reactions:write,users:read`. Dhruv's account then posted a real mention in the routed channel `C0C2RHJ1BUP` (read back with `conversations.history` / `conversations.replies`):

```
05:30:42Z  U0BSJQXNZDH  "<@U0C4GL9D3HT> live check: reply with the exact result of 17 × 23 and nothing else. Do not change any files."
           reactions: eyes by U0C4GL9D3HT   (service log: slack.reaction.added 05:30:43.669Z)
05:31:00Z  U0C4GL9D3HT  "Agent Tag is working on this request."   (thread reply)
05:31:09Z  U0C4GL9D3HT  "391"                                    (thread reply)
```
