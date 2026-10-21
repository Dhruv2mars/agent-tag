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
- Every user in `access.allowedUserIds` is trusted with shell access to that account. With `access.mode: "channel-members"`, so is every non-guest member of every channel in `access.allowedChannelIds`: anyone who can join such a channel can run code as the host user. Guests are recognized only when Agent Tag can read the account kind (`users:read`); if that lookup fails or is disabled, a guest member may still start turns, though never approve. This covers everything the account can read or write: other repositories, `~/.ssh`, cloud credentials, browser profiles, and Agent Tag's own secret files and database.
- Repository content and Slack thread text are untrusted input to the model. Prompt injection from a file, issue, or message can steer the agent within the authority above.
- The host, the OS account, and the T3 server are trusted and patched.

Credentials and state:

- The Slack app token, Slack bot token, and T3 service token each live in a separate file. Every file must be mode `0600` (or stricter), sit in a directory with no group or world access, and be owned by the service user. Agent Tag refuses to read a secret file that breaks these rules.
- The data directory (`dataDir`) must be `0700`. The SQLite store is created as `0600`. It contains Slack message text, agent replies, approval prompts, memory entries, schedules, and the audit log.
- The T3 credential is a **restricted** token with exactly `orchestration:read` and `orchestration:operate`. `bun run enroll:t3` mints it from a T3 administrative token. The admin token is used only during enrollment and should not be stored on the host afterwards. Enrollment verifies that T3's administrative endpoints deny the new token, and `doctor` and every gateway call reject a service token with any other scope. Restricted tokens expire. With a managed T3, Agent Tag rotates the token before it expires and revokes the replaced one; with an external T3, run `agent-tag t3 rotate`.
- Retiring a closed task's session uses that same token: `thread.delete`, `vcs.refreshStatus` and `vcs.removeWorktree` are `orchestration:operate` calls, so cleanup needs no new scope. Before removing a worktree, Agent Tag checks that the path is absolute, is not the repository root, the data directory, the home directory or an ancestor of one, is listed by `git worktree list` on the task's own branch, and is bound to no other T3 thread. A branch is deleted only with `git branch -d` (never `-D`) and only when its name is the task's own `agent-tag/<task-id>[-g<n>]`.
- T3 must be reached over a loopback URL. The config schema rejects any other host.
- macOS LaunchAgent logs are written to `~/Library/Logs/AgentTag` (`0700` directory, `0600` files). They contain structured lifecycle records and error class names, not message text or credentials.

### Tier 2: dedicated OS user or container (guidance only)

Use tier 2 if Slack users must not get the operator's own account, or if a compromised agent must not be able to read Agent Tag's Slack tokens. **Agent Tag does not enforce this tier yet.** The `os-account` and `container` isolation modes are parsed but have no effect, and `agent-tag security audit` reports them as unenforced. The recommended layout:

1. Run T3 Code, and therefore every agent, as a dedicated unprivileged user (for example `agent`) or inside a container. That user should own only the repository checkouts it serves, plus provider credentials scoped to those repositories.
2. Run Agent Tag as a different user (for example `agent-tag`) that owns `dataDir` and the three secret files. The `agent` user must not be able to read them.
3. Give the agent user no `sudo`, no SSH agent forwarding, and no personal cloud or Git credentials. Prefer fine-grained, repository-scoped tokens.
4. Treat each container or account as compromised once it has run untrusted input. Rebuild it rather than cleaning it.

Even in tier 2, the agent can still push to anything its own credentials reach, and it can exfiltrate any repository content it can read over the network unless you add egress controls.

### Request path

What happens to one Slack mention, and which check applies at each hop:

| Hop | What crosses it | Check |
| --- | --- | --- |
| Slack → Agent Tag | The event over Socket Mode (outbound WebSocket; no inbound port) | Workspace id; user, channel and route authority (`access.*`, `routes`); DM owner; duplicate delivery |
| Agent Tag → SQLite | Message text, task, operation, audit row | Store is `0600` in a `0700` `dataDir`; audit metadata is redacted |
| Agent Tag → T3 | The turn: prompt, thread context, memory block, attachments | Loopback URL only; restricted token with exactly `orchestration:read orchestration:operate`; authority re-checked before every queued turn |
| T3 → provider | Prompt and repository content | The provider's own terms ([provider licensing](docs/provider-licensing.md)); runs as the host OS user |
| Agent → host | Shell, files, network | None beyond the OS user (tier 1). `approval-required` runtime mode asks in Slack before T3 runs a command or edit |
| Agent Tag → GitHub | `git push` and the draft PR API call | Configured repository only; token passed through `GIT_ASKPASS` to one `git` child, never in argv, git config or a remote URL; secret scan of the diff |
| Agent Tag → Slack | Replies, status edits, cards, shared files | Authority re-checked before each reply; upload path and secret-scan gates (below) |

### Credentials

| Credential | Where it lives | Who reads it | Rotation |
| --- | --- | --- | --- |
| Slack app token (`xapp-`) | `slack.appTokenFile`, mode `0600` | Agent Tag | Regenerate in the Slack app settings, replace the file, `agent-tag service restart` |
| Slack bot token (`xoxb-`) | `slack.botTokenFile`, mode `0600` | Agent Tag | Reinstall the app, replace the file, restart |
| T3 restricted token | `t3.tokenFile`, mode `0600` | Agent Tag | Managed T3 (`t3.mode: "managed"`): Agent Tag mints, rotates before expiry and revokes replaced tokens itself. External T3: `agent-tag t3 rotate CONFIG --admin-token-file F`, or `bun run enroll:t3` |
| GitHub fine-grained token | `github.auth.tokenFile`, mode `0600` | Agent Tag only, for one `git push` child at a time and the PR API | Create a new token on GitHub, replace the file. Limit it to the sandbox or target repositories |
| Provider logins (Codex, Claude) | The provider CLIs' own files in the host user's home | T3 and every agent process | With each provider's CLI |

In tier 1 every agent process runs as the same OS user, so it can read all of these files. The modes stop other local users, not the agent.

### What Agent Tag protects

- **Who can start work.** Only users in `access.allowedUserIds` (plus current channel members in `channel-members` mode; guests never approve, other bots never qualify, and unreadable or stale membership fails closed), in conversations listed in `access.allowedChannelIds` and bound by a route. DM routes, configured or auto-routed, are bound to a single allowlisted owner; membership never grants a DM. Authority is checked again before every queued turn, interaction response, schedule run, and Slack reply. Removing a user or route stops queued work after a restart.
- **Who can run commands.** `!commands` use the same user, channel, route, and DM-owner checks as requests, then the task's execution authority in a bound thread. `commands.disabled` and `commands.adminOnly` narrow them further. Command replies other than mute, stop and restart notices are visible only to the sender, and commands never store or echo message text.
- **Who can manage routines.** Routine requests from Slack need an explicit mention or the DM owner, and pass the same user, channel, route, and task checks as prompts. A channel's routines can be cancelled by any allowed user there; DM routines only by the owner. Button clicks are re-checked against the loaded config. A routine runs later without anyone watching, under the profile of the thread it was created in, so routines on a `full-access` profile run autonomously.
- **Which repositories a task uses.** Each route is pinned to one root in its profile's `repositoryRoots`. This is a routing guarantee, not a filesystem sandbox.
- **Secrets at rest from other local users.** Owner and mode checks cover the secret files, their parent directory, the data directory, and the database.
- **Secrets in the audit trail.** Audit metadata passes through a redactor for known credential shapes (Slack, GitHub, AWS, Anthropic, OpenAI) before it is written. The audit log never stores Slack message bodies.
- **Least privilege toward T3.** Agent Tag uses an exact-scope restricted token. Enrollment checks that T3's administrative endpoints deny it.
- **Data minimisation.** The optional `retention` config replaces stored message bodies with a marker, and deletes old audit rows, after a set number of days (see [operations](docs/operations.md#data-retention)).
- **Files the agent shares to Slack.** A reply line `[[agent-tag:upload <path>]]` shares a file only from the task's own worktree, only into the task's own thread, after the task's authority is re-checked. Absolute, `~`, `..` and hidden paths (`.env`, `.ssh/`, `.git/`) are refused, and so is a symlink that resolves outside the worktree or onto a hidden file. Every file is scanned for the known credential shapes (text and the readable runs of binary files) and held back with a thread notice on a match; the audit row records the credential class and the file's extension, never its content or name. Compressed content (zip, xlsx, image data) is not inspected, and the agent can still copy any file it can read into its worktree first, so this is defence in depth, not a boundary. Set `files.outbound.enabled` to `false` to turn sharing off.
- **Detection.** `agent-tag security audit` checks the controls above and fails on high-severity findings.

### What Agent Tag does not protect

- Anything an allowed Slack user, or a prompt injection, can make the agent do with the OS user's privileges. This includes reading Agent Tag's own tokens in tier 1.
- Filesystem or network isolation between concurrent tasks. Tasks get separate git worktrees, but no sandbox.
- Enforcement of `externalWrites` or `allowedTools`. These fields are recorded but not enforced where tools run. Use T3 `approval-required` runtime mode and keep write credentials off the host.
- Credentials pasted into Slack. They are stored in the database until retention prunes them, and they are passed to the model. Rotate any credential that was posted.
- Provider-side data handling. Prompts and repository content go to whichever model provider the profile selects.
- A compromised host, OS account, T3 server, or Slack workspace admin.
- Denial of service by an allowed user. Concurrency, schedule count, and ambient rate limits apply, but there are no per-user quotas.

### What Agent Tag does not guarantee, compared with Claude Tag

Claude Tag runs each thread in an Anthropic-hosted sandbox and injects credentials at a proxy, so the sandbox holds none ([security and data](https://claude.com/docs/claude-tag/concepts/security-and-data)). Agent Tag runs on your host, so these guarantees do not carry over. Each is a row in the [GA matrix](docs/ga-acceptance.md), proposed as out of scope for v0.1.0 (owner decision O-1):

| Row | Claude Tag | Agent Tag |
| --- | --- | --- |
| ISO-01 | A separate sandbox per thread, discarded when idle | A separate git worktree per task, same OS user, no filesystem or network isolation between tasks |
| ISO-02 | External writes go through a proxy that enforces approval | `externalWrites` is recorded, not enforced where the tool runs. `approval-required` asks before T3 runs a command, but the command itself is not sandboxed |
| TOOL-01 | Connections with scoped credentials, managed by an admin ([add connections](https://claude.com/docs/claude-tag/admins/add-connections)) | No connection layer. Tools use whatever credentials the host user has |
| AMB-01 | Claude may join a conversation unprompted when enabled ([when Claude responds](https://claude.com/docs/claude-tag/users/when-claude-responds)) | Off by default; experimental, planned to be finished after GA |

The GA claim is "self-hosted, for a single trusted team" (tier 1). See [parity](docs/parity.md) for every other difference.

## Checking a deployment

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json          # human-readable report
bun run security:audit -- /absolute/path/to/agent-tag.json --json   # machine-readable report
bun run security:audit -- /absolute/path/to/agent-tag.json --log-dir /var/log/agent-tag  # logs outside the macOS LaunchAgent
```

Run it as the Agent Tag service user. In a tier 2 layout, another account cannot inspect the secret files, so the audit reports them as unreadable and fails.

See [operations](docs/operations.md#security-audit) for every check and its severity. The command exits non-zero when any finding is `high`.
