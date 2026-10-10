# Draft PR workflow live acceptance (PR-01) — TEMPLATE

Copy to `docs/evidence/<date>-github-draft-pr.md` and fill in every field. Do not mark PR-01 `PASS` from fixtures.

- Date / operator:
- Agent Tag build (commit SHA, `agent-tag --version`):
- Platform (OS, arch), git version, Bun version:
- T3 version and provider/model:
- Sandbox repository (`owner/name`), base branch:
- Token: fine-grained PAT limited to the sandbox (Contents, Pull requests: read/write; Metadata: read). Token file mode `0600`, directory `0700`. Do not paste the token.
- Performed by: human / fixture

## 1. Automated live run

```
AGENT_TAG_LIVE_GITHUB=1 AGENT_TAG_LIVE_GITHUB_REPO=<owner/name> \
AGENT_TAG_LIVE_GITHUB_TOKEN_FILE=<abs path> bun test test/github-live.integration.test.ts
```

- Result (pass/fail, duration):
- Draft PR URL printed by the test:
- PR commit count after the follow-up push:

## 2. Slack transcript (human)

| Step | Slack message | Expected | Observed (redacted IDs) |
| --- | --- | --- | --- |
| 1 | `@Agent Tag fix the typo in README` | Reply, then a draft PR card with "View PR" | |
| 2 | Follow-up in the same thread asking for another small change | "Pushed N commits to owner/name#N" line; same PR number; commit count increases | |
| 3 | `@Agent Tag what does README say?` (new thread) | Reply only; no PR card | |

## 3. Credential isolation

- `ps eww <T3 pid>` and the agent's child processes: no `github_pat_`, no `AGENT_TAG_GIT_TOKEN` (paste the redacted grep command and its empty output):
- `git -C <worktree> config --list --show-origin`: no credential, no remote URL with a token:
- `agent-tag doctor` output for `secret:github-token`, `git-version`, `github-access:*`:

## 4. Audit

- `pr.sync.recorded`, `pr.job.claimed`, `pr.pushed`, `pr.created` rows for step 1; `pr.pushed` for step 2; none for step 3:

## Verdict

PASS / FAIL, with anything not verified listed explicitly.
