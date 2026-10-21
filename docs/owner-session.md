# Owner session script

This is the one live Slack session that resolves the GA matrix rows a test cannot pass by itself (`docs/ga-acceptance.md`, Kind `owner-session`). It runs once, on a `v0.1.0-rc.N` build, in about 100 minutes. Every step names its matrix rows, what to send, what to expect, what the agent records, and what happens if it fails.

## Who does what

| Actor | Means |
| --- | --- |
| **agent** | An agent with a shell on the host. It runs `agent-tag` commands, edits the host config, restarts the service and writes evidence. |
| **agent-CU** | An agent driving Slack through computer use (Haiku 5.5, high effort, `oai-cua` plugin), in workspace `T0BS9MA4BUP` (dhruv2mars) only. **App (Dhruv):** every step on the owner's account runs in the Slack desktop app (`/Applications/Slack.app`, signed in as Dhruv), driven with `get_app_state` on `"Slack"`, never Slack in a browser. **Helium (tester):** the app cannot hold a second account on the same workspace, so steps on the tester's account ("Agent Tag Tester", `U0CBQ5BNKEU`) run in Helium's profile "Agent Tag Tester" (`Profile 1`), opened with `open -na Helium --args --profile-directory="Profile 1" "https://app.slack.com/client/T0BS9MA4BUP/C0C2RHJ1BUP"`; its window title ends in "- Helium - Agent Tag Tester". Never Chrome or Safari. Evidence for a step that used Helium says so. Computer-use policy requires a confirmation at the moment of each Slack post, click on a card, or channel membership change, so Dhruv stays at the keyboard to confirm. |
| **Dhruv** | Only the owner can do it: decisions, creating a GitHub token, approving the release tag. |

Every Slack message below goes to channel `C0C2RHJ1BUP` (`#agent-tag-test`) unless it says DM. The owner's DM with the bot is `D0C4MK74G02`. `@Agent Tag` is the bot mention. `CONFIG` is the live host config. The session agent edits it only with Dhruv's go-ahead, given at the start of the session, and restores it in step 12. Every config change is followed by `agent-tag service restart CONFIG`.

## Models (Slack model rule)

Dhruv's rule (2026-10-21): an install that answers in Slack runs only `codex` / `gpt-6-luna` or `claudeAgent` / `claude-haiku-5-5`. No other model may answer in Slack during this session, including in a refusal test. For the whole session, `CONFIG` holds:

- every profile (including `routine-fail` in step 1): `"defaultProviderInstanceId": "codex"`, `"defaultModel": "gpt-6-luna"`;
- no route `defaultModel`;
- `allowedModels` on every profile: `{ "instanceId": "codex", "model": "gpt-6-luna", "label": "Luna", "aliases": ["luna"] }` and `{ "instanceId": "claudeAgent", "model": "claude-haiku-5-5", "label": "Haiku 5.5", "aliases": ["haiku"] }`.

The pinned T3 0.0.45 lists `claude-haiku-5-5` only after its remote model manifest refreshes, so preflight restarts managed T3 once after its first boot. `claude-haiku-4-5` is never a substitute.

`agent-tag audit CONFIG` prints the whole audit log as JSON lines and exits. The agent notes the session start time (UTC) in preflight, and after each step runs `agent-tag audit CONFIG > <session dir>/audit.jsonl` and reads only records whose `createdAt` is at or after that time. Evidence quotes only action names, IDs and timestamps from it: never message text, tokens or file contents.

## Prerequisites

| # | What | Status | Who |
| --- | --- | --- | --- |
| P1 | Slack app reinstalled with the 11-scope manifest (`config/slack-manifest.example.json`): `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `files:write`, `groups:history`, `groups:read`, `im:history`, `reactions:write`, `users:read`. Afterwards `agent-tag doctor CONFIG` reports no missing scope. | Done (2026-10-21) | — |
| P2 | GitHub sandbox repository plus a fine-grained personal access token limited to it (Contents: read/write, Pull requests: read/write, Metadata: read). The agent asks for the token with `request_secret` and writes it to a `0600` file. Needed for step 8. | **Open** | Creating the repository: agent (`gh repo create`). Creating the token: agent-CU in Helium with Dhruv confirming, or Dhruv. |
| P3 | A second human Slack account in `T0BS9MA4BUP`: "Agent Tag Tester", `U0CBQ5BNKEU`, a member of `C0C2RHJ1BUP`. Needed for steps 3, 4, 10 and 11. | Done | — |
| P4 | Optional: a clean Ubuntu 24.04 VM for the linux-x64 half of T3-05. Without it, `T3-05L` stays `UNCONFIRMED` (decision O-2). | Optional | Dhruv |

## Steps

Run them in this order. Step 1 starts first because its routines need time to fire.

### 0. Preflight (5 min)

- **Matrix rows:** OPS-01, T3-05, SEC-01, AUD-01, GA-01
- **Who:** agent
- **Do:** note the session start time (UTC). Install `v0.1.0-rc.N` on the host with the pinned installer (`AGENT_TAG_VERSION=0.1.0-rc.N`, see `docs/install.md`), then `agent-tag service upgrade CONFIG`. Restart managed T3 once (`agent-tag service restart CONFIG`) so its model manifest refreshes.
- **Expect:**
  - `agent-tag version --json` names the rc build.
  - `agent-tag doctor CONFIG --json`: every check passes and there is no `missing_scope`.
  - `agent-tag t3 status CONFIG` reports the pinned T3 `0.0.45` (the version in `t3.lock.json`), installed and verified.
  - `agent-tag security audit CONFIG --json` has no findings. `bun run scan:secrets` passes on the release commit.
  - `agent-tag service status CONFIG` shows the service running.
  - The model rule holds: `jq '[.profiles[] | [.defaultProviderInstanceId, .defaultModel]], [.profiles[].allowedModels[]? | [.instanceId, .model]], [.routes[].defaultModel? | select(. != null)]' CONFIG` prints only `codex`/`gpt-6-luna` and `claudeAgent`/`claude-haiku-5-5`, and no route default.
  - After the restart, the T3 catalog lists `gpt-6-luna` and `claude-haiku-5-5`: `agent-tag doctor CONFIG --json` reports both `allowedModels` entries as `available` (doctor checks each against the live T3 catalog). If either is unavailable, stop the session.
- **Agent captures:** the outputs above, with any secret-looking values redacted → `docs/evidence/<date>-owner-preflight.md`. The Build string for every row in this session comes from `version --json`.
- **Fallback:** if `doctor` fails, stop the session and fix that first. Nothing after this step is valid on a broken install.

### 1. Routines (J) — start first

- **Matrix rows:** JOB-01, JOB-02
- **Who:** agent (config), agent-CU: app (Dhruv)
- **Preconditions:** `routines.autoDisable.minFailureSpanSeconds` lowered to `600` for the session; restart.
- **Failing routine (agent):** a run counts as failed only when its operation fails, and a prompt that merely reports an error succeeds. So the agent adds a profile `routine-fail` (on `codex`/`gpt-6-luna`, like every profile) whose only repository root is a throwaway git repository with `baseBranch` set to a branch that does not exist, points the owner's DM route (`D0C4MK74G02`) at `routine-fail`, and restarts. A routine binds to the task of the thread it is requested in, and that task takes the route's profile. Agent-CU sends the DM `every 5 minutes say ok` (5 minutes is the shortest interval) and waits for the confirmation. Each run re-checks that the DM route still names `routine-fail`, and a run that finds it changed revokes the routine instead of failing, so the DM stays routed to `routine-fail` until the routine is turned off. Only then, and before step 6 (the first later step that uses the DM), does the agent point the DM route back at its own profile and restart. Three failed runs over at least 10 minutes turn it off. Rehearse this on a private T3 before the session; if the run does not fail there, pick another persistent start failure and record which one in the evidence.
- **Send, in order:**
  1. (the failing routine above, in the DM)
  2. `@Agent Tag every weekday at 9am summarize open PRs`
  3. `@Agent Tag remind me in 10 minutes to check the deploy`
  4. `@Agent Tag every day at 9am standup notes in Europe/London`
  5. `@Agent Tag list routines`
  6. `@Agent Tag cancel routine <id from step 5>`
  7. Press **Cancel** on another routine's card.
  8. DM: `list routines`
- **Expect:** each creation is confirmed with its next run time in the right zone (step 4 in Europe/London). The reminder fires about 10 minutes later. The list matches what was created. Both cancels are confirmed and the routine stops appearing. The DM list shows only DM routines, including the failing one until it is turned off. The failing routine is turned off after its third failure, with a notice in its thread. Remove the `routine-fail` profile in step 12.
- **Agent captures:** `schedule.created`, `schedule.cancelled`, `schedule.run.outcome`, `schedule.auto-disabled` → fill in `docs/evidence/2026-10-21-routines-slack.md` §Owner session.
- **Fallback:** a failed check sets JOB-01 or JOB-02 to `FAIL` with the evidence file, and the session continues.

### 2. Ack, live status, Stop, footer (F)

- **Matrix rows:** SLK-06
- **Who:** agent (config), agent-CU: app (Dhruv)
- **Preconditions:** `limits.maxConcurrentTasks: 1`; restart.
- **Send:**
  1. `@Agent Tag write a 300-word summary of README.md` (keeps the only coordinator busy), then within a few seconds, in a new thread: `@Agent Tag say hello`.
  2. In a new thread, three turns: `@Agent Tag list the files in src/slack`, then two follow-up replies in the same thread that ask small questions about those files.
  3. In a new thread: `@Agent Tag read every file in src and summarize each one`, then press **Stop** after a few seconds.
- **Expect:** 1: the second mention gets 👀 within 2 s while the first is still running. 2: one status message per turn, at least 3 visible edits to a status message, a `Done in …` line, and a footer with the model and provider on each reply (`gpt-6-luna · codex`; any other model in a footer stops the session). 3: the status reads "Stopped by @Dhruv" and no final reply is posted.
- **Agent captures:** `slack.reaction.added` time vs `slack.event.ingested` time, `status.opened` / `status.terminal`, `task.stop.requested` → `docs/evidence/<date>-owner-f.md`. Restore `maxConcurrentTasks`.
- **Fallback:** `FAIL` SLK-06 with the evidence, continue.

### 2a. Close and reopen (N)

- **Matrix rows:** LIFE-01
- **Who:** agent (CLI), agent-CU: app (Dhruv)
- **Do:** after step 2 finishes, the agent finds the three-turn task from step 2.2 with `agent-tag tasks list CONFIG --state active --json` and closes it with `agent-tag tasks close <task id> CONFIG`. Then the owner replies in that thread: `@Agent Tag how many files did you list?`
- **Expect:** `tasks list --state closed` shows the task closed. The reply reopens it with a new generation and a new T3 thread, and the turn completes in the same Slack thread.
- **Agent captures:** `task.closed`, `task.reopened` (with `generation`), `operation.completed` → `docs/evidence/<date>-owner-n.md`.
- **Fallback:** `FAIL` LIFE-01, continue.

### 3. Thread context and two humans (G)

- **Matrix rows:** SLK-01, SLK-03
- **Who:** agent (config), agent-CU: app (Dhruv) for owner messages and the edit, Helium (tester) for tester messages
- **Preconditions:** the tester `U0CBQ5BNKEU` is in `access.allowedUserIds`; restart.
- **Send:**
  1. Owner and tester post three plain messages in a new thread (no mention): a decision, a question, an answer.
  2. Owner: `@Agent Tag summarize this thread and say who said what`.
  3. Tester, in the same thread without a mention: `Agent Tag, also list the open question`.
  4. Owner edits their first message.
- **Expect:** 2: the summary names both people correctly and uses all three messages. 3: the follow-up is handled as part of the same task, in order. 4: the edit is noted, and the bot's own status edits produce no new ingest rows.
- **Agent captures:** `slack.event.ingested` rows (count and kinds only), `operation.claimed` order → `docs/evidence/<date>-owner-g.md`.
- **Fallback:** `FAIL` the row that failed, continue.

### 4. `!commands` (H)

- **Matrix rows:** SLK-07
- **Who:** agent-CU: app (Dhruv) for every command, Helium (tester) for the unmentioned message after `!mute`
- **Send:** `@Agent Tag !help`; `@Agent Tag !status` while idle and again during a running turn; `@Agent Tag !mute`, then a message in that thread without a mention (from the tester), then `@Agent Tag hello` (unmutes); `@Agent Tag !stop` during a turn; `@Agent Tag !restart`.
- **Expect:** `!help` lists the commands. `!status` shows idle, then busy. After `!mute` the unmentioned message is ignored, and the next mention unmutes. `!stop` stops the turn. `!restart` starts a new T3 thread.
- **Agent captures:** `slack.command.executed`, `task.session.stopped`, `task.restart.requested`, `task.session.rotated` (new T3 thread id) → `docs/evidence/<date>-owner-h.md`.
- **Fallback:** `FAIL` SLK-07, continue.

### 5. Approvals and restart recovery (I)

- **Matrix rows:** SLK-04, REL-01
- **Who:** agent (config, restart), agent-CU: app (Dhruv)
- **Preconditions:** the profile's `runtimeMode: "approval-required"` and `limits.interactionExpirySeconds: 60`; restart.
- **Send:**
  1. `@Agent Tag create a file notes/approval-test.txt containing "ok"`. Press **Allow once** on the card.
  2. Repeat with `notes/expiry-test.txt`, and do not answer for 60 s.
  3. Repeat with `notes/restart-test.txt`. While the card is pending, the agent runs `agent-tag service restart CONFIG`. After the service is back, press **Allow once**.
  4. Repeat with `notes/decline-test.txt` and press **Decline**.
  5. In a new thread: `@Agent Tag use haiku: use your question tool to ask me whether the file should be called red.txt or blue.txt, then create notes/<answer>`. Press **blue.txt** on the question card, then **Allow once** on the approval card.
  6. Repeat 5 with `green.txt or gold.txt`, and press **Stop** while the question card is pending.
- **Expect:** 1: the card updates to the decision within 2 s and the turn completes. 2: the card shows Expired. 3: the click after the restart is honoured exactly once and the turn completes. 4: the card shows the decline and the turn ends without the file. 5: the question card lists both choices, updates to the answer, and the turn creates `notes/blue.txt` on `claude-haiku-5-5`. 6: the question card closes and the turn stops without a file.
- **Agent captures:** `interaction.approval.requested`, `interaction.user-input.requested`, `interaction.response.*`, `interaction.expired`, `interaction.adopted`, `interaction.closed`, `task.stop.requested` → `docs/evidence/<date>-owner-i.md`. Restore `runtimeMode` and `interactionExpirySeconds`.
- **Rehearsal:** Codex asks questions only in plan mode, which Agent Tag never uses, so the question comes from Haiku 5.5. Rehearse 5 on a private T3 first. If no question card appears there, the question half of SLK-04 stays `UNCONFIRMED`; record that.
- **Fallback:** `FAIL` the row, continue. SLK-04's automated-real half passes on Luna (`docs/evidence/2026-10-21-t3-live-luna-haiku.md`); this step is the human half.

### 6. Memory (K)

- **Matrix rows:** MEM-01
- **Who:** agent-CU: app (Dhruv), agent (CLI)
- **Send:** the seven steps in `docs/evidence/2026-10-21-memory-slack.md` §Owner session: remember for this channel, what do you remember, a new thread that should use it, workspace memory, a refusal in a private channel, the DM note `remember: I prefer terse replies`, forget by reference.
- **Expect:** as listed in that file. The memory CLI (step 8 there) lists the same entries.
- **Agent captures:** `memory.created`, `memory.denied`, `memory.forgotten` (no content) → fill in that file.
- **Fallback:** `FAIL` MEM-01, continue.

### 7. Files (L)

- **Matrix rows:** SLK-05, SEC-01
- **Who:** agent-CU: app (Dhruv)
- **Send:** the four steps in `docs/evidence/2026-10-21-slack-files.md` §3: a PNG and a CSV with `@Agent Tag describe both files`; `@Agent Tag write a CSV summary to out/summary.csv and share it`; download the shared file; attach a file over the size limit.
- **Expect:** both files are described; the generated file is uploaded to the thread and downloads intact; the oversized file gets a notice and is not passed on.
- **Agent captures:** `slack.file.attached`, `slack.file.skipped`, `slack.file.upload-delivered` → fill in that file.
- **Fallback:** `FAIL` SLK-05, continue.

### 8. Draft pull requests (M)

- **Matrix rows:** SLK-08, PR-01
- **Who:** agent (config, live test), agent-CU: app (Dhruv)
- **Preconditions:** P2 done. The sandbox checkout is added to the profile's `repositoryRoots`, and the `C0C2RHJ1BUP` route's `repositoryRoot` is set to it, so turns in the test channel run there. The profile's `pullRequests` is `{ "mode": "auto", "repositories": [{ "root": "<sandbox checkout>", "repo": "<owner/name>" }] }` and the top-level `github.auth` is `{ "type": "token", "tokenFile": "<0600 file>" }`. `agent-tag doctor CONFIG` shows `github-access` passing. Restart.
- **Send:** the three steps in `docs/evidence/TEMPLATE-github-draft-pr.md` §2: `@Agent Tag fix the typo in README`; a follow-up in the same thread asking for one more small change; `@Agent Tag what does README say?` in a new thread.
- **Expect:** a draft PR card with "View PR"; the follow-up pushes to the same PR; the question opens no PR. The agent also runs the template's §1 live test and its §3 credential checks.
- **Agent captures:** copy the template to `docs/evidence/<date>-github-draft-pr.md` and fill in every section.
- **Fallback:** `FAIL` SLK-08 and PR-01, continue.

### 9. Model switch (P2)

- **Matrix rows:** MOD-01
- **Who:** agent-CU: app (Dhruv)
- **Models:** only the two in [Models](#models-slack-model-rule). With one allowed model per driver, a same-driver switch in place cannot run in Slack; that half of MOD-01 rests on the live T3 run in `docs/evidence/2026-10-21-model-switch.md`.
- **Send:**
  1. In a new thread: `@Agent Tag use luna: reply with exactly ok`.
  2. In that thread, now started: `@Agent Tag use gpt-6-sol`. The T3 catalog lists it but `allowedModels` does not, so this is refused and runs nothing. (A name that is neither an allowed alias nor a full catalog slug, such as `opus`, is not read as a model switch at all.)
  3. In a new thread: `@Agent Tag use haiku: reply with exactly ok`.
  4. In the started Codex thread from 1: `@Agent Tag use haiku`.
- **Expect:** 1: the reply's footer reads `gpt-6-luna · codex`. 2: refused as not allowed, the reply lists Luna and Haiku 5.5, and the thread keeps `gpt-6-luna`. 3: the turn runs on `claudeAgent`/`claude-haiku-5-5` and its footer says so. 4: refused as a cross-driver switch on a started thread; the thread keeps `gpt-6-luna`.
- **Agent captures:** `task.model.selected`, `task.model.denied` (with codes) → `docs/evidence/<date>-owner-p2.md`.
- **Fallback:** `FAIL` MOD-01, continue.

### 10. Channel-members access (Q1)

- **Matrix rows:** ACL-02, ACL-01
- **Who:** agent (config), agent-CU: Helium (tester) for the mentions and the Allow click, app (Dhruv) for removing and re-inviting the tester
- **Preconditions:** `access.mode: "channel-members"`, and the tester is **not** in `access.allowedUserIds`; restart.
- **Send:** the four steps in `docs/evidence/2026-10-21-q1-access.md` §2: the tester mentions the bot; the tester presses Allow on an approval card; the owner removes the tester from the channel and waits `ttlSeconds` (300 s); the tester mentions again.
- **Expect:** a turn runs; the approval is honoured; after removal the mention is ignored and audit shows `access.denied` with `user-denied`.
- **Agent captures:** fill in that file. Re-invite the tester afterwards.
- **Fallback:** `FAIL` ACL-02, continue.

### 11. Direct messages

- **Matrix rows:** DM-01
- **Who:** agent-CU: Helium (tester) for the tester's DM, app (Dhruv) for the owner's DM
- **Preconditions:** `access.mode: "allowlist"` again, the tester not in `access.allowedUserIds`, and `access.directMessages` as before the session (the owner's DM is routed); restart.
- **Send:** the tester DMs the bot `hello`; the owner DMs `say hi` in `D0C4MK74G02`.
- **Expect:** the tester gets no turn (audit shows a denial); the owner's DM completes.
- **Agent captures:** `access.denied`, `operation.completed` → `docs/evidence/<date>-owner-dm.md`.
- **Fallback:** `FAIL` DM-01, continue.

### 12. Close

- **Matrix rows:** GA-01, LIC-01, ISO-01, ISO-02, TOOL-01, AMB-01, plus every row above
- **Who:** agent (evidence, config restore), Dhruv (decisions, tag)
- **Agent:** restore `CONFIG` to its pre-session copy and restart; run `agent-tag doctor CONFIG`; write every evidence file named above and add a row for each to `docs/evidence/index.tsv` with actor `human`; open the U1c PR that flips the rows that passed.
- **Dhruv decides** (defaults in brackets; the agent records each in `docs/audit/decisions.tsv`):
  - **O-1** ISO-01, ISO-02, TOOL-01 and AMB-01 are `OUT-OF-SCOPE` for v0.1.0 [yes].
  - **O-2** T3-05 linux-x64 stays `UNCONFIRMED` without P4 [yes].
  - **O-3** v0.1.0 claims darwin-arm64 as live-verified and the other three targets as smoke-tested only [yes].
  - **O-4** the GA claim is "self-hosted, single trusted team" [yes].
  - **LIC-01** provider terms in `docs/provider-licensing.md` are acceptable for this use [yes].
  - **PR-I questions:** Cancel/Stop follows `approvers` [no]; `allowSelfApproval` defaults to false in `approval-required` [no]; approval cards are ephemeral [no, public].
  - **Pull requests:** `pullRequests.mode` default for new profiles, `auto` or `button` [auto].
  - **Cleanup:** `closeIdleAfterHours` default [168, 7 days].
  - **Tag:** approve `v0.1.0` on the U1c merge commit.
- **Fallback:** a row that failed stays `FAIL`. A fix PR and `rc.N+1` re-run only the failed steps, and the new evidence cites the new build.
