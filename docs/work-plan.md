# GA work plan

The definition of done is mechanical: every required row in [the acceptance matrix](ga-acceptance.md) is `PASS`, its evidence resolves, release installation succeeds on a clean supported host, and no required test is skipped. `BLOCKED` is honest progress, not GA.

## Current phases

| Phase | Exit condition | State |
| --- | --- | --- |
| Ground | Exact T3 release contract, Slack delivery behavior, security boundaries, and failure model are traced to source. | In progress |
| Sketch | At least two designs are compared; the chosen module map and invariants are recorded. | Complete |
| Agree | The chosen design matches the user-approved T3-only architecture and adds no unsupported service. | Complete |
| Implement | End-to-end increments pass unit, integration, restart, security, and operational tests. | In progress |
| Scrap | If repeated implementation friction disproves the design, replace it rather than adding escape hatches. | Armed |
| Validate | Automated fixtures and explicitly labeled human/live exercises satisfy the GA matrix. | Pending |
| Release | Signed/tagged artifacts, upgrade, backup/restore, notices, and uninstall are verified. | Pending |

## End-to-end increments

1. Pin and probe T3 `0.0.42`; authenticate with least-privilege orchestration scopes; dispatch one durable turn and stream its result.
2. Receive a Slack mention, deduplicate it, bind it to a task/thread, serialize steering, and deliver progress and completion.
3. Complete approval, rejection, question, cancellation, file input, artifact output, and PR-link flows.
4. Enforce profiles, repository and identity access, provider capability checks, execution limits, and external-write policy at executable boundaries.
5. Add scoped memory, edit/forget/retention controls, schedules, missed-run policy, stalled-task follow-up, and opt-in ambient participation.
6. Reconcile bridge/T3 restarts, test concurrent isolated tasks, add diagnostics, backups, migrations, service operation, upgrade, uninstall, release packaging, and notices.
7. Run the human/live acceptance script and record who exercised each interaction.

The implementation stays small until an acceptance row proves that another module or dependency is necessary.
