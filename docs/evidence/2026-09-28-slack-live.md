# Live Slack ingress, provider failure, and project reuse, 2026-09-26 to 2026-09-29

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

At that point, the evidence supported live Slack ingress, an acknowledgement, durable overlap collapse, a visible terminal-provider failure, and one delivered scheduled reminder. It did not yet satisfy a completed Slack provider turn, human steering, two-person ordering, or GA.

## Project reuse and completed turn, 2026-09-28 to 2026-09-29

Build: macOS arm64, Bun `1.3.13`, pinned T3 `0.0.42`, Codex `gpt-5.6-sol`, and Agent Tag code commit `f26bd12`. Actor type: `automated-real`, using the authorized account in the private Slack test channel. This is not an independent human acceptance run.

A fresh mention on September 28 reached Agent Tag but failed before T3 thread creation: T3 rejected a second active project for the same repository root. Agent Tag had assigned a new project ID per Slack task. Commit `f26bd12` reuses the first durable project's ID and original create-command ID for that root while retaining a separate T3 thread and worktree per task. Local tests cover same-root reuse, different-root separation, and distinct-thread dispatch.

After restarting the service with that fix, a second mention at Slack timestamp `1790569788.745569` created a new T3 thread under the existing project. It posted the start acknowledgement and an approval card for a read-only command. The operation remained pending across the overnight service stop. The approval was not answered on the user's behalf; this is not completion evidence for SLK-04.

After restarting T3 and Agent Tag on September 29, a separate no-tool mention at `1790675538.384539` completed in one attempt. The durable operation was `succeeded`; its T3 snapshot was `completed` and `ready`, with a separate worktree, the reused project, and explicit Codex `gpt-5.6-sol` selection. Agent Tag's start and final outbox rows each delivered once. Slack `conversations.replies` independently showed both in the original thread; the final reply exactly matched the requested `AGENT_TAG_LIVE_OK` marker at `1790675547.331829`.

The September 29 `bun run check` gate passed 53 tests, with one opt-in live T3 test skipped. The configured secret scan covered 74 files in the authorized repository and live Agent Tag data directory, with no findings or skipped symlinks. This run proves one end-to-end Slack-to-T3-to-Slack Codex turn and project reuse. It does not prove prior-thread context, a human acceptance transcript, approval recovery, Claude parity, or GA.
