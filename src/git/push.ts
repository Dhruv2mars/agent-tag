// Push step of the draft PR workflow (PR-M §3.6). Pushes one SHA from Agent Tag's bare mirror to a remote
// URL built from config (never read from any git config), without force.
//
// The token reaches git only through the environment of this single child: GIT_ASKPASS points at a fixed
// script that prints `x-access-token` for the username and `$AGENT_TAG_GIT_TOKEN` for the password. The
// token is never in argv, a remote URL, a git config file, a credential helper or a log line, and the push
// runs from the mirror, so no repository-controlled hook, filter or fsmonitor runs while it is present.
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { GIT_BRANCH_NAME_PATTERN, GITHUB_REPOSITORY_PATTERN } from "../config.ts";
import type { SecretString } from "../security/secret-file.ts";
import { GitError, redactGitText, type GitRunner } from "./runner.ts";

export const ASKPASS_TOKEN_ENV = "AGENT_TAG_GIT_TOKEN";
export const ASKPASS_SCRIPT = `#!/bin/sh
# Written by Agent Tag. Answers git's credential prompts for one push; holds no secret itself.
case "$1" in
  Username*) echo x-access-token ;;
  *) printf '%s\\n' "$${ASKPASS_TOKEN_ENV}" ;;
esac
`;

const PUSH_TIMEOUT_MS = 120_000;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Keys a mirror's config may hold. Anything else (url.*.insteadOf, credential.*, include.*, core.sshCommand,
 * http.*) was not written by Agent Tag, so the push is refused rather than trusting it.
 */
const MIRROR_CONFIG_ALLOWED = /^(?:core\.(?:repositoryformatversion|filemode|bare|ignorecase|precomposeunicode|logallrefupdates|symlinks)|extensions\.objectformat|init\.defaultbranch)$/;

/** `<dataDir>/git/askpass.sh`. Rewritten (atomically, mode 0700) unless it already has exactly this content. */
export async function ensureAskpassScript(gitRoot: string): Promise<string> {
  const path = join(gitRoot, "askpass.sh");
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  await chmod(gitRoot, 0o700);
  try {
    const metadata = await lstat(path);
    if (
      metadata.isFile() &&
      (metadata.mode & 0o777) === 0o700 &&
      metadata.uid === (process.getuid?.() ?? metadata.uid) &&
      (await readFile(path, "utf8")) === ASKPASS_SCRIPT
    ) {
      return path;
    }
  } catch {
    // Missing: written below.
  }
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o700);
  try {
    await handle.writeFile(ASKPASS_SCRIPT, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o700);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Only https remotes are accepted. `allowTestRemote` (tests only, never set from config) also permits
 * `file://` and loopback `http://`, so tests can push to a local bare repo or a fake smart-HTTP server.
 * Userinfo, a query or a fragment are always refused.
 */
function assertRemote(url: URL, allowTestRemote: boolean | undefined, label: string): void {
  const testRemote = url.protocol === "file:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!(url.protocol === "https:" || (allowTestRemote === true && testRemote))) {
    throw new PushError("push.invalid-input", `${label} must use https`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new PushError("push.invalid-input", `${label} must not contain credentials, a query or a fragment`);
  }
}

/** `{webBaseUrl}/{owner}/{name}.git`, built from config and never read from any git config. */
export function githubRemoteUrl(webBaseUrl: string, repo: string, options: { readonly allowTestRemote?: boolean } = {}): string {
  if (!GITHUB_REPOSITORY_PATTERN.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new PushError("push.invalid-input", "repo must be owner/name");
  }
  const base = new URL(webBaseUrl);
  assertRemote(base, options.allowTestRemote, "remote base URL");
  return `${base.href.replace(/\/+$/, "")}/${repo}.git`;
}

export type PushErrorCode =
  | "push.invalid-input"
  | "push.mirror-config"
  | "push.missing-commit"
  | "push.auth"
  | "push.not-found"
  | "push.network"
  | "push.timeout"
  | "push.failed";

export class PushError extends Error {
  readonly code: PushErrorCode;
  /** True when retrying later can succeed (network, timeout, server errors). */
  readonly retryable: boolean;

  constructor(code: PushErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PushError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type PushResult =
  | {
      readonly kind: "pushed";
      /** `created`: new remote branch; `updated`: fast-forward; `up-to-date`: remote already had the SHA. */
      readonly status: "created" | "updated" | "up-to-date";
      readonly remoteRef: string;
    }
  | {
      readonly kind: "rejected";
      readonly code: "push.rejected";
      /** Git's summary, for example `fetch first` or `non-fast-forward`. Redacted. */
      readonly reason: string;
      readonly remoteRef: string;
    };

export interface PushInput {
  readonly runner: GitRunner;
  readonly mirrorPath: string;
  readonly remoteUrl: string;
  readonly sha: string;
  readonly headBranch: string;
  readonly token: SecretString;
  /** From `ensureAskpassScript`. */
  readonly askpassPath: string;
  /** Tests only: allow a `file://` or loopback `http://` remote. */
  readonly allowTestRemote?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Parses the ref line of `git push --porcelain`: `<flag>\t<from>:<to>\t<summary>`. */
export function parsePushPorcelain(stdout: string, remoteRef: string): { readonly flag: string; readonly summary: string } | undefined {
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const [flag = "", refs = "", summary = ""] = fields;
    if (refs.endsWith(`:${remoteRef}`)) return { flag, summary: summary.trim() };
  }
  return undefined;
}

function classifyPushFailure(stderr: string): { readonly code: PushErrorCode; readonly retryable: boolean } {
  const text = stderr.toLowerCase();
  if (
    text.includes("authentication failed") ||
    text.includes("invalid username or password") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("permission to") ||
    text.includes("the requested url returned error: 401") ||
    text.includes("the requested url returned error: 403")
  ) {
    return { code: "push.auth", retryable: false };
  }
  if (text.includes("repository not found") || text.includes("the requested url returned error: 404")) {
    return { code: "push.not-found", retryable: false };
  }
  if (
    text.includes("could not resolve host") ||
    text.includes("failed to connect") ||
    text.includes("connection timed out") ||
    text.includes("connection reset") ||
    text.includes("the remote end hung up") ||
    text.includes("rpc failed") ||
    /the requested url returned error: (?:429|5\d\d)/.test(text)
  ) {
    return { code: "push.network", retryable: true };
  }
  return { code: "push.failed", retryable: false };
}

async function assertMirrorConfig(input: PushInput): Promise<void> {
  const listed = await input.runner.run({
    args: ["config", "--file", join(input.mirrorPath, "config"), "--list", "--name-only"],
  });
  if (listed.exitCode !== 0) throw new PushError("push.mirror-config", "could not read the mirror's config");
  const unexpected = listed.stdout
    .split("\n")
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0 && !MIRROR_CONFIG_ALLOWED.test(key));
  if (unexpected.length > 0) {
    throw new PushError(
      "push.mirror-config",
      `refusing to push: the mirror's config has keys Agent Tag did not write (${unexpected.slice(0, 5).join(", ")})`,
    );
  }
  const head = await input.runner.run({ args: ["rev-parse", "--is-bare-repository"], cwd: input.mirrorPath });
  if (head.exitCode !== 0 || head.stdout.trim() !== "true") {
    throw new PushError("push.mirror-config", "refusing to push: the mirror is not a bare repository");
  }
}

/** Pushes `sha` to `refs/heads/<headBranch>` on `remoteUrl`. Never forces; a rejection is a result, not an error. */
export async function pushToRemote(input: PushInput): Promise<PushResult> {
  if (!SHA_PATTERN.test(input.sha)) throw new PushError("push.invalid-input", "sha must be a full commit id");
  if (!GIT_BRANCH_NAME_PATTERN.test(input.headBranch)) throw new PushError("push.invalid-input", "head branch is not a valid branch name");
  const remote = new URL(input.remoteUrl);
  assertRemote(remote, input.allowTestRemote, "remote URL");
  const fileRemote = remote.protocol === "file:";
  const token = input.token.exposeToBoundary();
  if (!/^[\x21-\x7e]+$/.test(token)) throw new PushError("push.invalid-input", "token has unexpected characters");
  if (!isAbsolute(input.askpassPath)) {
    throw new PushError("push.invalid-input", "askpass path must be absolute");
  }

  await assertMirrorConfig(input);
  const present = await input.runner.run({
    cwd: input.mirrorPath,
    args: ["cat-file", "-e", `${input.sha}^{commit}`],
  });
  if (present.exitCode !== 0) throw new PushError("push.missing-commit", "the commit is not in the mirror");

  const remoteRef = `refs/heads/${input.headBranch}`;
  const secrets = [input.token];
  let result;
  try {
    result = await input.runner.run({
      cwd: input.mirrorPath,
      args: [
        // Empty the helper list: no keychain, `gh` or store helper is asked or written to.
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        ...(fileRemote ? ["-c", "protocol.file.allow=always"] : []),
        "push",
        "--no-verify",
        "--porcelain",
        "--no-follow-tags",
        "--no-signed",
        "--end-of-options",
        input.remoteUrl,
        `${input.sha}:${remoteRef}`,
      ],
      env: {
        GIT_ASKPASS: input.askpassPath,
        SSH_ASKPASS: input.askpassPath,
        [ASKPASS_TOKEN_ENV]: token,
      },
      secrets,
      timeoutMs: input.timeoutMs ?? PUSH_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof GitError && error.code === "git.timeout") {
      throw new PushError("push.timeout", redactGitText(error.message, secrets), true);
    }
    if (error instanceof GitError) throw new PushError("push.failed", redactGitText(error.message, secrets));
    throw error;
  }

  const ref = parsePushPorcelain(result.stdout, remoteRef);
  if (ref !== undefined) {
    if (ref.flag === "!") return { kind: "rejected", code: "push.rejected", reason: redactGitText(ref.summary, secrets), remoteRef };
    if (result.exitCode === 0) {
      if (ref.flag === "*") return { kind: "pushed", status: "created", remoteRef };
      if (ref.flag === "=") return { kind: "pushed", status: "up-to-date", remoteRef };
      if (ref.flag === " ") return { kind: "pushed", status: "updated", remoteRef };
    }
  }
  const stderr = redactGitText(result.stderr, secrets).trim().slice(0, 1_000);
  const { code, retryable } = classifyPushFailure(stderr);
  throw new PushError(code, `git push failed with exit code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`, retryable);
}
