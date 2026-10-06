import { expect, test } from "bun:test";

import { type LaunchAgentDefinition, parseLaunchAgentPaths, renderLaunchAgent } from "../src/launchd.ts";
import { unitStateFor } from "../src/service-unit.ts";

test("renders a private macOS LaunchAgent with absolute executable arguments", () => {
  const plist = renderLaunchAgent({
    label: "dev.agent-tag.fixture",
    bunPath: "/opt/homebrew/bin/bun",
    cliPath: "/srv/agent-tag/src/cli.ts",
    configPath: "/var/lib/agent-tag/config & live.json",
    workingDirectory: "/srv/agent-tag",
    stdoutPath: "/Users/test/Library/Logs/AgentTag/service.stdout.log",
    stderrPath: "/Users/test/Library/Logs/AgentTag/service.stderr.log",
  });
  expect(plist).toContain("<string>dev.agent-tag.fixture</string>");
  expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
  expect(plist).toContain("<string>/var/lib/agent-tag/config &amp; live.json</string>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).not.toContain("& live.json");
});

test("rejects relative LaunchAgent paths", () => {
  expect(() =>
    renderLaunchAgent({
      label: "dev.agent-tag.fixture",
      bunPath: "bun",
      cliPath: "/srv/agent-tag/src/cli.ts",
      configPath: "/var/lib/agent-tag/config.json",
      workingDirectory: "/srv/agent-tag",
      stdoutPath: "/Users/test/Library/Logs/AgentTag/service.stdout.log",
      stderrPath: "/Users/test/Library/Logs/AgentTag/service.stderr.log",
    }),
  ).toThrow("LaunchAgent paths must be absolute");
});

test("reads paths back from an installed plist and tells a different checkout from template drift", () => {
  const live: LaunchAgentDefinition = {
    label: "dev.agent-tag.service",
    bunPath: "/opt/homebrew/bin/bun",
    cliPath: "/Users/test/agent-tag/src/cli.ts",
    configPath: "/Users/test/host/agent-tag <live> & 'q'.json",
    workingDirectory: "/Users/test/agent-tag",
    stdoutPath: "/Users/test/Library/Logs/AgentTag/service.stdout.log",
    stderrPath: "/Users/test/Library/Logs/AgentTag/service.stderr.log",
  };
  const installed = renderLaunchAgent(live);
  expect(parseLaunchAgentPaths(installed)).toEqual({
    bunPath: live.bunPath,
    cliPath: live.cliPath,
    configPath: live.configPath,
    workingDirectory: live.workingDirectory,
  });

  const worktree = { ...live, cliPath: "/Users/test/agent-tag-wt/x/src/cli.ts", workingDirectory: "/Users/test/agent-tag-wt/x" };
  const fromWorktree = unitStateFor({
    unitPath: "/p.plist",
    existing: installed,
    rendered: renderLaunchAgent(worktree),
    installed: parseLaunchAgentPaths(installed),
    expected: worktree,
  });
  expect(fromWorktree).toMatchObject({
    current: false,
    sameConfig: true,
    sameCheckout: false,
    sameBun: true,
    installedCheckout: "/Users/test/agent-tag",
  });

  const drifted = installed.replace("<integer>10</integer>", "<integer>5</integer>");
  expect(
    unitStateFor({ unitPath: "/p.plist", existing: drifted, rendered: installed, installed: parseLaunchAgentPaths(drifted), expected: live }),
  ).toMatchObject({ current: false, sameConfig: true, sameCheckout: true, sameBun: true });
  expect(parseLaunchAgentPaths("<plist></plist>")).toEqual({});
});
