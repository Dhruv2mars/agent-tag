# Install

Agent Tag ships three ways. Each one still needs a running T3 Code `0.0.42` server and the Slack app from [Slack setup](slack-setup.md).

| Method | Platforms | Updates with |
| --- | --- | --- |
| Prebuilt binary (`install.sh`) | macOS arm64/x64, Linux x64/arm64 (glibc) | `agent-tag update` |
| Docker image | Linux containers (amd64) | pull a newer image tag |
| Source checkout | anything Bun supports | `git pull && bun install --frozen-lockfile` |

## Prebuilt binary

```sh
curl -fsSL https://raw.githubusercontent.com/Dhruv2mars/agent-tag/main/install.sh | AGENT_TAG_VERSION=0.1.0-rc.1 sh
```

Until GA, pin a prerelease as above; see [the note on `latest`](#latest-and-prereleases) below.

The installer:

1. detects the OS and CPU (an x64 shell under Rosetta gets the arm64 build);
2. downloads `agent-tag-<os>-<arch>` and `SHA256SUMS` from [GitHub Releases](https://github.com/Dhruv2mars/agent-tag/releases);
3. refuses to install if the checksum is missing or wrong;
4. runs the binary once, then moves it atomically to `~/.local/bin/agent-tag`;
5. prints the next step: create the Slack app and config with [Slack setup](slack-setup.md), then run `agent-tag doctor /absolute/path/to/agent-tag.json`.

On Linux it asks the C library in use (`getconf GNU_LIBC_VERSION`, then `ldd --version`) and refuses only a musl host. A glibc host that also has Debian's `musl` package installed is fine.

To review the script before running it, download it first and run it with `sh install.sh`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_TAG_VERSION` | `latest` | Install a specific release, for example `0.2.0` or `v0.2.0`. |
| `AGENT_TAG_INSTALL_DIR` | `~/.local/bin` | Where to put the binary. |
| `AGENT_TAG_RELEASE_BASE_URL` | `https://github.com/Dhruv2mars/agent-tag/releases` | A mirror laid out like GitHub Releases (`download/<tag>/<asset>` and `latest/download/<asset>`). |

### `latest` and prereleases

`latest` resolves to GitHub's latest *stable* release and skips prereleases. Until GA, releases are tagged as prereleases (for example `v0.1.0-rc.1`), so pin one:

```sh
curl -fsSL https://raw.githubusercontent.com/Dhruv2mars/agent-tag/main/install.sh | AGENT_TAG_VERSION=0.1.0-rc.1 sh
```

Without a pin, the installer fails with `download failed` and prints the pinned command. `agent-tag update` and `agent-tag update --check` likewise report that no stable release is published yet. Move between prereleases with `agent-tag update --version 0.1.0-rc.2`. Neither the installer nor `update` discovers prereleases on its own.

Not supported: Windows outside WSL2, and musl-based Linux such as Alpine (use the Docker image). x64 binaries use Bun's baseline runtime, so CPUs without AVX2 work too.

To check a download by hand:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum -c SHA256SUMS --ignore-missing       # Linux
```

### Version and update

```sh
agent-tag version            # agent-tag 0.2.0 (darwin-arm64, binary, 0123456789ab)
agent-tag version --json
agent-tag update --check     # report whether a newer release exists; changes nothing
agent-tag update             # install the latest release
agent-tag update --version 0.1.0   # install exactly this release (downgrades allowed)
```

`update` downloads the release for this platform together with `SHA256SUMS` and checks the hash. It writes the new binary to a temporary file beside the current one, runs `version --json` on it to confirm it reports the expected version, and only then `rename`s it over the old binary. That rename is atomic. A failed download, checksum, or smoke test leaves the installed binary untouched. A process that is already running keeps the old code until you restart it.

`update` only replaces release binaries. From a source checkout it refuses and tells you to `git pull`. Inside the container image it tells you to pull a newer image. `AGENT_TAG_RELEASE_BASE_URL` applies to `update` as well, and must be an http(s) URL.

## Docker

The image runs one bundled JavaScript file on `oven/bun:<version>-slim`. It runs as the unprivileged `bun` user (uid 1000) and declares `/data` as a volume.

Tagged releases push `ghcr.io/dhruv2mars/agent-tag:<version>`. Stable releases also push `:latest`. To build the image yourself:

```sh
docker build -t agent-tag .
docker run --rm agent-tag --help
```

Agent Tag is strict about file ownership. Secret files must be mode `0600` and owned by the uid the process runs as. The data directory must not grant group or world access. The simplest setup is to run the container as your own uid and bind-mount directories that you own:

```sh
docker run -d --name agent-tag --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  --add-host host.docker.internal:host-gateway \
  -v "$HOME/agent-tag/data:/data" \
  -v "$HOME/agent-tag/secrets:/secrets:ro" \
  -v "$HOME/agent-tag/agent-tag.json:/config/agent-tag.json:ro" \
  ghcr.io/dhruv2mars/agent-tag:<version> run /config/agent-tag.json
```

Inside the container, the config refers to container paths: `"dataDir": "/data"`, token files under `/secrets/...`, and a T3 `baseUrl` the container can reach, for example `http://host.docker.internal:37841`. If T3 listens only on `127.0.0.1` on a Linux host, run the container with `--network host` instead and keep `http://127.0.0.1:37841`. The container does not run T3, and nothing in the image changes T3's own network exposure. Check `docker logs agent-tag` for the structured lifecycle records. Run `doctor` in a one-off container with the same mounts.

## Source checkout

See the [README](../README.md#development). Follow [operations](operations.md) for the macOS LaunchAgent, which currently runs from a checkout only.

## Cutting a release (maintainers)

1. Make sure `bun run check` passes on `main`.
2. Tag and push: `git tag v0.1.0-rc.1 && git push origin v0.1.0-rc.1`.
3. `.github/workflows/release.yml` then runs these jobs:
   - cross-compiles the four binaries with `scripts/build-release.ts`. The macOS binaries are built on macOS so they carry Bun's ad-hoc signature.
   - runs a smoke test of each binary on a native runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`). The test runs `--help`, `version --json`, and `install.sh` against a local `file://` mirror.
   - builds the Docker image and checks it.
   - writes `SHA256SUMS` and publishes the GitHub Release once the typecheck, tests, smoke tests, and image checks have passed. A hyphenated version is published as a prerelease.
   - pushes the verified image to GHCR only after the GitHub Release exists, so a failed gate never moves `:<version>` or `:latest`.

Pull requests that touch the build inputs run the same build, smoke, and Docker jobs as a dry run. They never publish.

To build locally:

```sh
bun run build:release                          # all four targets into dist/, plus dist/SHA256SUMS
bun run build:release --target darwin-arm64 --version 0.1.0
```

Each binary runs `--help` and `version --json` as a smoke test when it matches the host.
