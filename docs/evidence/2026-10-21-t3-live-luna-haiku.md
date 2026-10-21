# Live T3 suites on Luna and Haiku 5.5, 2026-10-21

Actor type: `automated-real`. This is not independent human acceptance.

## System under test

- Agent Tag branch `feat/t1-t3-v0.1.1` (lane T1), on top of `main` at `ee5a893`. The live suite now defaults to `codex` / `gpt-6-luna` and `claudeAgent` / `claude-haiku-5-5`, and each can be overridden with `AGENT_TAG_LIVE_{CODEX,CLAUDE}_{INSTANCE,MODEL}`.
- T3 Code `0.0.45`, from the pinned artifact `t3-0.0.45-darwin-arm64.tar.gz` (sha256 `330a2431619b9b225a3d4f4e555bb165bbf83d57b72d6106e75cd2aabc70c8d6`). It ran as a private loopback server with its own base directory.
- For the protocol gate only: T3 Code `v0.1.1` (`t3-0.1.1-darwin-arm64`), which speaks orchestration protocol 2.
- macOS `26.6.2` arm64, Bun `1.3.13`, Claude Code CLI `2.1.306`.
- The live service and its managed T3 were not touched. No token value, private message or raw T3 log was captured.

## Model availability on T3 0.0.45

T3 0.0.45 builds its model list from a model manifest. At startup it fetches the manifest from GitHub and caches it in `userdata/model-manifest.json`, but its provider catalog uses the copy it loaded at start.

- **Fresh base directory:** `claude-haiku-5-5` was missing from the catalog on first boot. The new manifest was fetched and cached during that boot.
- **Restart:** after one restart the catalog listed `claudeAgent` / `claude-haiku-5-5` (manifest adapter `claudeCode` `minVersion` `2.1.293`). It also listed `codex` / `gpt-6-luna`.
- **No restart:** in a second fresh base directory, the cached manifest contained `claude-haiku-5-5` from boot onward. The catalog still lacked it at boot, 3 minutes and 12.5 minutes after boot.

`agent-tag doctor` now points a `model-missing` result at this behavior and the restart remedy (`docs/t3-runtime.md`, "Models and providers"; `docs/operations.md` when this ran).

The `codex` instance on this machine hit its usage limit. Luna ran on the machine's second Codex instance (`codex_0155bb4f-…`, a separate account) through `AGENT_TAG_LIVE_CODEX_INSTANCE`. Both instances use the `codex` driver, the same model, and the same T3 adapter.

## Live T3 suite

```sh
RUN_T3_INTEGRATION=1 AGENT_TAG_T3_URL=http://127.0.0.1:<port> AGENT_TAG_T3_TOKEN_FILE=<restricted token file> \
  AGENT_TAG_LIVE_CODEX_INSTANCE=codex_0155bb4f-8692-4292-b6b9-b2a0c6fd5dc2 \
  bun test test/t3-live.integration.test.ts --timeout 600000
```

The token was minted by `scripts/enroll-t3.ts` with scopes `orchestration:read orchestration:operate`.

### Result: 13 pass, 0 fail (88 assertions, 67.1 s)

| Case | Model | Result | Matrix rows |
| --- | --- | --- | --- |
| probes the release and projects authenticated provider capabilities | both listed | pass | T3-01 |
| round trips pending image and file attachments with restricted scopes | — | pass | SLK-05 |
| returns the same receipt sequence for a replayed command id | — | pass | T3-02 |
| runs a supervised Codex turn and reconciles the completed snapshot | Luna | pass | T3-02, T3-04 |
| `thread.session.stop` stops a started thread's provider session… (PR-H2) | Luna | pass | SLK-07 |
| runs an explicit Claude turn and keeps the selected provider and model sticky | Haiku 5.5 | pass | T3-04 |
| accepts a supervised Codex command approval and completes the turn | Luna | pass | SLK-04 |
| reconciles one durable operation through T3 after a store and worker restart | Luna | pass | T3-02 |
| rejects a supervised command and interrupts a waiting turn | Luna | pass | SLK-04 |
| agent files: a real thread worktree reads back exactly… (PR-L2 Done 8) | Luna | pass | SLK-05 |
| lifecycle cleanup: tasks close + tasks cleanup --once… (PR-N Done 5) | Luna | pass | LIFE-01 |
| moves a started thread to another model of the same driver in place… | Haiku 4.5 → Haiku 5.5 | pass | MOD-01, T3-04 |
| refuses a turn that moves a started thread to another driver… | Haiku 4.5 → Luna | pass | MOD-01, T3-04 |

`docs/evidence/2026-10-21-t3-live-main.md` records two failures on `main`: the durable restart case (T3-02) and the reject/interrupt case (SLK-04). Both were Codex `gpt-5.6-sol` turns that ran past the fixtures' 60 s budgets. On Luna both pass unchanged, so the suite is green with no change to the fixtures.

The cross-driver case expects T3 to refuse with `Thread '…' is bound to driver 'claudeAgent' and cannot switch to 'codex'`, and it did.

## Managed T3 suite and the protocol gate against a real T3 (T3-05)

```sh
AGENT_TAG_LIVE_T3_PROTOCOL2_BINARY=<path to t3-0.1.1/t3> RUN_T3_MANAGED=1 bun test test/t3-managed.live.test.ts --timeout 600000
```

### Result: 10 pass, 0 fail (186.8 s)

- **Done 3:**
  - Agent Tag downloaded the pinned release into an empty runtime dir and verified the archive sha256 against the pin.
  - `t3 serve` started on loopback, and the descriptor reported `0.0.45`, protocol `1`.
  - Agent Tag minted a `0600` restricted token through an admin session, then revoked that session.
- **Done 4:** `t3 status` printed the runtime details and no secret.
- **Done 5:** rotation swapped the token, and the replaced client was revoked after the grace period.
- **Done 6:**
  - `kill -9` of T3: it was ready again as a new pid after 3,784 ms.
  - `kill -9` of the Agent Tag process: the orphaned T3 was reaped.
- **Done 7 (fake T3, unchanged):** the gate closed 59,974 ms after the switch to protocol 2. It reopened 9,046 ms after the switch back.
- **Done 7 (real T3, new):**
  1. The managed pinned 0.0.45 opened the gate, and the coordinator ran.
  2. The test stopped it and started a real `v0.1.1` `t3 serve` on the same managed port.
  3. 57,083 ms after `v0.1.1` began serving, the gate logged `t3.gate.closed` with detail "T3 server speaks orchestration protocol 2; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)".
  4. While the gate was closed, the coordinator made no calls and the outbox kept running.
  5. The test stopped `v0.1.1` and restarted the pinned 0.0.45 on the same home. 7,813 ms later the gate logged `t3.gate.opened`, and the coordinator resumed.
  6. Gate events in order: `opened`, `closed` (protocol 2), `opened`.
- **Done 8:** no token or pairing credential appeared in any log or captured output.

## Not covered here

- **T3-03 (T3 server restart with continuation):** not part of either suite, and not re-run.
- **SLK-04, human half:** the Slack interaction transcript is still owed by an owner session.
- **Linux:** not run.
