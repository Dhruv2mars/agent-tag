# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through [GitHub private vulnerability reporting](https://github.com/Dhruv2mars/agent-tag/security/advisories/new). Include the affected commit or version, your host platform, the T3 Code version, a minimal reproduction, and the impact you observed. Never include real Slack, T3, or provider credentials. Use canary values instead.

We aim to acknowledge a report within 3 business days and to agree on a fix and disclosure timeline within 14 days. We credit reporters in the advisory unless you ask us not to.

## Supported versions

Agent Tag has not made a tagged release yet. Until `v0.1.0`, only the latest commit on `main` gets security fixes. After `v0.1.0`, the latest minor release gets fixes. The previous minor release gets fixes for high-severity issues for 90 days after its successor ships.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Anything older | No |

Agent Tag supports one pinned T3 Code version at a time (see `t3.lock.json`). Security fixes in T3 Code itself must be reported to that project.

## Threat model

Agent Tag lets selected Slack users start coding-agent runs through a local T3 Code server. **An allowed Slack user can make the agent run arbitrary code in every configured repository, with the privileges of the OS user that runs T3.** Each tier below describes who must be trusted for that to be acceptable.

### Tier 1: trusted team, same OS user (supported)

This is the only deployment Agent Tag supports and tests today. The config must say so explicitly: `isolation.mode: "trusted-same-user"` with `acknowledgedSharedMachineAccess: true`.

Assumptions:

- Agent Tag, T3 Code, and every agent process run as **the same OS user** on one host.
- Every user in `access.allowedUserIds` is trusted with shell access to that account. This covers everything the account can read or write: other repositories, `~/.ssh`, cloud credentials, browser profiles, and Agent Tag's own secret files and database.
- Repository content and Slack thread text are untrusted input to the model. Prompt injection from a file, issue, or message can steer the agent within the authority above.
- The host, the OS account, and the T3 server are trusted and patched.

Credentials and state:

- The Slack app token, Slack bot token, and T3 service token each live in a separate file. Every file must be mode `0600` (or stricter), sit in a directory with no group or world access, and be owned by the service user. Agent Tag refuses to read a secret file that breaks these rules.
- The data directory (`dataDir`) must be `0700`. The SQLite store is created as `0600`. It contains Slack message text, agent replies, approval prompts, memory entries, schedules, and the audit log.
- The T3 credential is a **restricted** token with exactly `orchestration:read` and `orchestration:operate`. `bun run enroll:t3` mints it from a T3 administrative token. The admin token is used only during enrollment and should not be stored on the host afterwards. Enrollment verifies that T3's administrative endpoints deny the new token, and `doctor` and every gateway call reject a service token with any other scope. Restricted tokens expire, and there is no automatic rotation yet.
- T3 must be reached over a loopback URL. The config schema rejects any other host.
- macOS LaunchAgent logs are written to `~/Library/Logs/AgentTag` (`0700` directory, `0600` files). They contain structured lifecycle records and error class names, not message text or credentials.

### Tier 2: dedicated OS user or container (guidance only)

Use tier 2 if Slack users must not get the operator's own account, or if a compromised agent must not be able to read Agent Tag's Slack tokens. **Agent Tag does not enforce this tier yet.** The `os-account` and `container` isolation modes are parsed but have no effect, and `agent-tag security audit` reports them as unenforced. The recommended layout:

1. Run T3 Code, and therefore every agent, as a dedicated unprivileged user (for example `agent`) or inside a container. That user should own only the repository checkouts it serves, plus provider credentials scoped to those repositories.
2. Run Agent Tag as a different user (for example `agent-tag`) that owns `dataDir` and the three secret files. The `agent` user must not be able to read them.
3. Give the agent user no `sudo`, no SSH agent forwarding, and no personal cloud or Git credentials. Prefer fine-grained, repository-scoped tokens.
4. Treat each container or account as compromised once it has run untrusted input. Rebuild it rather than cleaning it.

Even in tier 2, the agent can still push to anything its own credentials reach, and it can exfiltrate any repository content it can read over the network unless you add egress controls.

### What Agent Tag protects

- **Who can start work.** Only users in `access.allowedUserIds`, in conversations listed in `access.allowedChannelIds` and bound by a route. DM routes are bound to a single owner. Authority is checked again before every queued turn, interaction response, schedule run, and Slack reply. Removing a user or route stops queued work after a restart.
- **Who can run commands.** `!commands` use the same user, channel, route, and DM-owner checks as requests, then the task's execution authority in a bound thread. `commands.disabled` and `commands.adminOnly` narrow them further. Command replies other than mute notices are visible only to the sender, and commands never store or echo message text.
- **Which repositories a task uses.** Each route is pinned to one root in its profile's `repositoryRoots`. This is a routing guarantee, not a filesystem sandbox.
- **Secrets at rest from other local users.** Owner and mode checks cover the secret files, their parent directory, the data directory, and the database.
- **Secrets in the audit trail.** Audit metadata passes through a redactor for known credential shapes (Slack, GitHub, AWS, Anthropic, OpenAI) before it is written. The audit log never stores Slack message bodies.
- **Least privilege toward T3.** Agent Tag uses an exact-scope restricted token. Enrollment checks that T3's administrative endpoints deny it.
- **Data minimisation.** The optional `retention` config replaces stored message bodies with a marker, and deletes old audit rows, after a set number of days (see [operations](docs/operations.md#data-retention)).
- **Detection.** `agent-tag security audit` checks the controls above and fails on high-severity findings.

### What Agent Tag does not protect

- Anything an allowed Slack user, or a prompt injection, can make the agent do with the OS user's privileges. This includes reading Agent Tag's own tokens in tier 1.
- Filesystem or network isolation between concurrent tasks. Tasks get separate git worktrees, but no sandbox.
- Enforcement of `externalWrites` or `allowedTools`. These fields are recorded but not enforced where tools run. Use T3 `approval-required` runtime mode and keep write credentials off the host.
- Credentials pasted into Slack. They are stored in the database until retention prunes them, and they are passed to the model. Rotate any credential that was posted.
- Provider-side data handling. Prompts and repository content go to whichever model provider the profile selects.
- A compromised host, OS account, T3 server, or Slack workspace admin.
- Denial of service by an allowed user. Concurrency, schedule count, and ambient rate limits apply, but there are no per-user quotas.

## Checking a deployment

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json          # human-readable report
bun run security:audit -- /absolute/path/to/agent-tag.json --json   # machine-readable report
bun run security:audit -- /absolute/path/to/agent-tag.json --log-dir /var/log/agent-tag  # logs outside the macOS LaunchAgent
```

Run it as the Agent Tag service user. In a tier 2 layout, another account cannot inspect the secret files, so the audit reports them as unreadable and fails.

See [operations](docs/operations.md#security-audit) for every check and its severity. The command exits non-zero when any finding is `high`.
