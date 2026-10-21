# Project status

Agent Tag is an open-source, local-first Slack coworker built on T3 Code. It is intended to provide the team experience of Claude Tag while letting the operator choose the T3-supported agent, provider, and model. The current deployment target is one dedicated local machine.

Agent Tag is not generally available yet, and no release has been tagged. The source of truth is the [GA acceptance matrix](ga-acceptance.md); evidence must remain live, exact, and honest.

## Read first

1. [GA acceptance matrix](ga-acceptance.md)
2. [Architecture](architecture/initial-design.md)
3. [Operations](operations.md)
4. [Slack setup](slack-setup.md)
5. [Provider access and licensing](provider-licensing.md)

Work lands on `main` through one squash-merged pull request per change. Use Bun `1.3.13` and pinned T3 Code `0.0.45` (orchestration protocol 1; `0.0.42`–`0.0.45` are accepted).

## On `main`

- Slack Socket Mode ingestion, authorization, durable deduplication, T3 dispatch, and Slack replies. Replies are rendered as safe, chunked mrkdwn, and the outbox classifies delivery errors and retries with backoff.
- An instant :eyes: reaction on accepted mentions (`reactions:write`), and durable `chat.update` edits for messages Agent Tag already posted.
- Speaker identity in every turn (`users:read`), a window of earlier thread messages on the first mention, and thread updates (other bots, non-allowed people, edits) carried into the next turn.
- `!help`, `!status`, `!mute`, `!unmute`, `!stop`, and `!restart` commands. Approval and question cards reflect clicks, outcomes, and expiry.
- One shared T3 connection with a thread watcher, a progress-based stall policy, approval expiry, and interaction retries with backoff.
- Per-profile `allowedModels` and a per-task model that stays sticky across turns.
- A draft pull request worker (`pullRequests.mode: "auto"`) with a Slack PR card. The live GitHub run is still owner-blocked (PR-01).
- Routines from Slack: create, list, and cancel in plain language (by text or button) in the requester's Slack time zone, with run outcomes and auto-disable after repeated failures. The live Slack run is owner-blocked (JOB-01).
- A pinned T3 runtime installer, a supervised managed `t3 serve` with a runtime protocol gate, and restricted-token rotation (`agent-tag t3 install|status|serve|pair|rotate`).
- `agent-tag onboard`, `agent-tag doctor [--fix]`, and a platform-neutral `agent-tag service` (launchd on macOS, `systemd --user` on Linux). The Linux unit is fixture-tested only and has not run on a live host.
- Credential redaction, retention pruning, `security audit`, and secret scanning.
- `install.sh`, a tag-triggered release workflow, self-updating binaries, and a Docker image.
- Queued turns, interaction responses, schedules, and Slack replies recheck current task authority before dispatch ([revocation evidence](evidence/2026-09-30-authority-revocation.md)). OS isolation and tool-write enforcement remain unimplemented.
- The pinned T3 adapter can transfer image and file attachments ([transport evidence](evidence/2026-09-30-t3-attachments.md)). Files shared in Slack are attached to the turn (`files:read`; fixture tests only, live evidence pending). Files the agent writes can be shared back to the thread (`files:write`; a reply line names the file, the worktree copy is scanned for credentials, then uploaded; fixture and live T3 worktree tests, Slack live evidence pending).
- Codex `gpt-5.6-sol` and Claude `claude-sonnet-4-6`/`claude-haiku-4-5` complete live through the adapter on T3 `0.0.45` ([evidence](evidence/2026-10-06-t3-0.0.45.md)).

## Required work

Work down the acceptance matrix without weakening it.

1. Finish the Slack experience teams expect from Claude Tag: a live status message with Stop, `!stop`/`!restart`, routines from Slack, channel memory, task close/reopen, Slack files in and out, and plain-language model switching.
2. Enforce isolation and external-write authority where tools execute. Separate worktrees alone do not isolate paths or credentials, and configuration fields are not proof of enforcement.
3. Run independent human acceptance for thread context, two-person steering, approvals, questions, cancellation, DMs, memory, schedules, ambient behavior, and draft PRs.
4. Close outage recovery, asset-path privacy, tool credential scoping, and full audit-transition coverage.
5. Resolve or explicitly bound provider parity and deployment licensing.
6. Publish a runnable release only after every required GA row passes.

Keep the architecture small: T3 is the execution backend, Slack is the team interface, and Agent Tag owns identity, policy, durable coordination, and operations. Do not add a second agent loop or claim GA from mocks, documentation, or a green unit suite.
