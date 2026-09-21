# Secret-scan evidence, 2026-09-21

Actor type: `automated-fixture`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Platform: macOS `26.6.2`, arm64
- Runtime: Bun `1.3.13`
- Scanner: `scripts/scan-secrets.ts` and `src/security/secret-scan.ts`

## Checks run

The fixture put an exact secret canary across a 64 KiB read boundary and a structurally valid Slack token in a binary file. The scanner reported the path and finding class for both without returning either matched value. It excluded the configured source secret file, accepted a clean tree, and failed closed when findings or skipped symbolic links remained.

The repository scan command was:

```sh
bun run scan:secrets -- /Users/dhruv2mars/dev/github/agent-tag
```

It scanned 64 files and 441,670 bytes, skipped no symbolic links, and found no exact or known-pattern credentials. The scanner omits `.git` and `node_modules`; it scans ignored files such as `.env`, build output, SQLite files, prompts, and artifacts when those files are under a requested root.

This proves the canary and known-pattern scanner behavior and records one clean repository run. It does not prove that the unavailable Slack credentials never leaked, and it does not replace a configured scan of the live data directory and authorized repositories after the Slack app exists.
