# Local work status during a T3 outage, 2026-09-29

Actor type: `automated-real`. Build: Agent Tag commit `0ef298a`, macOS arm64, Bun `1.3.13`, pinned T3 `0.0.42`, and the private Slack test workspace. This is an operator exercise, not a machine-outage or Socket Mode delivery test.

The new `bun run status -- CONFIG` command reads only the local SQLite store. A fake-clock test checked ready work, deferred retries, active leases, and expired leases. The full `bun run check` gate passed 54 tests; one opt-in live T3 test remained skipped.

On the live store, `status` reported one deferred operation and one unanswered human approval. It reported no ready operation, active or expired lease, pending Slack send, or unknown Slack delivery outcome. The output contained counts and an observation time, with no task ID, message text, provider error, or credential.

The dedicated T3 test server then stopped. With T3 unavailable, the same `status` command exited successfully and reported the same backlog. T3 was restarted on the same private base directory, and `doctor` passed its T3 and Slack checks. The Agent Tag service remained running throughout this short T3 outage.

The configured secret scan covered 75 repository and live Agent Tag data files. It found no credentials and skipped no symlinks.

This proves that an operator can inspect stored work when T3 is unavailable. It does not prove that a sleeping host receives missed Slack events, that Socket Mode replays every gap, or that a stalled task follows a configured timeout policy. REL-02 stays pending.
