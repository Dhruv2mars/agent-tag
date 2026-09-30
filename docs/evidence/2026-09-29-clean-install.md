# Clean committed-tree install, 2026-09-29

Actor type: `automated-real`. System under test: Agent Tag commit `a37c85be9574c994e871d70a579a314ca06001d7`, macOS 26.6 arm64, Bun `1.3.13`, and pinned T3 Code `0.0.42` metadata.

`bun run verify:clean-install` first required the source checkout to be clean. It exported only `HEAD` through `git archive` into a new private temporary directory, then ran `bun install --frozen-lockfile`, the complete typecheck and test gate, and the remote T3 release-pin verification from that archive. The command returned `result: "pass"` and removed the temporary checkout.

This proves the committed tree has all files needed for a fresh locked dependency install and local verification. It does not prove a new physical or virtual host, an empty Bun cache, live Slack/T3 configuration from scratch, release-to-release migration, or Linux operation. OPS-01 remains pending.
