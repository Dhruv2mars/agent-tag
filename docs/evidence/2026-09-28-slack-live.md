# Live Slack ingress and provider failure, 2026-09-26 to 2026-09-28

Actor type: `automated-real` (Agent Tag operator using the authorized Slack account). This is not an independent human acceptance run.

## System under test

- Agent Tag branch: `feat/t3-slack-spike`; the tested Socket Mode and failure-settlement changes were committed as `acf071c` after the run.
- macOS arm64, Bun `1.3.13`, Slack Bolt `5.1.0`, Socket Mode `3.0.1`, undici `7.29.1`.
- Pinned T3 Code `0.0.42` on loopback. One private Slack channel and one authorized account; identifiers are redacted.
- Runtime config and Slack/T3 tokens were outside Git in owner-only files. No token value was printed or saved in evidence.

## Observations

`doctor` authenticated the Slack bot in the configured workspace and the restricted T3 token, opened the private SQLite store, and validated the selected provider/model.

The first live service start exposed a Bun/undici compatibility failure in Socket Mode heartbeat (`undici.ping` was unavailable). The package WebSocket transport adapter then kept Socket Mode connected, received a real mention from the authorized account in the private channel, and posted an acknowledgement in the same thread. Slack's overlapping mention and message deliveries produced one durable event, task, and operation.

That turn used Codex `gpt-5.6-sol`. T3 entered an error state after the Codex account reported a usage limit. The earlier coordinator retried the terminal turn thousands of times; this was a defect. After the bounded failure fix and service restart, the operation settled `failed` with `T3ProviderLimit`, and one sanitized failure reply was delivered in Slack. Its attempt count stayed fixed after settlement. The failure path exposed no provider diagnostic text or credential in the Slack message.

On 2026-09-28, `doctor` passed again with the runtime profile selecting `claudeAgent` and `claude-sonnet-4-6`; the service started with six workers. A fresh Claude-backed Slack turn and final reply have not yet been observed. Earlier real T3 Claude turns ended in `provider-api-errors`, so a ready catalog is not completion evidence.

The isolated real T3 provider tests were rerun on 2026-09-28: Claude Sonnet entered `provider-api-errors` in 1.95 seconds; Codex `gpt-5.6-sol` completed a supervised turn and reconciled its snapshot in 7.16 seconds. These results establish current provider behavior at the T3 boundary, not a completed Slack turn.

A one-shot reminder was created on the existing authorized private-channel task through the schedule CLI. The live service settled one `dispatched` schedule run, marked its Slack outbox row `delivered`, and Slack `conversations.replies` confirmed the exact reminder in the original thread. This proves one live reminder dispatch and same-thread delivery; it does not prove a recurring job or a provider-generated response.

The local `bun run check` gate passed 52 tests, with the separately invoked live T3 integration file skipped. The configured secret scan covered the live Agent Tag data directory and authorized repository: 74 files, no findings, no skipped symlinks. T3's separate userdata/artifacts were not part of that scan.

This evidence supports live Slack ingress, an acknowledgement, durable overlap collapse, a visible terminal-provider failure, and one delivered scheduled reminder. It does not satisfy a completed Slack provider turn, human steering, two-person ordering, or GA.
