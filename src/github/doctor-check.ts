// Doctor checks for the draft PR workflow (PR-M §3.8): git is new enough, and the GitHub credential is
// accepted with push access to every configured repository. Runs only when `github` is configured.
import type { AgentTagConfig } from "../config.ts";
import type { SecretString } from "../security/secret-file.ts";
import { createGitHubClient, type FetchLike, GitHubApiError } from "./client.ts";

/** `protocol.file.allow` semantics the mirror fetch relies on (PR-M §3.2; minimum is UNCONFIRMED). */
export const MIN_GIT_VERSION = "2.38.0";

interface DoctorCheckResult {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail" | "skip";
  readonly summary: string;
  readonly hint?: string;
}

/** Configured PR repositories across profiles with a non-off mode, deduplicated. */
export function pullRequestRepositories(config: AgentTagConfig): readonly string[] {
  const repos = config.profiles.flatMap((profile) =>
    profile.pullRequests.mode === "off" ? [] : profile.pullRequests.repositories.map((repository) => repository.repo),
  );
  return [...new Set(repos)];
}

function parseVersion(text: string): readonly number[] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function checkGitVersion(versionOutput: string | undefined): DoctorCheckResult {
  const id = "git-version";
  if (versionOutput === undefined) {
    return { id, status: "fail", summary: "git is not installed or not on PATH", hint: `install git ${MIN_GIT_VERSION} or newer` };
  }
  const version = parseVersion(versionOutput);
  if (version === undefined) return { id, status: "warn", summary: `could not parse \`${versionOutput.trim().slice(0, 80)}\`` };
  const minimum = MIN_GIT_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (version[index] ?? 0) - (minimum[index] ?? 0);
    if (difference > 0) break;
    if (difference < 0) {
      return { id, status: "fail", summary: `git ${version.join(".")} is older than ${MIN_GIT_VERSION}`, hint: "upgrade git" };
    }
  }
  return { id, status: "pass", summary: `git ${version.join(".")}` };
}

/** One check per configured repository: the token is accepted and can push (`unknown` for fine-grained PATs). */
export async function checkGitHubAccess(input: {
  readonly config: AgentTagConfig;
  readonly token: SecretString;
  readonly fetch: FetchLike;
}): Promise<readonly DoctorCheckResult[]> {
  const github = input.config.github;
  if (github === undefined) return [];
  const client = createGitHubClient({
    apiBaseUrl: github.apiBaseUrl,
    credentials: { token: async () => input.token, describe: () => `token file ${github.auth.tokenFile}` },
    fetch: input.fetch,
  });
  const repos = pullRequestRepositories(input.config);
  if (repos.length === 0) {
    return [{ id: "github-access", status: "skip", summary: "no profile has pull requests enabled" }];
  }
  const results: DoctorCheckResult[] = [];
  for (const repo of repos) {
    const id = `github-access:${repo}`;
    try {
      const access = await client.checkPushAccess(repo);
      results.push(
        access === "yes"
          ? { id, status: "pass", summary: `token can push to ${repo}` }
          : access === "unknown"
            ? { id, status: "pass", summary: `token can read ${repo}; push access is verified on the first push`, hint: "fine-grained tokens do not report permissions" }
            : { id, status: "fail", summary: `token cannot push to ${repo}`, hint: "grant the token Contents and Pull requests read/write on this repository" },
      );
    } catch (error) {
      const kind = error instanceof GitHubApiError ? error.kind : "unexpected";
      const hint =
        kind === "auth"
          ? "the token was rejected; replace it in `github.auth.tokenFile`"
          : kind === "not-found"
            ? "the repository does not exist or is not granted to the token"
            : undefined;
      results.push({
        id,
        status: "fail",
        summary: `GitHub check for ${repo} failed (${error instanceof GitHubApiError ? error.code : "error"})`,
        ...(hint === undefined ? {} : { hint }),
      });
    }
  }
  return results;
}

export async function defaultGitVersion(): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
