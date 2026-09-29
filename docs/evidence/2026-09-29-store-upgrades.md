# Historical SQLite upgrade matrix, 2026-09-29

Actor type: `automated-fixture`. System under test: Agent Tag commit `d2de6ae` on branch `feat/t3-slack-spike`, macOS 26.6 arm64, Bun `1.3.13`.

The migration test first requires the checked-in version sequence to be exactly 1 through 9. For each version, it creates that historical schema, inserts representative version-1 state for a task, operation, Slack event and delivery, outbox item, and audit record, then applies migrations through the selected starting version. It closes the database and opens it with the production `AgentTagStore`, which applies every remaining migration transactionally.

Every starting version preserved the six existing records. The final database contained all nine migration receipts, the version-2 source ordering backfill, nullable interaction and resolved-text fields, version-9 channel identity defaults, and `PRAGMA quick_check = ok`.

The full local gate passed 59 tests with one opt-in live T3 test skipped. The configured secret scan included the checkout, live data, LaunchAgent plist, and logs: 91 files, no findings or skipped symlinks.

This proves the checked-in SQL upgrade path and representative data preservation. It does not replace a pre-upgrade backup, a production-sized database exercise, or a release install on a separate clean host. OPS-01 remains pending.
