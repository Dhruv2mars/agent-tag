# Docs drift checks, 2026-10-21

Actor type: `automated-fixture`. The checks read the repository's own files and run no Slack, T3 or provider. DOC-01 is one of the two rows a fixture may pass.

## What is checked

`test/docs-drift.test.ts` runs the checks in `scripts/docs-drift.ts` and `scripts/gen-config-docs.ts` against the repository, and runs each check again against a broken fixture to show it fails:

| PR-U Done | Check | Broken fixture that fails it |
| --- | --- | --- |
| D2 | `docs/configuration.md` is byte-equal to `bun run docs:config --stdout`, generated from `agentTagConfigSchema`. Every leaf key appears exactly once as a table row, and there are at least 127 keys. | Deleting one row from `docs/configuration.md` failed both tests (checked by hand on this branch, then restored). |
| D3 | Every command in `agent-tag help` (`HELP_TEXT`) is written as `` `agent-tag <word>` `` in a doc; every `agent-tag <word>` in a fenced block is a real command; every `bun run <name>` is a `package.json` script. | A stale and an undocumented command; an unknown script. |
| D3 | Every implemented `!command` appears in `docs/slack-usage.md`. | An undocumented `!command`. |
| D4 | The JSON block in `docs/slack-setup.md` deep-equals `config/slack-manifest.example.json`, and the "For the Slack admin" table lists exactly its 11 bot scopes. | A manifest mismatch; a scope missing from the table. |
| D5 | Every relative link and `#anchor` resolves in `README.md`, `SECURITY.md` and every `.md` under `docs/` (47 files, evidence included). `CHANGELOG.md` is checked once it exists. | A broken link and a broken anchor; GitHub anchor slugs with punctuation and duplicates. |

The onboard usage lines named in D3 are not checked yet: `agent-tag onboard` flags arrive with O4 (#41).

## Command and result

```sh
bun test test/docs-drift.test.ts
```

On `feat/u1-docs-ga-matrix` with Bun `1.3.13` on macOS arm64: 14 pass, 0 fail, 147 assertions. The full `bun run check` on the same tree also ran these tests.

## What this does not prove

It proves the docs name what the code has. It does not prove the prose describing behaviour is accurate. That was reviewed separately for `docs/parity.md` and `docs/troubleshooting.md` against `src/` before merge.
