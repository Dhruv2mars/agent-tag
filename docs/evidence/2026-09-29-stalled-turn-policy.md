# Configured stalled-turn policy, 2026-09-29

Actor types: `automated-fixture`, `automated-real`. System under test: Agent Tag commit `f55b122` on branch `feat/t3-slack-spike`, macOS arm64, Bun `1.3.13`, pinned T3 Code `0.0.42`, Codex `gpt-5.6-sol`.

Agent Tag now parses one bounded `limits.stalledTurn` policy: the settlement timeout for each attempt, the delay before replaying the same stable command, and the maximum attempt count. Invalid zero or excessive values fail at the config boundary.

A fake-clock coordinator test used a two-second timeout, ten-second retry delay, and two-attempt limit against a T3 turn that remained `running`. The first deadline returned the operation to durable `pending` state with `T3TurnStalled`, preserved its stable command, and made `status.operations.stalledRetry` equal one. The second deadline exhausted the configured attempts, atomically marked the operation failed, queued one terminal Slack reply, and made `stalledFailed` equal one. The reply does not claim T3 stopped; it tells the operator to inspect T3 before retrying because the remote outcome may be unknown.

The live local `status` command then read the existing private store with no T3 or Slack call. It included both stall counters, each zero, while continuing to report the untouched deferred operation and unanswered approval. This verifies the operator surface against the real store without altering that pending interaction.

The full local gate passed 56 tests with one opt-in live T3 test skipped. The configured secret scan covered 78 files with no findings or skipped symlinks. The T3 service was restored after an observed connection refusal, `doctor` then passed T3 and Slack authentication, and the Agent Tag service reported `service.started` with the explicit live policy loaded.

This evidence covers deterministic local stall handling and diagnostics. It does not prove behavior across machine sleep, events that never reached the local store, or Socket Mode gap recovery. REL-02 remains pending.
