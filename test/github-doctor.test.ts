import { describe, expect, test } from "bun:test";

import { agentTagConfigSchema } from "../src/config.ts";
import { checkGitHubAccess, checkGitVersion, pullRequestRepositories } from "../src/github/doctor-check.ts";
import type { FetchLike } from "../src/github/client.ts";
import { SecretString } from "../src/security/secret-file.ts";

const config = agentTagConfigSchema.parse({
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: { workspaceId: "T1", appTokenFile: "/var/lib/agent-tag/a", botTokenFile: "/var/lib/agent-tag/b" },
  github: { apiBaseUrl: "https://api.github.example", auth: { type: "token", tokenFile: "/var/lib/agent-tag/github-token" } },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  profiles: ["one", "two"].map((id) => ({
    id,
    repositoryRoots: ["/srv/repos/a", "/srv/repos/b"],
    baseBranch: "main",
    defaultProviderInstanceId: "codex",
    defaultModel: "gpt-5.6-sol",
    runtimeMode: "approval-required",
    isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
    externalWrites: { mode: "approval-required" },
    memory: { shared: true, privateDm: false, retentionDays: 180 },
    pullRequests: {
      mode: "auto",
      repositories: [{ root: "/srv/repos/a", repo: "octo/a" }, { root: "/srv/repos/b", repo: id === "one" ? "octo/b" : "octo/a" }],
    },
  })),
  routes: [{ conversationId: "C1", profileId: "one" }],
  limits: { maxConcurrentTasks: 1 },
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub doctor checks", () => {
  test("git version must be at least 2.38", () => {
    expect(checkGitVersion("git version 2.39.5 (Apple Git-154)\n")).toMatchObject({ status: "pass", summary: "git 2.39.5" });
    expect(checkGitVersion("git version 2.38.0\n").status).toBe("pass");
    expect(checkGitVersion("git version 3.0\n").status).toBe("pass");
    expect(checkGitVersion("git version 2.37.9\n")).toMatchObject({ status: "fail" });
    expect(checkGitVersion("git version 1.99.0\n").status).toBe("fail");
    expect(checkGitVersion(undefined).status).toBe("fail");
    expect(checkGitVersion("something else").status).toBe("warn");
  });

  test("repositories are deduplicated across profiles", () => {
    expect(pullRequestRepositories(config)).toEqual(["octo/a", "octo/b"]);
  });

  test("push access per repository; the token goes only to the API host", async () => {
    const token = new SecretString(`github_pat_${"x".repeat(40)}`);
    const seen: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push(input);
      expect(new URL(input).host).toBe("api.github.example");
      expect(new Headers(init.headers).get("authorization")).toContain("github_pat_");
      if (input.endsWith("/repos/octo/a")) return json(200, { full_name: "octo/a", permissions: { push: true } });
      return json(200, { full_name: "octo/b", permissions: { push: false } });
    };
    const results = await checkGitHubAccess({ config, token, fetch });
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ["github-access:octo/a", "pass"],
      ["github-access:octo/b", "fail"],
    ]);
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain("github_pat_");
  });

  test("unknown permissions pass with a note; rejected tokens and missing repos fail with hints", async () => {
    const token = new SecretString(`github_pat_${"y".repeat(40)}`);
    const unknown = await checkGitHubAccess({ config, token, fetch: async () => json(200, { full_name: "octo/a" }) });
    expect(unknown.every((result) => result.status === "pass" && result.hint !== undefined)).toBe(true);
    const rejected = await checkGitHubAccess({ config, token, fetch: async () => json(401, { message: "Bad credentials" }) });
    expect(rejected[0]).toMatchObject({ status: "fail" });
    expect(rejected[0]?.hint).toContain("tokenFile");
    const missing = await checkGitHubAccess({ config, token, fetch: async () => json(404, { message: "Not Found" }) });
    expect(missing[0]?.hint).toContain("not granted");
  });
});
