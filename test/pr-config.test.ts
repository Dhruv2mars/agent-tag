import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema, pullRequestRepositoryFor } from "../src/config.ts";

const example: Record<string, unknown> = await Bun.file(new URL("../config/agent-tag.example.json", import.meta.url)).json();

const github = { auth: { type: "token", tokenFile: "/secrets/github-token" } };

const baseProfile = {
  id: "engineering",
  repositoryRoots: ["/repos/example", "/repos/other"],
  baseBranch: "trunk",
  defaultProviderInstanceId: "codex",
  defaultModel: "gpt-5.6-sol",
  runtimeMode: "approval-required",
  isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
  externalWrites: { mode: "approval-required", allowedTools: [] },
  memory: { shared: true, privateDm: false, retentionDays: 180 },
};

function config(input: { profile?: Record<string, unknown>; github?: unknown } = {}) {
  return {
    version: 1,
    dataDir: "/var/lib/agent-tag",
    t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/secrets/t3" },
    slack: { workspaceId: "T123", appTokenFile: "/secrets/slack-app", botTokenFile: "/secrets/slack-bot" },
    access: { allowedUserIds: ["U123"], allowedChannelIds: ["C123"] },
    profiles: [{ ...baseProfile, ...input.profile }],
    routes: [{ conversationId: "C123", profileId: "engineering" }],
    limits: { maxConcurrentTasks: 2 },
    ...(input.github === undefined ? {} : { github: input.github }),
  };
}

const autoMode = { mode: "auto", repositories: [{ root: "/repos/example", repo: "octo/example" }] };

function issues(input: unknown): string[] {
  const parsed = agentTagConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("pull request config", () => {
  test("existing configs stay valid: pull requests default to off and github is optional", () => {
    const parsed = agentTagConfigSchema.parse(config());
    expect(parsed.profiles[0]!.pullRequests).toEqual({ mode: "off" });
    expect(parsed.github).toBeUndefined();
    expect(pullRequestRepositoryFor(parsed.profiles[0]!, "/repos/example")).toBeUndefined();
  });

  test("the example config parses with github set and pull requests off", () => {
    const parsed = agentTagConfigSchema.parse(example);
    expect(parsed.github).toEqual({
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
      auth: { type: "token", tokenFile: "/var/lib/agent-tag/secrets/github-token" },
    });
    expect(parsed.profiles[0]!.pullRequests).toEqual({ mode: "off" });
  });

  test("enabled mode fills defaults and resolves the base branch from the profile", () => {
    const parsed = agentTagConfigSchema.parse(
      config({
        github: { ...github, apiBaseUrl: "https://ghe.example/api/v3/", webBaseUrl: "https://ghe.example/" },
        profile: {
          pullRequests: {
            mode: "auto",
            repositories: [
              { root: "/repos/example", repo: "octo/example" },
              { root: "/repos/other", repo: "octo/other.js", baseBranch: "release/1.x" },
            ],
          },
        },
      }),
    );
    expect(parsed.github).toMatchObject({ apiBaseUrl: "https://ghe.example/api/v3", webBaseUrl: "https://ghe.example" });
    const profile = parsed.profiles[0]!;
    expect(profile.pullRequests).toEqual({
      mode: "auto",
      repositories: [
        { root: "/repos/example", repo: "octo/example" },
        { root: "/repos/other", repo: "octo/other.js", baseBranch: "release/1.x" },
      ],
      draft: true,
      commitAuthor: { name: "Agent Tag", email: "agent-tag@users.noreply.github.com" },
      maxChangedFiles: 300,
      maxDiffBytes: 2_000_000,
      secretScan: "block",
    });
    expect(pullRequestRepositoryFor(profile, "/repos/example")).toEqual({
      root: "/repos/example",
      repo: "octo/example",
      owner: "octo",
      name: "example",
      baseBranch: "trunk",
    });
    expect(pullRequestRepositoryFor(profile, "/repos/other")?.baseBranch).toBe("release/1.x");
    expect(pullRequestRepositoryFor(profile, "/repos/unknown")).toBeUndefined();
  });

  test("a non-off mode requires the top-level github config", () => {
    expect(issues(config({ profile: { pullRequests: autoMode } }))).toContain(
      "profiles.0.pullRequests.mode: pull requests require the top-level github config",
    );
    expect(issues(config({ profile: { pullRequests: { ...autoMode, mode: "button" } } }))).toHaveLength(1);
    expect(issues(config({ github, profile: { pullRequests: autoMode } }))).toEqual([]);
  });

  test("repository roots must be in the profile's repositoryRoots and unique", () => {
    expect(
      issues(config({ github, profile: { pullRequests: { mode: "auto", repositories: [{ root: "/elsewhere", repo: "octo/example" }] } } })),
    ).toEqual(["profiles.0.pullRequests.repositories.0.root: pull request repository root is not in the profile's repositoryRoots"]);
    expect(
      issues(
        config({
          github,
          profile: {
            pullRequests: {
              mode: "auto",
              repositories: [
                { root: "/repos/example", repo: "octo/a" },
                { root: "/repos/example", repo: "octo/b" },
              ],
            },
          },
        }),
      ),
    ).toEqual(["profiles.0.pullRequests.repositories.1.root: pull request repository roots must be unique"]);
    expect(issues(config({ github, profile: { pullRequests: { mode: "auto", repositories: [] } } })).length).toBeGreaterThan(0);
  });

  test("externalWrites deny forces pull requests off", () => {
    expect(issues(config({ github, profile: { externalWrites: { mode: "deny" }, pullRequests: autoMode } }))).toEqual([
      'profiles.0.pullRequests.mode: pull requests push to GitHub, so they must be "off" when externalWrites.mode is "deny"',
    ]);
    expect(issues(config({ github, profile: { externalWrites: { mode: "deny" }, pullRequests: { mode: "off" } } }))).toEqual([]);
  });

  test("rejects malformed repos, branches, URLs, authors, unknown keys and App auth (not yet supported)", () => {
    const withRepository = (repository: Record<string, unknown>) =>
      config({ github, profile: { pullRequests: { mode: "auto", repositories: [{ root: "/repos/example", ...repository }] } } });
    expect(issues(withRepository({ repo: "octo" }))).not.toEqual([]);
    expect(issues(withRepository({ repo: "octo/ex ample" }))).not.toEqual([]);
    expect(issues(withRepository({ repo: "octo/example/extra" }))).not.toEqual([]);
    expect(issues(withRepository({ repo: "octo/example", baseBranch: "-main" }))).not.toEqual([]);
    expect(issues(withRepository({ repo: "octo/example", baseBranch: "a..b" }))).not.toEqual([]);
    expect(issues(withRepository({ repo: "octo/example", typo: true }))).not.toEqual([]);

    expect(issues(config({ github: { ...github, webBaseUrl: "http://github.com" } }))).not.toEqual([]);
    expect(issues(config({ github: { ...github, apiBaseUrl: "https://user:pass@api.github.com" } }))).not.toEqual([]);
    expect(issues(config({ github: { ...github, webBaseUrl: "file:///tmp/remote" } }))).not.toEqual([]);
    expect(issues(config({ github: { auth: { type: "token", tokenFile: "relative/token" } } }))).not.toEqual([]);
    expect(issues(config({ github: { auth: { type: "app", appId: 1, installationId: 2, privateKeyFile: "/secrets/app.pem" } } }))).not.toEqual([]);
    expect(issues(config({ github: { ...github, token: "inline-token" } }))).not.toEqual([]);

    expect(
      issues(config({ github, profile: { pullRequests: { ...autoMode, commitAuthor: { name: "Agent <evil>", email: "a@b" } } } })),
    ).not.toEqual([]);
    expect(issues(config({ github, profile: { pullRequests: { ...autoMode, commitAuthor: { name: "A\nB", email: "a@b" } } } }))).not.toEqual([]);
    expect(issues(config({ github, profile: { pullRequests: { ...autoMode, secretScan: "warn" } } }))).not.toEqual([]);
    expect(issues(config({ github, profile: { pullRequests: { mode: "sometimes" } } }))).not.toEqual([]);
  });
});
