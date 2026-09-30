# Interaction recovery evidence, 2026-09-21

Actor types: `automated-fixture`, `automated-real`

## Fixture checks

The durable interaction suite covers the same stores and routers used by the Slack bridge:

1. A pending approval or user-input request is stored before its Block Kit prompt enters the Slack outbox. The active operation is deferred instead of being polled in a hot loop.
2. Authorized button actions store a one-shot response with a stable T3 command ID. A forced dispatch failure, database close, and reopen replayed the same command ID and then resolved the interaction.
3. Approval, rejection, provider cancellation, structured question answers, question dismissal, and turn cancellation map to distinct T3 commands.
4. A cancellation action maps the active task to `thread.turn.interrupt`; an interrupted snapshot settles the operation and cancellation message atomically.
5. Wrong workspace, channel, user, task, thread, interaction ID, malformed answer, bot, and stale duplicate paths are rejected or deduplicated before T3 dispatch.
6. Interaction request, response, claim, completion/failure, defer, cancellation, and outbox transitions are auditable.

The current Slack question UI renders choices for the first question, up to five options, plus dismissal when T3 marks the request dismissible. Multi-question forms and custom text answers require the planned modal flow and remain outside the passing claim.

## Real T3 checks

Against T3 Code `0.0.42` on macOS arm64 with real Codex `gpt-5.6-sol` in `approval-required` mode:

- One command request was accepted and the turn completed.
- One or more command requests were declined; pending approval state cleared and the turn completed without executing the rejected command.
- A separate turn was interrupted while waiting for command approval; its snapshot reached `interrupted`.

Live Slack button clicks and process-kill recovery remain blocked on the Slack app installation and are not claimed here.
