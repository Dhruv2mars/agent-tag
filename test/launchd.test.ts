import { expect, test } from "bun:test";

import { renderLaunchAgent } from "../src/launchd.ts";

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
