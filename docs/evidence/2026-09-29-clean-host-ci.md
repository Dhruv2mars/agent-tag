# Clean-host macOS and Linux CI, 2026-09-29

Actor type: `automated-real` on GitHub-hosted runners. System under test: Agent Tag commit `6980c25b00badfbaf756f39e2e2fa663b4876c6e`, Bun `1.3.13`, provider: none (install and compatibility gate only).

GitHub Actions run [36589124985](https://github.com/Dhruv2mars/agent-tag/actions/runs/36589124985) completed successfully on the exact runner labels `macos-15` and `ubuntu-24.04`. Each clean job checked out the committed source, installed Bun `1.3.13`, ran `bun install --frozen-lockfile`, ran the complete typecheck and test gate, and verified the pinned T3 `0.0.42` release metadata. The Ubuntu job completed in 13 seconds and the macOS job in 16 seconds.

The workflow grants only `contents: read`, pins `actions/checkout` v6.0.2 and `oven-sh/setup-bun` v2.2.0 by full commit SHA, disables the Bun action cache, sets a 15-minute timeout, and runs one same-repository push matrix while retaining pull-request coverage for forks.

Combined with the live macOS LaunchAgent lifecycle, historical schema matrix, backup/restore test, setup diagnostics, and log-redaction fixtures, this satisfies OPS-01. The CI run does not start live Slack or T3 services, validate provider authentication, test a Linux service manager, or prove machine-sleep behavior.
