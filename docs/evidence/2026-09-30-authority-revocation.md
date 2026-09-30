# Authority revocation, 2026-09-30

Actor types: `automated-fixture` and `automated-real`. Implementation commits: `878cc88` and `9b23de7`, branch `feat/t3-slack-spike`. Platform: macOS arm64, Bun `1.3.13`, pinned T3 Code `0.0.42`, Codex `gpt-5.6-sol`, and the authorized private Slack test channel. This is not independent human acceptance.

## Baseline reconciliation

The checkout started clean at `d1b3739`. Draft PR #1 pointed at that commit; its macOS 15 and Ubuntu 24.04 push checks passed. The local gate reproduced 59 passing tests, one opt-in live test skipped, and zero failures. The LaunchAgent was installed, loaded, and running, but `doctor` failed because T3 port 37841 refused connections. Restarting the existing pinned release with the same private base directory restored authenticated T3 and Slack diagnostics. A running LaunchAgent alone did not establish backend health.

## Changed behavior

Previously, ingestion authorized work, but a replacement worker could send a queued turn or accepted approval after configuration revoked its actor, route, or repository. Scheduled reminders and queued Slack replies had the same route-revocation gap.

Eight SQLite close/reopen fixtures now revoke workspace, user, channel, route, profile, repository allowlist, selected repository, or DM owner. Each fixture requires zero T3 dispatches, permanent failure for the queued turn and approval response, cancellation of both reminder and agent schedules, no new operation or schedule run, and audit records without request or schedule canaries. Slack delivery rejects removed task routes and DM owners. Removing a requester alone still permits sanitized notices in an authorized shared channel.

The full gate passed 67 tests, one opt-in live test skipped, and zero failures. All historical schema upgrades still pass; no database migration was needed.

## Real T3 and Slack checks

The selected live T3 coordinator test completed in 6.87 seconds. It dispatched a no-tool Codex turn, simulated a bridge fetch failure, reopened SQLite, and reconciled the same stable operation through a new worker. Its real completed reply was `durable-fixture-ok`. A subsequent queued follow-up was revoked before dispatch; real before/after snapshots retained identical messages and latest-turn state. Six unrelated live tests were filtered out, including the known failing Claude case.

The first attempt exposed a timing defect in the older live test: its replacement worker reclaimed before the durable retry delay expired and correctly returned `idle`. The fixture now advances the replacement worker's clock past the retry delay. This is a controlled worker/store restart, not a SIGKILL or machine-outage claim.

A real Slack run authenticated the production bridge against the configured workspace using an isolated fixture store. With its route removed, the bridge permanently failed the queued send and recorded one `ExecutionAuthorityDenied` audit row. Slack thread replies contained no rejected marker. Restoring the authorized route sent exactly one new marker to the same existing test thread, confirmed through `conversations.replies`. The reusable `verify:slack-authority` script repeated this result. Neither run started Socket Mode, changed live task state, nor answered a human approval.

The LaunchAgent upgrade succeeded with the changed code. Live status retained one awaiting-human interaction and no queued response. The live 4,484-row audit export passed its count, closed-action, and private-content checks. A configured secret scan covering the checkout, live Agent Tag data, T3 userdata and worktrees scanned 474 files with no findings or skipped symlinks before the verification script was added. A subsequent checkout/live-data scan included the script and evidence, scanning 98 files without findings or skipped symlinks.

## CI follow-up

After commit `718603e`, Ubuntu passed, while macOS passed typecheck/tests but failed the remote pin check on GitHub HTTP 403. Commit `0d1a417` supplies the job's GitHub token only to the GitHub API request and refuses redirects. The local gate passed 68 tests; the remote pin check passed. Both platform checks then passed in [CI run 36734182811](https://github.com/Dhruv2mars/agent-tag/actions/runs/36734182811). No digest comparison or acceptance gate was weakened.

## Limits

Configuration is loaded at process startup; changes require restart or upgrade. These guards stop future bridge dispatch and delivery. They cannot stop a command already running in T3, restrict arbitrary filesystem reads, withhold credentials from provider tools, or establish external-write approval enforcement. ISO-01, ISO-02, ACL-01, and the remaining human, file, provider, outage, licensing, and release gates remain open. The original live approval remains a human decision.
