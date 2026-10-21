# GA acceptance matrix

Agent Tag v0.1.0 is generally available when every row below is `PASS`, or is `UNCONFIRMED` / `OUT-OF-SCOPE` with an owner-approved decision. `test/ga-matrix.test.ts` checks this table on every `bun run check`. `AGENT_TAG_GA_GATE=1 bun run scripts/ga-matrix.ts` is the release gate: it also fails on any `PENDING-*` or `FAIL` row. The release workflow does not run the gate yet, so run it by hand before a stable tag ([Releasing](releasing.md)).

Slack evidence counts only from an install whose profiles answered on `codex`/`gpt-6-luna` or `claudeAgent`/`claude-haiku-5-5` (Dhruv's Slack model rule, 2026-10-21; see [owner session](owner-session.md#models-slack-model-rule)).

How each column works:

- **Claude Tag ref**: the page under `https://claude.com/docs/claude-tag/` that describes the matching Claude Tag behaviour (fetched 2026-10-21), or `—` for a row with no Claude Tag counterpart.
- **Spec Done**: `PR-<X> D<n>` plus the WAVES PR IDs in brackets. `legacy` means the row predates the PR specs.
- **Evidence**: `;`-separated files under `docs/evidence/`, each listed in [`docs/evidence/index.tsv`](evidence/index.tsv). `—` means no evidence file exists yet. Notes go in the evidence file, not here.
- **Kind**: how the row must be proven. `automated-real` is real Slack, T3 or a real provider, run by an agent or CI. `owner-session` is a person in Slack, run from [`docs/owner-session.md`](owner-session.md). `automated-fixture` is allowed only for DOC-01 and the fault-injection half of REL-01.
- **Status**: one of
  - `PASS`: the evidence proves the whole capability.
  - `FAIL`: the evidence shows a defect.
  - `UNCONFIRMED`: could not be run (for example, no Linux host). The row must cite a [decisions log](audit/decisions.tsv) row.
  - `OUT-OF-SCOPE`: the owner excluded it from v0.1.0.
  - `PENDING-OWNER-SESSION`: waits for the owner session or an owner decision.

  Every non-`PASS` row ID appears in a `ga` row of `docs/audit/decisions.tsv` that says why.
- **Build**: the Agent Tag commit the cited evidence ran on, plus the T3 version.

| ID | Capability | Claude Tag ref | Spec Done | Evidence | Kind | Status | Build |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SLK-01 | A first mention sees the thread's prior context and each speaker's identity, and completes through T3 | `concepts/how-it-works` | legacy; PR-G D1,D3,D11 (G1,G2,G3) | docs/evidence/2026-09-28-slack-live.md | owner-session | PENDING-OWNER-SESSION | 07fc472 · T3 0.0.42 |
| SLK-02 | Repeated and overlapping Slack deliveries create one task and one user turn | — | legacy; PR-G D2 (G1) | docs/evidence/2026-09-21-slack-ingress.md; docs/evidence/2026-09-28-slack-live.md | automated-real | UNCONFIRMED | acf071c · T3 0.0.42 |
| SLK-03 | A second authorized human steers the same task, in order | `concepts/how-it-works` | legacy; PR-G D3,L1,L2 (G2,G3) | docs/evidence/2026-09-21-slack-ingress.md | owner-session | PENDING-OWNER-SESSION | — |
| SLK-04 | Approve, decline, question, answer and cancel work in Slack, cards update, and all of it recovers after a restart | `concepts/how-it-works` | legacy; PR-I D2,D3 (I1,I2) | docs/evidence/2026-09-21-interactions.md; docs/evidence/2026-09-21-durability.md; docs/evidence/2026-10-21-t3-live-main.md | owner-session; automated-real | FAIL | ee1eaf8 · T3 0.0.45 |
| SLK-05 | Slack files reach the task; files the agent writes come back to the thread past the secret gate | `users/use-cases/create-artifacts` | PR-L D3-D8 (L1,L2,L3) | docs/evidence/2026-10-21-slack-files.md; docs/evidence/2026-10-21-t3-live-main.md | owner-session; automated-real | PENDING-OWNER-SESSION | ee1eaf8 · T3 0.0.45 |
| SLK-06 | 👀 acknowledgement, live status, Stop, and the model and time footer | `concepts/how-it-works` | PR-F D3-D7,D9,D10 (F2,F3,F4) | docs/evidence/2026-10-21-pr-f-live.md | owner-session | PENDING-OWNER-SESSION | f4-footer + efff6c1 · T3 0.0.45 |
| SLK-07 | `!help`, `!status`, `!mute`, `!unmute`, `!stop` and `!restart` | `users/commands` | PR-H D2-D4,D7 (H1,H2) | docs/evidence/2026-10-21-t3-live-main.md | owner-session | PENDING-OWNER-SESSION | ee1eaf8 · T3 0.0.45 |
| SLK-08 | A coding request posts a draft PR card; a follow-up pushes to the same PR; a question opens no PR | `users/use-cases/work-with-github` | PR-M D2,D5,D6,D8 (M1,M2) | — | owner-session | PENDING-OWNER-SESSION | — |
| PR-01 | Opt-in live GitHub run: one draft PR, the follow-up on the same PR, no GitHub token reaches the agent | `admins/configure-github` | PR-M D2,D5 (M1,M2) | — | automated-real; owner-session | PENDING-OWNER-SESSION | — |
| T3-01 | The adapter authenticates to pinned T3 `0.0.45` with only the required scopes | — | legacy (O1) | docs/evidence/2026-10-06-t3-0.0.45.md; docs/evidence/2026-10-21-t3-live-main.md | automated-real | PASS | ee1eaf8 · T3 0.0.45 |
| T3-02 | Stable command IDs make dispatch replay safe, and receipts reconcile after a bridge restart | — | legacy | docs/evidence/2026-09-21-service-runtime.md; docs/evidence/2026-10-21-t3-live-main.md | automated-real | FAIL | ee1eaf8 · T3 0.0.45 |
| T3-03 | A T3 interruption is told apart from a bridge restart, and supported continuation succeeds | — | legacy | docs/evidence/2026-09-21-t3-adapter.md; docs/evidence/2026-09-28-slack-live.md | automated-real | PASS | 719a76c / acf071c · T3 0.0.42 |
| T3-04 | Provider and model selection is explicit and sticky; unsupported capabilities fail clearly | `users/models` | legacy; PR-P2 D2-D4 (P2a,P2b) | docs/evidence/2026-10-06-t3-0.0.45.md; docs/evidence/2026-10-21-t3-live-main.md | automated-real | PASS | ee1eaf8 · T3 0.0.45 |
| T3-05 | Pinned T3 install, supervised `t3 serve`, token rotation and the protocol gate, on darwin-arm64 | — | PR-O D3-D9 (O1,O2,O3,O4) | docs/evidence/2026-10-21-service-resilience.md; docs/evidence/2026-10-21-t3-managed.md | automated-real | PENDING-OWNER-SESSION | feat/o4-t3-managed-docs · T3 0.0.45 |
| T3-05L | The same managed-T3 lifecycle on linux-x64 | — | PR-O D3-D9 (O1,O2,O3,O4) | — | automated-real | UNCONFIRMED | — |
| T3-06 | One reused T3 connection and a thread watcher keep T3 requests per turn bounded | — | PR-F D8,D11 (F1) | — | automated-real | UNCONFIRMED | — |
| MOD-01 | Sticky per-thread model, plain-language switch from Slack, refusal to cross drivers | `users/models` | PR-P2 D4a-e,D5-D7 (P2a,P2b,P2c) | docs/evidence/2026-10-21-model-switch.md; docs/evidence/2026-10-21-t3-live-main.md | automated-real; owner-session | PENDING-OWNER-SESSION | ee1eaf8 · T3 0.0.45 |
| MEM-01 | Memory scopes and injection; remember, list and forget from Slack; the operator CLI | `users/memory` | PR-K D-A,B1-B8 (K1,K2,K3) | docs/evidence/2026-09-21-memory.md; docs/evidence/2026-10-21-memory-slack.md | owner-session | PENDING-OWNER-SESSION | — |
| JOB-01 | Routines survive restarts, obey cancellation and missed-run policy, and auto-disable after repeated failures | `users/proactivity` | legacy; PR-J D2,D5,D6 (J1,J2) | docs/evidence/2026-09-21-scheduler.md; docs/evidence/2026-09-21-process-kill.md | automated-real; owner-session | PENDING-OWNER-SESSION | — |
| JOB-02 | Create, list and cancel routines from Slack, in the requester's time zone | `users/proactivity` | PR-J D3,D4,D7 (J3) | docs/evidence/2026-10-21-routines-slack.md | owner-session | PENDING-OWNER-SESSION | — |
| LIFE-01 | Tasks close and reopen; cleanup retires the T3 thread, worktree and branch, and keeps a dirty worktree | — | PR-N D2,D3,D5,D6 (N1,N2) | docs/evidence/2026-10-21-t3-live-main.md | automated-real | PASS | ee1eaf8 · T3 0.0.45 |
| ACL-01 | Workspace, channel, user, profile, repository, memory and task authority hold at every transition | `admins/restrict-access` | legacy; every spec's denial tests | docs/evidence/2026-09-30-authority-revocation.md; docs/evidence/2026-10-21-q1-access.md | automated-real | PENDING-OWNER-SESSION | 9b23de7 · T3 0.0.42 |
| ACL-02 | `channel-members` access lets any channel member use the bot without an allow-list entry | `admins/restrict-access` | PR-Q (Q1) | docs/evidence/2026-10-21-q1-access.md | owner-session | PENDING-OWNER-SESSION | — |
| DM-01 | A DM is bound to its owner; another person is refused; shared-channel context does not leak in | `users/getting-started` | legacy | docs/evidence/2026-09-21-dm-isolation.md; docs/evidence/2026-09-29-dm-live.md | owner-session | PENDING-OWNER-SESSION | c06e763 · T3 0.0.42 |
| REL-01 | Serialization per task, global concurrency bounds, the durable outbox and recovery prevent loss or blind replay | — | legacy; PR-I D3 (I1) | docs/evidence/2026-09-21-durability.md; docs/evidence/2026-09-21-process-kill.md | automated-fixture; owner-session | PENDING-OWNER-SESSION | — |
| REL-02 | Machine outage and Socket Mode delivery limits are reported accurately; stalled tasks follow the configured policy | — | legacy | docs/evidence/2026-09-29-stalled-turn-policy.md; docs/evidence/2026-10-21-service-resilience.md | automated-real | UNCONFIRMED | f55b122 · T3 0.0.42 |
| OPS-01 | Fresh install, onboarding, diagnostics, background service, upgrade and migration, backup and restore, log redaction, uninstall | `admins/setup-overview` | legacy (O4) | docs/evidence/2026-09-29-clean-host-ci.md; docs/evidence/2026-09-29-macos-launchagent.md; docs/evidence/2026-09-29-store-upgrades.md | automated-real | PASS | 6980c25 / 4cb6343 · T3 0.0.42 |
| OPS-02 | macOS claims require a logged-in, awake machine; Linux service claims match tested behaviour | — | legacy | docs/evidence/2026-09-29-macos-launchagent.md | automated-real | UNCONFIRMED | 4cb6343 · T3 0.0.42 |
| SEC-01 | Secrets never reach prompts, logs, fixtures, artifacts or public files; asset paths are scoped | `concepts/security-and-data` | legacy; PR-L D7 (L2) | docs/evidence/2026-09-29-secret-scan.md; docs/evidence/2026-10-21-slack-files.md | automated-real | PENDING-OWNER-SESSION | 5b3b6ba · T3 0.0.42 |
| AUD-01 | Every state-changing action records actor, authority, source, target, result and correlation IDs | `admins/audit` | legacy | docs/evidence/2026-09-29-live-audit.md | automated-real | PENDING-OWNER-SESSION | 07fc472 · T3 0.0.42 |
| LIC-01 | Provider terms are documented without claiming one person's CLI subscription permits shared commercial use | — | legacy | — | owner-session | PENDING-OWNER-SESSION | — |
| ISO-01 | Two concurrent coding tasks cannot reach each other's paths or credentials | `concepts/security-and-data` | legacy | — | owner-session | PENDING-OWNER-SESSION | — |
| ISO-02 | External writes need an approval enforced where the tool runs | `concepts/security-and-data` | legacy | — | owner-session | PENDING-OWNER-SESSION | — |
| TOOL-01 | Scoped MCP and tool credentials work for the documented examples | `admins/add-connections` | legacy | — | owner-session | PENDING-OWNER-SESSION | — |
| AMB-01 | Ambient participation is opt-in, bounded, quiet when nothing changed, and audited | `users/when-claude-responds` | legacy; PR-V (post-GA) | docs/evidence/2026-09-21-ambient.md | owner-session | PENDING-OWNER-SESSION | — |
| DOC-01 | The docs match the code: config keys, CLI commands, the Slack manifest and links | — | PR-U D2-D5 (U1) | docs/evidence/2026-10-21-docs-drift.md | automated-fixture | PASS | feat/u1-docs-ga-matrix |
| GA-01 | A release is published with its version, platforms, providers and limits, and every row above is resolved | — | PR-U D9-D11 (U1) | — | automated-real; owner-session | PENDING-OWNER-SESSION | — |

## Evidence rules

- Mocks may test local logic. They cannot satisfy a live Slack, provider, T3, filesystem-isolation or installation claim.
- "Automated-real with injected events" (for example `scripts/live/pr-f.ts`) proves Agent Tag's own loops against real Slack and T3. It is not a person in Slack, so it does not close an `owner-session` row on its own.
- Secrets and full private message content never belong in evidence. Store redacted IDs, timestamps, hashes, actor labels and links.
- Each evidence file states its actor: `human`, `automated-real` or `automated-fixture`. `docs/evidence/index.tsv` records it, with the build, platform, T3 version, providers and the rows it supports.
- A missing credential, host or tester leaves the row open. It does not shrink the GA definition.
