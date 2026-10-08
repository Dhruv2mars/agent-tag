import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { agentTagConfigSchema } from "../src/config.ts";
import { GitHubCredentialError, githubCredentialsFromConfig, tokenFileCredentials, type GitHubCredentials } from "../src/github/auth.ts";
import {
  createGitHubClient,
  GITHUB_API_VERSION,
  GitHubApiError,
  neutralizeMentions,
  pullRequestBody,
  pullRequestTitle,
  type FetchLike,
} from "../src/github/client.ts";
import { SecretString } from "../src/security/secret-file.ts";
import { canaryToken, withTempDir } from "./fixtures/git-fixture.ts";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

function fakeGitHub(routes: Route[]): { readonly fetch: FetchLike; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const recorded: RecordedRequest = {
        url: new URL(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        redirect: init.redirect,
      };
      requests.push(recorded);
      const route = routes.shift();
      if (route === undefined) throw new Error(`unexpected request ${recorded.method} ${recorded.url}`);
      return await route(recorded);
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function pull(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    html_url: `https://github.com/octo/example/pull/${number}`,
    state: "open",
    draft: true,
    title: "Fix README typo",
    head: { ref: "agent-tag/task-1", sha: "a".repeat(40) },
    base: { ref: "main" },
    merged_at: null,
    ...overrides,
  };
}

function staticCredentials(token: string): GitHubCredentials {
  return { token: async () => new SecretString(token), describe: () => "test token" };
}

function client(token: string, routes: Route[], now = () => 1_700_000_000_000) {
  const fake = fakeGitHub(routes);
  return {
    ...fake,
    client: createGitHubClient({ apiBaseUrl: "https://api.github.example/", credentials: staticCredentials(token), fetch: fake.fetch, now }),
  };
}

async function failure(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof GitHubApiError)) throw new Error(`expected GitHubApiError, got ${String(error)}`);
  return error;
}

describe("GitHub client", () => {
  test("finds the newest PR for the head branch with the documented headers", async () => {
    const token = canaryToken();
    const { client: github, requests } = client(token, [
      () =>
        json(200, [
          pull(3, { head: { ref: "agent-tag/task-1-other", sha: "b".repeat(40) } }),
          pull(7, { state: "closed", merged_at: "2026-01-01T00:00:00Z" }),
          pull(5),
        ]),
      () => json(200, []),
    ]);
    const found = await github.findPullByHead("octo/example", "agent-tag/task-1");
    expect(found).toMatchObject({ number: 7, state: "closed", merged: true, draft: true, headRef: "agent-tag/task-1" });
    expect(await github.findPullByHead("octo/example", "agent-tag/task-1")).toBeUndefined();

    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url.origin + request.url.pathname).toBe("https://api.github.example/repos/octo/example/pulls");
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      head: "octo:agent-tag/task-1",
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: "5",
    });
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("x-github-api-version")).toBe(GITHUB_API_VERSION);
    expect(request.redirect).toBe("manual");
    expect(request.url.toString()).not.toContain(token);
  });

  test("creates a draft PR that maintainers cannot modify", async () => {
    const { client: github, requests } = client(canaryToken(), [() => json(201, pull(12))]);
    const result = await github.createDraftPull("octo/example", { title: "Fix README typo", head: "agent-tag/task-1", base: "main", body: "body" });
    expect(result).toMatchObject({ created: true, draftUnavailable: false, pull: { number: 12, draft: true } });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url.pathname).toBe("/repos/octo/example/pulls");
    expect(requests[0]!.body).toEqual({
      title: "Fix README typo",
      head: "agent-tag/task-1",
      base: "main",
      body: "body",
      draft: true,
      maintainer_can_modify: false,
    });
  });

  test("422 'already exists' reuses the existing PR (crash replay) with exactly one POST", async () => {
    const { client: github, requests } = client(canaryToken(), [
      () => json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for octo:agent-tag/task-1." }] }),
      () => json(200, [pull(12)]),
    ]);
    const result = await github.createDraftPull("octo/example", { title: "t", head: "agent-tag/task-1", base: "main", body: "b" });
    expect(result).toMatchObject({ created: false, pull: { number: 12 } });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("422 about drafts retries once as a normal [WIP] PR", async () => {
    const { client: github, requests } = client(canaryToken(), [
      () => json(422, { message: "Validation Failed", errors: [{ message: "Draft pull requests are not supported in this repository." }] }),
      () => json(201, pull(13, { draft: false, title: "[WIP] Fix" })),
    ]);
    const result = await github.createDraftPull("octo/example", { title: "Fix", head: "agent-tag/task-1", base: "main", body: "b" });
    expect(result).toMatchObject({ created: true, draftUnavailable: true, pull: { number: 13, draft: false } });
    expect(requests[1]!.body).toMatchObject({ draft: false, title: "[WIP] Fix" });
  });

  test("other 422s are validation errors and are not retried", async () => {
    const { client: github, requests } = client(canaryToken(), [
      () => json(422, { message: "Validation Failed", errors: [{ message: "No commits between main and agent-tag/task-1" }] }),
    ]);
    const error = await failure(github.createDraftPull("octo/example", { title: "t", head: "agent-tag/task-1", base: "main", body: "b" }));
    expect(error).toMatchObject({ kind: "validation", code: "github.validation", status: 422, retryable: false });
    expect(error.message).toContain("No commits between");
    expect(requests).toHaveLength(1);
  });

  test("getPull returns the card stats", async () => {
    const { client: github, requests } = client(canaryToken(), [
      () => json(200, pull(12, { merged: false, additions: 14, deletions: 3, changed_files: 2, commits: 2 })),
    ]);
    expect(await github.getPull("octo/example", 12)).toEqual({
      number: 12,
      htmlUrl: "https://github.com/octo/example/pull/12",
      state: "open",
      merged: false,
      draft: true,
      title: "Fix README typo",
      headRef: "agent-tag/task-1",
      headSha: "a".repeat(40),
      baseRef: "main",
      additions: 14,
      deletions: 3,
      changedFiles: 2,
      commits: 2,
    });
    expect(requests[0]!.url.pathname).toBe("/repos/octo/example/pulls/12");
  });

  test("classifies 401, 403, 404, rate limits and 5xx without leaking the token", async () => {
    const token = canaryToken();
    const now = 1_700_000_000_000;
    const cases: Array<{ response: () => Response; kind: string; retryAfterMs?: number }> = [
      { response: () => json(401, { message: `Bad credentials ${token}` }), kind: "auth" },
      { response: () => json(403, { message: "Resource not accessible by personal access token" }), kind: "auth" },
      { response: () => json(404, { message: "Not Found" }), kind: "not-found" },
      {
        response: () => json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1_000 + 120) }),
        kind: "rate-limited",
        retryAfterMs: 120_000,
      },
      {
        response: () => json(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "30" }),
        kind: "rate-limited",
        retryAfterMs: 30_000,
      },
      { response: () => json(429, { message: "slow down" }, { "retry-after": "5" }), kind: "rate-limited", retryAfterMs: 5_000 },
      { response: () => json(429, {}), kind: "rate-limited", retryAfterMs: 60_000 },
      { response: () => json(502, { message: "Bad Gateway" }), kind: "transient" },
      { response: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), kind: "unexpected" },
    ];
    for (const item of cases) {
      const { client: github } = client(token, [item.response], () => now);
      const error = await failure(github.getPull("octo/example", 1));
      expect(error.kind).toBe(item.kind as GitHubApiError["kind"]);
      expect(error.retryable).toBe(item.kind === "rate-limited" || item.kind === "transient");
      if (item.retryAfterMs !== undefined) expect(error.retryAfterMs).toBe(item.retryAfterMs);
      expect(error.message).not.toContain(token);
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(token);
    }
    const { client: auth } = client(token, [() => json(401, { message: "Bad credentials" })]);
    expect((await failure(auth.findPullByHead("octo/example", "agent-tag/task-1"))).message).toContain("operator must fix github.auth");
  });

  test("network errors and timeouts are transient and redacted", async () => {
    const token = canaryToken();
    const { client: github } = client(token, [
      () => {
        throw new TypeError(`connect ECONNREFUSED (Authorization: Bearer ${token})`);
      },
    ]);
    const network = await failure(github.getPull("octo/example", 1));
    expect(network.kind).toBe("transient");
    expect(network.message).not.toContain(token);

    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const slow = createGitHubClient({ apiBaseUrl: "https://api.github.example", credentials: staticCredentials(token), fetch: hanging, timeoutMs: 20 });
    const timeout = await failure(slow.getPull("octo/example", 1));
    expect(timeout.kind).toBe("transient");
    expect(timeout.message).toContain("timed out");
  });

  test("checkPushAccess reads permissions.push or reports unknown", async () => {
    const { client: github } = client(canaryToken(), [
      () => json(200, { full_name: "octo/example", permissions: { push: true } }),
      () => json(200, { full_name: "octo/example", permissions: { push: false } }),
      () => json(200, { full_name: "octo/example" }),
    ]);
    expect(await github.checkPushAccess("octo/example")).toBe("yes");
    expect(await github.checkPushAccess("octo/example")).toBe("no");
    expect(await github.checkPushAccess("octo/example")).toBe("unknown");
  });

  test("rejects unsafe repos, branches and base URLs before any request", async () => {
    const { client: github, requests } = client(canaryToken(), []);
    expect((await failure(github.getPull("../octo", 1))).kind).toBe("validation");
    expect((await failure(github.findPullByHead("octo/example", "a..b"))).kind).toBe("validation");
    expect((await failure(github.createDraftPull("octo/example", { title: "t", head: "x", base: "-main", body: "" }))).kind).toBe("validation");
    expect(requests).toHaveLength(0);
    expect(() => createGitHubClient({ apiBaseUrl: "http://api.github.com", credentials: staticCredentials("x") })).toThrow();
    expect(() => createGitHubClient({ apiBaseUrl: "https://u:p@api.github.com", credentials: staticCredentials("x") })).toThrow();
  });
});

describe("PR text helpers", () => {
  test("neutralizes @mentions in the body and links back to Slack", () => {
    const body = pullRequestBody({ summaryText: "Fixed it, cc @octo/team and @alice", requestedBy: "U123", threadLink: "https://slack.example/p1" });
    expect(body).toContain("cc @​octo/team and @​alice");
    expect(body).not.toMatch(/@[a-z]/);
    expect(body).toContain("Requested in Slack by U123 · https://slack.example/p1");
    expect(body).toEndWith("Opened by Agent Tag as a draft. Human review required before merge.");
    expect(neutralizeMentions("a@b")).toBe("a@​b");
    expect(pullRequestBody({ summaryText: "x".repeat(10_000), requestedBy: "U1", threadLink: "l" }).length).toBeLessThan(4_200);
  });

  test("title uses the single commit subject, else the request, capped at 72", () => {
    expect(pullRequestTitle({ aheadCount: 1, firstCommitSubject: "Fix typo", request: "please fix" })).toBe("Fix typo");
    expect(pullRequestTitle({ aheadCount: 2, firstCommitSubject: "Fix typo", request: "\nplease fix\nthanks" })).toBe("please fix");
    expect(pullRequestTitle({ aheadCount: 2, request: "y".repeat(100) })).toHaveLength(72);
  });
});

describe("GitHub PAT credentials", () => {
  test("re-reads a 0600 token file on every call and never describes the value", async () => {
    await withTempDir("github-auth", async (directory) => {
      const secrets = join(directory, "secrets");
      await mkdir(secrets, { mode: 0o700 });
      const tokenFile = join(secrets, "github-token");
      const first = canaryToken();
      await writeFile(tokenFile, `${first}\n`, { mode: 0o600 });
      const credentials = tokenFileCredentials(tokenFile);
      expect((await credentials.token("octo/example")).exposeToBoundary()).toBe(first);
      const rotated = canaryToken();
      await writeFile(tokenFile, `${rotated}\n`, { mode: 0o600 });
      expect((await credentials.token("octo/example")).exposeToBoundary()).toBe(rotated);
      expect(credentials.describe()).not.toContain(rotated);
      expect(String(await credentials.token("octo/example"))).toBe("[REDACTED]");

      await chmod(tokenFile, 0o644);
      const loose = await credentials.token("octo/example").catch((caught: unknown) => caught);
      expect(loose).toBeInstanceOf(GitHubCredentialError);
      expect(String((loose as Error).message)).toContain("0600");
      expect(String((loose as Error).message)).not.toContain(rotated);

      await writeFile(tokenFile, "two words\n", { mode: 0o600 });
      await chmod(tokenFile, 0o600);
      expect(await credentials.token("octo/example").catch((caught: unknown) => caught)).toBeInstanceOf(GitHubCredentialError);
    });
  });

  test("client uses the rotated token on the next request", async () => {
    const tokens = [canaryToken(), canaryToken()];
    let call = 0;
    const fake = fakeGitHub([() => json(200, []), () => json(200, [])]);
    const github = createGitHubClient({
      apiBaseUrl: "https://api.github.example",
      credentials: { token: async () => new SecretString(tokens[call++]!), describe: () => "rotating" },
      fetch: fake.fetch,
    });
    await github.findPullByHead("octo/example", "agent-tag/task-1");
    await github.findPullByHead("octo/example", "agent-tag/task-1");
    expect(fake.requests.map((request) => request.headers.get("authorization"))).toEqual(tokens.map((token) => `Bearer ${token}`));
  });

  test("builds PAT credentials from config", async () => {
    const config = agentTagConfigSchema.shape.github.unwrap().parse({ auth: { type: "token", tokenFile: "/secrets/github-token" } });
    const read: string[] = [];
    const credentials = githubCredentialsFromConfig(config, async (path) => {
      read.push(path);
      return new SecretString("token-value");
    });
    expect((await credentials.token("octo/example")).exposeToBoundary()).toBe("token-value");
    expect(read).toEqual(["/secrets/github-token"]);
  });
});
