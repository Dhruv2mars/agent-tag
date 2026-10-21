# Audit actions

An audit row records the actor, authority, source, target, action, result and correlation fields, with bounded metadata; see [Audit and backup](operations.md#audit-and-backup). Export rows with `agent-tag audit CONFIG` and verify the live export with `bun run audit:verify -- CONFIG`. Audit rows never store Slack message text, memory text or schedule prompts.

Metadata keys below may be present only on some paths for an action.

## Access

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `access.denied` | The access policy refuses an explicit request addressed to the bot. | `purpose` |
| `access.membership.degraded` | The membership cache reports a channel falling back to allowlist-only access. | `errorCode` |

## Ambient decisions

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `ambient.decided` | The ambient policy records whether an event triggers a turn or stays quiet. | `reason` |

## Interactions

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `interaction.approval.requested` | A new T3 approval request is stored with its Slack prompt. | — |
| `interaction.cancel.requested` | The turn policy queues an interrupt after an interaction expires or a turn reaches its ceiling. | `reason` |
| `interaction.expired` | An unanswered interaction reaches the configured wait deadline and is marked failed. | `expirySeconds` |
| `interaction.closed` | An open approval or question is marked failed because its operation stopped accepting responses. | `errorCode`, `previousState` |
| `interaction.adopted` | A later operation takes ownership of an earlier operation's still-pending request. | — |
| `interaction.response.claimed` | A worker leases a queued or expired-lease interaction response for delivery to T3. | `attempt` |
| `interaction.response.completed` | A worker marks an interaction response resolved after delivery to T3. | — |
| `interaction.response.failed` | Response delivery fails and the response is queued for retry or marked failed. | `errorCode`, `retryable`, `blockedUntil` |
| `interaction.response.submitted` | An accepted Slack response is queued for delivery after all required answers are available. | `questionCount` |
| `interaction.resolved-elsewhere` | A pending Slack approval or question is resolved because T3 no longer reports it as pending. | `kind` |
| `interaction.user-input.answer-recorded` | An accepted answer is saved while other questions in the same request remain unanswered. | `questionId`, `answered`, `total` |
| `interaction.user-input.requested` | A new T3 user-input request is stored with its Slack prompt. | — |

## Memory

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `memory.created` | A new memory entry is stored. | `scope`, `sourceType`, `expiresAt`, `conversationId` |
| `memory.denied` | A memory request is recorded as denied. | — |
| `memory.expired` | An expired memory entry is marked forgotten. | — |
| `memory.forgotten` | A forget request marks a memory entry forgotten. | `scope` |
| `memory.updated` | An update replaces a memory entry and increments its version. | `scope`, `version` |

## Operations

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `operation.cancelled` | An operation is marked failed because it was cancelled or its queued work was dropped by stop or restart. | `errorCode`, `turnStarted` |
| `operation.claimed` | A worker leases an operation for execution. | `attempt` |
| `operation.completed` | An operation is marked succeeded and its result sequence is recorded. | `resultSequence` |
| `operation.deferred` | An operation returns to pending while it waits for an interaction. | `blockedUntil`, `unanswered` |
| `operation.failed` | An operation fails and is queued for retry or marked failed. | `errorCode`, `retryable`, `blockedUntil` |
| `operation.released` | A worker returns an operation to pending during shutdown. | `reason` |
| `operation.turn-text.resolved` | The operation's turn text is frozen for replay and any selected thread notes are consumed. | `notesConsumed` |

## Pull requests

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `pr.approved` | Reserved; nothing writes it yet. | — |
| `pr.blocked` | A worktree snapshot is recorded as blocked from pushing. | `reason`, `sha`, `outboxId` |
| `pr.closed` | The PR worker finds that the pull request is already closed or merged and skips the job. | `number`, `state`, `resultCode`, `outboxId` |
| `pr.created` | A PR job succeeds after creating a pull request or finding one already created for its branch. | `number`, `created`, `draft`, `resultCode`, `outboxId` |
| `pr.failed` | The PR worker settles a job after a failure or a skip other than an authority refusal. | `resultCode`, `outboxId` |
| `pr.job.claimed` | A worker leases a pending PR job or reclaims one whose lease expired. | `attempt` |
| `pr.job.retry-scheduled` | A failed PR job returns to pending with a retry deadline. | `errorCode`, `blockedUntil` |
| `pr.push.rejected` | A rejected push causes the PR worker to skip the job. | `headBranch`, `reason`, `resultCode`, `outboxId` |
| `pr.pushed` | The worker records a successful push or finishes updating an existing pull request after that push. | `sha`, `headBranch`, `repo`, `status`, `number`, `commits`, `resultCode`, `outboxId` |
| `pr.skipped.authority` | The PR worker skips a job because authority was revoked or PR automation was disabled. | `resultCode`, `outboxId` |
| `pr.snapshot.failed` | A failed worktree snapshot is recorded with a queued Slack notice. | `code`, `outboxId` |
| `pr.sync.recorded` | A ready worktree snapshot creates a pending PR synchronization job. | `sha`, `aheadCount`, `repo` |

## Schedules and routines

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `schedule.cancelled` | An authorized cancellation marks an active schedule cancelled. | — |
| `schedule.authority-revoked` | A claimed schedule is cancelled because its execution authority was revoked. | — |
| `schedule.auto-disabled` | A recurring schedule is cancelled after its failure streak meets the configured count and duration thresholds. | `kind`, `consecutiveFailures`, `streakStartedAt`, `lastErrorCode` |
| `schedule.claimed` | A worker leases a due schedule for dispatch. | `attempt`, `dueAt` |
| `schedule.created` | A new schedule is stored as active. | `kind`, `recurring`, `missedRunPolicy`, `overlapPolicy`, `source` |
| `schedule.denied` | A schedule request is recorded as denied. | — |
| `schedule.run.outcome` | Reconciliation records the final outcome of a schedule run. | `dueAt`, `outcome`, `errorCode` |
| `schedule.run.settled` | A schedule's due run is recorded as dispatched or skipped and its next run is settled. | `dueAt`, `recurring`, `cancelledDuringRun` |

## Slack commands

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `slack.command.denied` | A command event is settled with a denied outcome. | `command`, `reason` |
| `slack.command.executed` | A command event is settled with an outcome other than denied. | `command`, `reason` |

## Slack events

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `slack.delivery.duplicate` | A new delivery refers to an event that already has a canonical operation. | `eventKey` |
| `slack.event.ingested` | A new event is stored with its task and queued user-turn operation. | `eventKey`, `operationKind` |

## Slack files

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `slack.file.attached` | An inbound Slack file's T3 attachment is recorded for an operation. | `ordinal`, `extension`, `sizeBytes`, `t3AttachmentId`, `mimeType` |
| `slack.file.skipped` | An inbound Slack file is recorded without an attachment and with a skip result. | `ordinal`, `extension`, `sizeBytes` |
| `slack.file.upload-blocked` | An outbound file upload fails with credential classes reported by the secret scan. | `classes`, `attempt`, `extension` |
| `slack.file.upload-claimed` | A worker leases an outbound file upload. | `attempt`, `resumed` |
| `slack.file.upload-delivered` | An outbound file upload is marked delivered. | `attempt`, `extension` |
| `slack.file.upload-failed` | An outbound file upload is marked failed and any failure notice is queued. | `noticeOutboxId`, `attempt`, `extension` |
| `slack.file.upload-queued` | An outbound file request from a completed turn is stored for upload. | `ordinal`, `extension` |
| `slack.file.upload-retry-scheduled` | An outbound file upload returns to pending with a retry deadline. | `blockedUntil`, `attempt`, `extension` |

## Slack outbox

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `slack.outbox.claimed` | A worker leases an outbox row for a Slack post or update. | `attempt`, `renderMode`, `method` |
| `slack.outbox.delivered` | An outbox row is marked delivered after a successful Slack send. | — |
| `slack.outbox.enqueued` | A Slack post or update is queued, or a pending update is coalesced. | `clientMessageId`, `chunks`, `method`, `refreshKind`, `targetOutboxId` |
| `slack.outbox.failed` | An outbox row is marked failed after a definitive rejection or revoked authority. | `errorCode`, `retryable` |
| `slack.outbox.fallback-scheduled` | A rejected rich Slack payload is queued again in plain rendering mode. | `errorCode`, `renderMode` |
| `slack.outbox.quarantined` | An ambiguous delivery failure or expired send lease stops automatic resending. | `errorCode`, `retryable` |
| `slack.outbox.retry-exhausted` | An outbox row is marked failed after its final allowed retry attempt. | `errorCode`, `retryable`, `attempts` |
| `slack.outbox.retry-scheduled` | A known-undelivered outbox row returns to pending with a retry deadline. | `errorCode`, `retryable`, `blockedUntil`, `rateLimitedUntil` |

## Slack reactions and status

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `slack.reaction.added` | An acknowledgement reaction is marked delivered. | `errorCode` |
| `slack.reaction.failed` | An acknowledgement reaction is marked failed. | `errorCode` |
| `status.opened` | An operation's first running status record is stored and its status post is queued if needed. | — |
| `status.terminal` | An operation's status becomes done, stopped, expired or failed. | — |

## Tasks and T3 sessions

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `task.branch.deleted` | Cleanup records a retired branch as deleted, already absent, kept for a PR or kept for commits. | `generation` |
| `task.cancellation.requested` | A task cancellation is accepted or an exhausted cancellation is queued again. | `disposition`, `interactionId` |
| `task.cleanup.completed` | Cleanup finishes processing a retired thread, worktree and branch. | `generation`, `worktreeState`, `branchState` |
| `task.cleanup.failed` | Cleanup stops after a safety refusal or exhausted retries. | `generation`, `code`, `attempts` |
| `task.close.requested` | A close request is saved while the task still has work in flight. | `reason` |
| `task.closed` | A quiet active task is closed and its current T3 thread is retired. | `reason`, `generation` |
| `task.reopened` | A closed task reopens with a new session generation and T3 thread ID. | `generation` |
| `task.restart.requested` | A restart request is recorded for an active task. | `command` |
| `task.session.rotated` | Restart replaces a task's T3 thread with the next session generation. | `command`, `generation`, `dropped` |
| `task.session.stopped` | The restart worker records the outcome of stopping a retired T3 session. | `generation`, `errorCode` |
| `task.stop.requested` | A stop or restart request records an interrupt or dropped queued requests. | `command`, `dropped` |
| `task.model.denied` | A requested model selection is recorded as refused. | `instanceId`, `model`, `previousInstanceId`, `previousModel`, `code` |
| `task.model.reverted` | A model selection is reverted after revocation or refusal, or invalid stored selections are cleared. | `instanceId`, `model`, `previousInstanceId`, `previousModel`, `code`, `columns` |
| `task.model.selected` | A task's desired model selection is stored or reset to the default. | `instanceId`, `model`, `previousInstanceId`, `previousModel` |
| `task.t3-bound` | A task's T3 project and thread binding is stored. | `projectId` |
| `task.thread.deleted` | Cleanup records a retired T3 thread as deleted after dispatching its delete command. | `generation`, `threadId` |
| `task.worktree.adopted` | A reopened task adopts a retained dirty worktree from an earlier generation. | `generation` |
| `task.worktree.removed` | Cleanup removes a retired worktree or finds it already gone. | `generation`, `forced` |
| `task.worktree.retained` | Cleanup keeps a dirty worktree until its retention deadline or indefinitely. | `generation`, `retainUntil` |

## Thread context and controls

| Action | When it is written | Notable metadata |
| --- | --- | --- |
| `thread-context.loaded` | A thread context read is recorded as loaded for an operation. | `messages`, `omitted`, `truncated`, `chars` |
| `thread-context.unavailable` | A thread context read is recorded as unavailable for an operation. | `code` |
| `thread-note.dropped` | The oldest pending note is removed to make room under the per-task cap. | `pendingCap` |
| `thread-note.recorded` | A new thread context note is stored for an active task. | `kind`, `speakerKind` |
| `thread.muted` | A thread changes from unmuted to muted. | `reason` |
| `thread.unmuted` | A thread changes from muted to unmuted. | `reason` |
