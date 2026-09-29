# Live runtime secret scan, 2026-09-29

Actor type: `automated-real`. System under test: Agent Tag branch `feat/t3-slack-spike` at commit `5b3b6ba`, macOS arm64, Bun `1.3.13`, pinned T3 Code `0.0.42`, Codex `gpt-5.6-sol`.

The scanner read the configured Agent Tag data directory and repository plus T3's private userdata, worktrees, caches, and server log. It excluded the three configured token source files, compared their exact values as canaries, and checked known Slack, GitHub, AWS, Anthropic, and OpenAI token patterns. It scanned 456 files (118,307,462 bytes), with no findings or skipped symlinks.

A separate exact-canary scan used the T3 server bearer token from its owner-only source file against the same roots. It scanned 456 files (118,313,059 bytes), with no findings or skipped symlinks. Neither scan printed token values. The source token files themselves were deliberately outside the scanned roots or excluded; this is a leakage check, not a claim that no credential is stored securely.

This covers the live files present during the run, not all future files, unknown credential formats, arbitrary private message content, browser screenshots, or every asset-path authorization boundary. SEC-01 remains pending.
