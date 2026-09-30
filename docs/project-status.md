# Project status

Agent Tag is an open-source, local-first Slack coworker built on T3 Code. It is intended to provide the team experience of Claude Tag while letting the operator choose the T3-supported agent, provider, and model. The current deployment target is one dedicated local machine.

Agent Tag is not generally available yet. The source of truth is the [GA acceptance matrix](ga-acceptance.md); evidence must remain live, exact, and honest.

## Read first

1. [GA acceptance matrix](ga-acceptance.md)
2. [Architecture](architecture/initial-design.md)
3. [Operations](operations.md)
4. [Slack setup](slack-setup.md)
5. [Provider access and licensing](provider-licensing.md)

The active continuation branch is `feat/t3-slack-spike`, with [draft PR #1](https://github.com/Dhruv2mars/agent-tag/pull/1). Use Bun and pinned T3 Code `0.0.42`.

## Working baseline

- Slack Socket Mode ingestion, authorization, durable deduplication, T3 dispatch, and Slack replies are implemented.
- Queued turns, interaction responses, schedules, and Slack replies recheck current loaded task authority before dispatch. [Revocation evidence](evidence/2026-09-30-authority-revocation.md) covers restart fixtures, real Codex continuation, and real Slack delivery. OS isolation and tool-write enforcement remain unimplemented.
- SQLite owns tasks, operations, leases, interactions, memory, schedules, ambient decisions, audit records, and the Slack outbox.
- Live Codex runs have completed from Slack, preserved same-thread context, survived a controlled T3 restart, and completed in an owner-bound DM.
- Approval, question, cancellation, memory, scheduling, ambient participation, backup/restore, status, audit verification, and secret scanning have executable coverage. One live approval remains intentionally unanswered and must remain a human decision.
- A macOS per-user LaunchAgent completed install, upgrade, uninstall, and reinstall exercises. Clean GitHub-hosted macOS 15 and Ubuntu 24.04 gates pass.
- The pinned T3 adapter can upload, download, and delete pending image/file attachments with the existing restricted token. [Transport evidence](evidence/2026-09-30-t3-attachments.md) covers real byte round trips; Slack file ingestion and artifact return remain unimplemented.
- Provider/model selection is explicit. Real Claude catalog selections currently fail inside pinned T3 with `provider-api-errors`; Codex is the verified live provider.

## Required work

Start by reviewing the repository and validating the current branch and CI. Then work down the acceptance matrix without weakening it.

1. Enforce isolation and external-write authority where tools execute. Separate worktrees alone do not isolate paths or credentials, and the current configuration fields are not proof of enforcement.
2. Complete Slack files, images, returned artifacts, and usable PR-link workflows with least-privilege scopes.
3. Run independent human acceptance for thread context, two-person steering, approvals, questions, cancellation, DMs, memory, schedules, and ambient behavior.
4. Close outage recovery, asset-path privacy, tool credential scoping, and full audit-transition coverage.
5. Resolve or explicitly bound provider parity and deployment licensing.
6. Publish a runnable release only after every required GA row passes.

Keep the architecture small: T3 is the execution backend, Slack is the team interface, and Agent Tag owns identity, policy, durable coordination, and operations. Do not add a second agent loop or claim GA from mocks, documentation, or a green unit suite.
