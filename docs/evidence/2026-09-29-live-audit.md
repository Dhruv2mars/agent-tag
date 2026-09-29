# Live audit contract verification, 2026-09-29

Actor type: `automated-real`. System under test: Agent Tag commit `07fc472` on branch `feat/t3-slack-spike`, macOS 26.6 arm64, Bun `1.3.13`, pinned T3 Code `0.0.42`, Codex `gpt-5.6-sol`, and the private Slack test workspace.

Audit writes now accept only the 33 checked-in action names and validate every actor type, actor ID, authority, source, target, result, correlation ID, metadata value, and timestamp before insertion. Audit reads apply the same closed action contract in addition to the existing non-empty field and timestamp schemas.

`bun run audit:verify -- CONFIG` paginated through all 4,475 rows in the live SQLite store and required the exported count to equal the store diagnostic. It found 14 action types exercised in that acceptance store. The verifier compared the complete in-memory serialization with every stored Slack message, memory value, and schedule prompt of at least eight characters; it found zero exact private-content matches. It printed only the record total and aggregate action counts, not identifiers or stored content.

The full local gate passed 59 tests with one opt-in live T3 test skipped. The configured secret scan included the checkout, live data, LaunchAgent plist, and logs: 93 files, no findings or skipped symlinks.

This proves the current audit field contract, pagination, durable count, and private-content check for exercised features. It does not create audit transitions for features that are not implemented, and it does not prove semantic correctness of every actor or authority assignment. AUD-01 remains pending.
