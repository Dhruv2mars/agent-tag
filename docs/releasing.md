# Releasing

For maintainers. Installing a published release is in [Install](install.md).

## Cutting a release

1. Make sure `bun run check` passes on `main`.
2. For a stable (unhyphenated) version only: run `AGENT_TAG_GA_GATE=1 bun run scripts/ga-matrix.ts`. It exits 1 while any row of the [GA acceptance matrix](ga-acceptance.md) is `PENDING-*` or `FAIL`. `release.yml` does not run this gate yet.
3. Tag and push: `git tag v0.1.0-rc.1 && git push origin v0.1.0-rc.1`.
4. `.github/workflows/release.yml` then runs these jobs:
   - cross-compiles the four binaries with `scripts/build-release.ts`. The macOS binaries are built on macOS so they carry Bun's ad-hoc signature.
   - runs a smoke test of each binary on a native runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`). The test runs `--help`, `version --json`, and `install.sh` against a local `file://` mirror.
   - builds the Docker image and checks it.
   - writes `SHA256SUMS` and publishes the GitHub Release once the typecheck, tests, smoke tests, and image checks have passed. A hyphenated version is published as a prerelease.
   - pushes the verified image to GHCR only after the GitHub Release exists, so a failed gate never moves `:<version>` or `:latest`.

Only a pushed `v*` tag publishes. Pull requests that touch the build inputs and manual `workflow_dispatch` runs (including one started on a tag) run the same build, smoke, and Docker jobs as a dry run. They never create a release or push an image.

To build locally:

```sh
bun run build:release                          # all four targets into dist/, plus dist/SHA256SUMS
bun run build:release --target darwin-arm64 --version 0.1.0
```

Each binary runs `--help` and `version --json` as a smoke test when it matches the host.
