# Agent Tag

Agent Tag is a Slack coworker you host yourself. Mention it in a thread and it hands the work to a coding agent (Codex or Claude, or any provider T3 Code supports) running through [T3 Code](https://github.com/pingdotgg/t3code) on your own machine. It replies in the thread, asks before risky steps when you want it to, remembers notes, runs routines, shares files and can open draft pull requests.

It is modelled on [Claude Tag](https://claude.com/docs/claude-tag/users/getting-started), with two differences: you choose the agent and model, and it runs on your host instead of a hosted sandbox. [Parity](docs/parity.md) lists every difference.

**Status:** under active development and not yet generally available. v0.1.0 is gated on the [GA acceptance matrix](docs/ga-acceptance.md): every row must cite real evidence. It is meant for a single trusted team; read [SECURITY.md](SECURITY.md) before inviting anyone, because every allowed Slack user can make the agent run code as the host's OS user.

## Quickstart

1. **Install** a prebuilt binary (macOS arm64/x64, Linux x64/arm64). Until GA every release is a prerelease, so pin one from [the releases page](https://github.com/Dhruv2mars/agent-tag/releases):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Dhruv2mars/agent-tag/main/install.sh | AGENT_TAG_VERSION=0.1.0-rc.1 sh
   agent-tag version
   ```

   No release has been tagged yet, so this fails until the first prerelease is published; until then use a [source checkout](#development). The installer verifies `SHA256SUMS` and installs to `~/.local/bin` (`AGENT_TAG_INSTALL_DIR` changes it). Docker and updates are in [install](docs/install.md).
2. **Onboard:** `agent-tag onboard` walks through the Slack app (a create-from-manifest link), T3, the config at `~/.agent-tag/agent-tag.json`, and the background service. Every prompt also has a flag for scripted installs ([operations](docs/operations.md#onboarding)).
3. **Check:** `agent-tag doctor` reports SQLite, T3, providers, Slack scopes and the service. `--fix` repairs file modes, a missing data directory, a drifted unit and a stopped service.
4. **Run:** `agent-tag service install` (LaunchAgent on macOS, `systemd --user` on Linux), or `agent-tag run CONFIG` in the foreground.
5. **Try it:** invite the bot to a routed channel and send `@Agent Tag say hello`. You should see :eyes:, a status message and a reply with a footer naming the model. [Slack setup](docs/slack-setup.md#4-verify-and-start) lists what to check next.

## Docs

| You are | Read |
| --- | --- |
| Setting it up | [Install](docs/install.md), [Slack setup](docs/slack-setup.md) (including the scope table for your Slack admin), [T3 runtime](docs/t3-runtime.md), [operations](docs/operations.md), [configuration reference](docs/configuration.md), [audit actions](docs/audit-actions.md), [troubleshooting](docs/troubleshooting.md) |
| Using it in Slack | [Using Agent Tag in Slack](docs/slack-usage.md) |
| Reviewing its security | [SECURITY.md](SECURITY.md), [provider access and licensing](docs/provider-licensing.md) |
| Comparing it with Claude Tag | [Parity](docs/parity.md) |
| Tracking the release | [GA acceptance matrix](docs/ga-acceptance.md), [owner session](docs/owner-session.md), [evidence](docs/evidence/), [releasing](docs/releasing.md) |

Provider authentication is not a license grant. Review [provider access and licensing](docs/provider-licensing.md) before making an authenticated provider available to other Slack users.

## Development

Requirements: Bun, and T3 Code `0.0.45` (orchestration protocol 1; `0.0.42`–`0.0.45` are accepted) for live checks. Background operation needs macOS or Linux.

```sh
bun install
bun run verify:t3-pin
bun run check            # typecheck + tests (20 s per-test budget for I/O-heavy fixtures)
bun run onboard          # the wizard, from the checkout
bun run start -- /absolute/path/to/agent-tag.json
```

`bun link` puts `agent-tag` on your `PATH`. A service installed from a checkout runs `bun run src/cli.ts`; one installed from the binary runs the binary, so `agent-tag update` then `agent-tag service restart` picks up a new version. `doctor --fix` never switches a service between the two.

Verify the committed tree from a fresh archive with a frozen install:

```sh
bun run verify:clean-install
```

With a pinned T3 server and an exact-scope service token, run the live T3 suite:

```sh
AGENT_TAG_T3_URL=http://127.0.0.1:37841 \
AGENT_TAG_T3_TOKEN_FILE=/absolute/path/to/t3-token \
bun run test:t3
```

Check a deployment's security controls:

```sh
bun run security:audit -- /absolute/path/to/agent-tag.json
```

Agent Tag uses T3 as its only execution backend. It has no agent loop or provider manager of its own.
