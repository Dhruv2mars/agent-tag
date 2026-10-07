#!/bin/sh
# Agent Tag installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Dhruv2mars/agent-tag/main/install.sh | sh
#
# Environment:
#   AGENT_TAG_VERSION           Release to install, e.g. 0.2.0 or v0.2.0 (default: latest)
#   AGENT_TAG_INSTALL_DIR       Destination directory (default: $HOME/.local/bin)
#   AGENT_TAG_RELEASE_BASE_URL  Release mirror laid out like GitHub Releases
#                               (default: https://github.com/Dhruv2mars/agent-tag/releases)
#
# The installer downloads one prebuilt binary plus SHA256SUMS, refuses to install
# when the checksum does not match, and replaces the destination atomically.

set -eu

REPOSITORY="Dhruv2mars/agent-tag"

say() {
  printf 'agent-tag: %s\n' "$*"
}

fail() {
  printf 'agent-tag: error: %s\n' "$*" >&2
  exit 1
}

detect_os() {
  os_name=$(uname -s)
  case "$os_name" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) fail "Windows is not supported natively; run this installer inside WSL2" ;;
    *) fail "unsupported operating system: $os_name" ;;
  esac
}

detect_arch() {
  machine=$(uname -m)
  case "$machine" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "unsupported CPU architecture: $machine" ;;
  esac
  # An x64 shell under Rosetta 2 still runs on Apple silicon; prefer the native build.
  if [ "$1" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
      arch="arm64"
    fi
  fi
  printf '%s' "$arch"
}

fail_musl() {
  fail "musl-based Linux (for example Alpine) is not supported by the release binaries; use the Docker image instead"
}

glibc_loader_present() {
  for loader in /lib*/ld-linux-*.so.*; do
    if [ -e "$loader" ]; then return 0; fi
  done
  return 1
}

# Refuses only when the C library actually in use is musl. A musl loader that merely
# exists on disk (Debian/Ubuntu's `musl` package installs /lib/ld-musl-*) does not make
# a glibc host musl-based.
check_libc() {
  [ "$1" = "linux" ] || return 0
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    return 0
  fi
  if command -v ldd >/dev/null 2>&1; then
    case "$(ldd --version 2>&1 || true)" in
      *musl*) fail_musl ;;
      *GLIBC* | *glibc* | *"GNU libc"*) return 0 ;;
    esac
  fi
  # Neither tool answered: fall back to the loaders, and refuse only without a glibc one.
  for loader in /lib/ld-musl-*; do
    if [ -e "$loader" ] && ! glibc_loader_present; then fail_musl; fi
  done
}

normalize_version() {
  version="$1"
  case "$version" in
    v*) version="${version#v}" ;;
  esac
  if ! printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
    fail "invalid AGENT_TAG_VERSION: $1"
  fi
  printf 'v%s' "$version"
}

# download URL OUTPUT [HINT]: HINT is appended to the error when the download fails.
download() {
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL --retry 3 --output "$2" "$1"; then return 0; fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O "$2" "$1"; then return 0; fi
  else
    fail "curl or wget is required"
  fi
  fail "download failed: $1${3:-}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else
    fail "sha256sum, shasum, or openssl is required to verify the download"
  fi
}

main() {
  base_url="${AGENT_TAG_RELEASE_BASE_URL:-https://github.com/$REPOSITORY/releases}"
  base_url="${base_url%/}"
  install_dir="${AGENT_TAG_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"
  requested="${AGENT_TAG_VERSION:-latest}"

  os=$(detect_os)
  arch=$(detect_arch "$os")
  check_libc "$os"
  asset="agent-tag-$os-$arch"

  if [ "$requested" = "latest" ]; then
    release_path="latest/download"
    label="latest release"
    # GitHub's latest/download skips prereleases, so it 404s until a stable release exists.
    hint="
agent-tag: if no stable release is published yet, pin a prerelease from $base_url, for example:
  curl -fsSL https://raw.githubusercontent.com/$REPOSITORY/main/install.sh | AGENT_TAG_VERSION=0.1.0-rc.1 sh"
  else
    tag=$(normalize_version "$requested")
    release_path="download/$tag"
    label="$tag"
    hint=""
  fi

  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t agent-tag)
  trap 'rm -rf "$tmp_dir"' EXIT
  trap 'exit 130' INT TERM

  say "downloading $asset ($label)"
  download "$base_url/$release_path/$asset" "$tmp_dir/$asset" "$hint"
  download "$base_url/$release_path/SHA256SUMS" "$tmp_dir/SHA256SUMS" "$hint"

  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp_dir/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
  actual=$(sha256_of "$tmp_dir/$asset")
  if [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"
  fi
  say "verified sha256 $actual"

  mkdir -p "$install_dir" || fail "cannot create $install_dir"
  staged="$install_dir/.agent-tag-install-$$"
  cp "$tmp_dir/$asset" "$staged" || fail "cannot write to $install_dir"
  chmod 755 "$staged"
  if ! "$staged" version >/dev/null 2>&1; then
    rm -f "$staged"
    fail "the downloaded binary does not run on this machine"
  fi
  mv -f "$staged" "$install_dir/agent-tag"

  say "installed $("$install_dir/agent-tag" version) to $install_dir/agent-tag"
  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *)
      say "$install_dir is not on your PATH; add it with:"
      # shellcheck disable=SC2016 # print a literal $PATH for the user to paste
      printf '\n  export PATH="%s:$PATH"\n\n' "$install_dir"
      ;;
  esac
  say "next step: run the setup wizard: agent-tag onboard"
  say "it walks through the Slack app (https://github.com/$REPOSITORY/blob/main/docs/slack-setup.md), T3, the config, and the service;"
  say "check them anytime with: agent-tag doctor"
}

main "$@"
