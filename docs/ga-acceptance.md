# GA acceptance matrix

Statuses are `PENDING`, `PASS`, `FAIL`, or `BLOCKED`. A test is `PASS` only when its evidence names the exact build, platform, provider, and whether a human or fixture performed it.

| ID | Required outcome | Minimum evidence | Status |
| --- | --- | --- | --- |
| SLK-01 | A live Slack mention includes relevant prior thread context and completes through T3. | Human transcript with redacted IDs and T3 thread evidence. | BLOCKED: Slack app setup |
| SLK-02 | Repeated and overlapping Slack deliveries create one task and one user turn. | Automated retry fixture plus live retry where practical. | PENDING: durable semantic-event fixture passes; Slack adapter and live retry remain |
| SLK-03 | A second authorized human can steer the same task in preserved order. | Human transcript with two tester identities. | BLOCKED: two-identity ordering fixture passes; live second tester remains |
| SLK-04 | Approval, rejection, question, answer, and cancellation work in Slack and recover after restart. | Automated crash-point suite and human interaction transcript. | PENDING: durable restart fixtures cover all transitions; real T3 approve/decline/interrupt pass; live Slack and process-kill transcript remain |
| SLK-05 | Slack file/image input reaches the authorized task; returned files and PR links are usable. | Human file round trip and draft PR URL. | PENDING |
| T3-01 | The adapter authenticates to pinned T3 `0.0.42` with only required scopes. | Executable compatibility test against release binary. | PASS: `docs/evidence/2026-09-21-t3-adapter.md` |
| T3-02 | Stable command IDs make dispatch replay safe and receipts reconcile after bridge restart. | Crash-point integration test against real T3. | PASS: stable receipt replay plus real T3 dispatch, SQLite close/reopen, new-worker replay, snapshot reconciliation, and atomic outbox completion in `docs/evidence/2026-09-21-service-runtime.md` |
| T3-03 | T3 interruption is distinguished from bridge restart and supported continuation succeeds. | Real-server restart/interruption test. | PENDING: real interruption reaches the distinct `interrupted` state; server restart and continuation remain |
| T3-04 | Provider/model selection is explicit and sticky; unsupported capabilities fail clearly. | Capability matrix against at least two real providers. | FAIL: Codex `gpt-5.6-sol` completes with sticky state and unsupported catalog selections fail closed; real Claude turns with three catalog models enter T3 `provider-api-errors` despite ready/authenticated catalog state |
| ISO-01 | Two concurrent coding tasks use separate worktrees and cannot access unauthorized paths or credentials. | OS/provider-boundary denial tests, not prompt-only evidence. | PENDING |
| ISO-02 | External writes require an approval enforced where the tool executes. | Bypass-focused integration test with write credential withheld until approval. | PENDING |
| MEM-01 | Shared, profile, task, and private memory scopes keep source attribution and support list/edit/forget/retention. | Persistence and cross-identity denial tests plus human exercise. | PENDING: persistence, all four scopes, attribution, list/edit/forget, retention, cross-identity/task denial, audit, and immutable T3 prompt projection pass; live Slack/DM controls and human exercise remain |
| TOOL-01 | Scoped MCP/tool credentials work for documented examples without assuming provider parity. | Live checks per supported provider and integration. | PENDING |
| JOB-01 | Reminders and scheduled jobs survive restart and obey cancellation, missed-run, quiet, concurrency, and resource policies. | Fake-clock suite plus restart test. | PENDING |
| AMB-01 | Ambient participation is opt-in, bounded, quiet when unchanged, and auditable. | Authorization fixtures and one human exercise. | PENDING |
| DM-01 | DMs and assistant threads separate personal identity/context/credentials from shared channels and state machine privacy limits. | Cross-scope denial tests and human DM exercise. | PENDING |
| ACL-01 | Workspace, channel, user, profile, repository, tool, memory, and task authority are consistent at every transition. | Table-driven denial suite with audit records. | PENDING: Slack event/action and memory workspace/user/profile/task/private-scope denials pass; tool and isolation transitions remain |
| REL-01 | In-task serialization, global concurrency bounds, durable outbox, and recovery prevent loss or blind replay. | Deterministic fault-injection suite. | PENDING: SQLite rollback/reopen, lease, ordering, concurrency, atomic completion/outbox, real T3 worker restart, and ambiguous-send quarantine pass; OS process-kill and live Slack crash matrix remain |
| REL-02 | Machine outage and Socket Mode delivery limits are reported accurately; stalled tasks follow the configured policy. | Outage exercise and operator-visible diagnostics. | PENDING |
| OPS-01 | Fresh install, onboarding, diagnostics, background service, upgrade/migration, backup/restore, log redaction, and uninstall work. | Clean-host script and captured run log. | PENDING: foreground service, live doctor path, signal shutdown, migrations, non-destructive backup/restore, and structured log-redaction fixtures exist; clean install, service-manager install, upgrade, and uninstall remain |
| OPS-02 | macOS claims require a logged-in, awake machine; Linux service claims match tested behavior. | Platform-specific service evidence. | PENDING |
| SEC-01 | Secrets never enter prompts, logs, screenshots, fixtures, artifacts, or public files; asset paths are scoped. | Secret-canary and log scan tests. | PENDING: secret-file ownership/mode and administrative-token denials pass; structured runtime log canary passes; full prompt/artifact/repository scan remains |
| AUD-01 | Every state-changing action has actor, authority, source, target, result, and correlation IDs. | Queryable audit export from acceptance run. | PENDING: paginated NDJSON export plus durable core, interaction, and memory transition/denial rows pass without message bodies; remaining feature transitions and acceptance-run export remain |
| LIC-01 | Provider terms are documented without claiming an individual's CLI subscription permits shared commercial use. | Reviewed operations documentation and notices. | PENDING |
| GA-01 | Runnable release, exact version/platform/provider list, residual limitations, repository/PR links, and honest decision are published. | Release artifact and final report; all required rows `PASS`. | PENDING |

## Evidence rules

- Mocks may test local logic but cannot satisfy a live Slack, provider, T3, filesystem-isolation, or installation claim.
- Secrets and full private message content never belong in evidence. Store redacted event IDs, timestamps, hashes, actor labels, and artifact links.
- Each run records `human`, `automated-real`, or `automated-fixture` as the actor type.
- A missing credential or tester leaves the row `BLOCKED`; it does not shrink the GA definition.
