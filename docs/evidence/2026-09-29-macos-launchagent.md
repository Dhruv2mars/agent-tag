# macOS LaunchAgent lifecycle, 2026-09-29

Actor type: `automated-real`. System under test: Agent Tag commit `4cb6343` on branch `feat/t3-slack-spike`, macOS 26.6 arm64, Bun `1.3.13`, pinned T3 Code `0.0.42`, Codex `gpt-5.6-sol`, and the private Slack test workspace.

The first live prototype treated a registered launchd job as healthy and directed stdout and stderr into a protected Documents path. launchd kept the job registered but returned `EX_CONFIG`, with no service log. The final implementation places service logs under `~/Library/Logs/AgentTag`, distinguishes loaded from running state, waits for running state, and rolls back a failed install. This initial failure is not counted as a passing install.

With the corrected implementation, `service:install` ran the live `doctor`, wrote the per-user plist, bootstrapped the GUI launchd domain, and returned `installed: true`, `loaded: true`, and `running: true`. `launchctl print` independently reported `state = running`, a process ID, and no prior exit. The service log recorded `service.started` at `2026-09-29T15:04:56.951Z`. The plist and both log files were mode `0600`; the log directory was `0700`.

The first loaded-service upgrade exposed a launchd teardown race: immediate bootstrap after `bootout` returned an input/output error. The prior plist was restored and the service was visibly stopped. The manager now waits for the job to leave the domain before bootstrapping. A subsequent upgrade from the stopped state passed, followed by a second upgrade while the service was running. The service log showed a graceful stop at `2026-09-29T15:05:59.518Z` and restart at `2026-09-29T15:06:06.991Z`.

`service:uninstall` then stopped the live job, removed only the generated plist, and reported all three states false. The SQLite data and logs remained. A final `service:install` returned all three states true and logged `service.started` at `2026-09-29T15:06:25.268Z`, leaving Agent Tag running under launchd. The existing deferred operation and unanswered approval remained untouched throughout the lifecycle.

The full gate passed 58 tests with one opt-in live T3 test skipped. The configured secret scan included the checkout, live data, generated plist, and LaunchAgent logs: 87 files, no findings or skipped symlinks.

This proves the tested per-user macOS lifecycle. It does not prove a clean-host release install, launchd behavior while logged out or asleep, release-to-release data migration, or Linux service management. OPS-01 and OPS-02 remain pending.
