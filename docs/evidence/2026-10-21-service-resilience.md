# Service resilience: T3 down at startup, launchd log cap (2026-10-21)

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
