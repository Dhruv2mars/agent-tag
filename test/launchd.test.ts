import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult } from "../src/command.ts";
import {
  AGENT_TAG_LAUNCHD_LABEL,
  type LaunchAgentDefinition,
  type LaunchdHost,
  parseLaunchAgentPaths,
  renderLaunchAgent,
  restartLaunchAgent,
} from "../src/launchd.ts";
import { describeInstalledProgram, unitStateFor } from "../src/service-unit.ts";

test("renders a private macOS LaunchAgent with absolute executable arguments", () => {
  const plist = renderLaunchAgent({
    label: "dev.agent-tag.fixture",
    program: { kind: "source", bunPath: "/opt/homebrew/bin/bun", cliPath: "/srv/agent-tag/src/cli.ts" },
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
      program: { kind: "source", bunPath: "bun", cliPath: "/srv/agent-tag/src/cli.ts" },
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
    program: { kind: "source", bunPath: "/opt/homebrew/bin/bun", cliPath: "/Users/test/agent-tag/src/cli.ts" },
    configPath: "/Users/test/host/agent-tag <live> & 'q'.json",
    workingDirectory: "/Users/test/agent-tag",
    stdoutPath: "/Users/test/Library/Logs/AgentTag/service.stdout.log",
    stderrPath: "/Users/test/Library/Logs/AgentTag/service.stderr.log",
  };
  const installed = renderLaunchAgent(live);
  expect(parseLaunchAgentPaths(installed)).toEqual({
    program: live.program,
    configPath: live.configPath,
    workingDirectory: live.workingDirectory,
  });

  const worktree: LaunchAgentDefinition = {
    ...live,
    program: { kind: "source", bunPath: "/opt/homebrew/bin/bun", cliPath: "/Users/test/agent-tag-wt/x/src/cli.ts" },
    workingDirectory: "/Users/test/agent-tag-wt/x",
  };
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

test("a release binary LaunchAgent runs the binary itself and is never the same install as a checkout", () => {
  const binary: LaunchAgentDefinition = {
    label: "dev.agent-tag.service",
    program: { kind: "binary", binaryPath: "/Users/test/.local/bin/agent-tag" },
    configPath: "/Users/test/.agent-tag/agent-tag.json",
    workingDirectory: "/Users/test/.agent-tag",
    stdoutPath: "/Users/test/Library/Logs/AgentTag/service.stdout.log",
    stderrPath: "/Users/test/Library/Logs/AgentTag/service.stderr.log",
  };
  const plist = renderLaunchAgent(binary);
  expect(plist).toContain(
    "<array>\n      <string>/Users/test/.local/bin/agent-tag</string>\n      <string>run</string>\n      <string>/Users/test/.agent-tag/agent-tag.json</string>\n  </array>",
  );
  expect(plist).not.toContain("cli.ts");
  expect(parseLaunchAgentPaths(plist)).toEqual({
    program: binary.program,
    configPath: binary.configPath,
    workingDirectory: binary.workingDirectory,
  });

  const checkout: LaunchAgentDefinition = {
    ...binary,
    program: { kind: "source", bunPath: "/opt/homebrew/bin/bun", cliPath: "/Users/test/agent-tag/src/cli.ts" },
    workingDirectory: "/Users/test/agent-tag",
  };
  const state = unitStateFor({
    unitPath: "/p.plist",
    existing: plist,
    rendered: renderLaunchAgent(checkout),
    installed: parseLaunchAgentPaths(plist),
    expected: checkout,
  });
  expect(state).toMatchObject({ current: false, sameConfig: true, sameCheckout: false, sameBun: false, installedBinary: "/Users/test/.local/bin/agent-tag" });
  expect(describeInstalledProgram(state)).toBe("binary /Users/test/.local/bin/agent-tag");

  // The same binary at another path (for example a second copy) is a different install.
  const moved: LaunchAgentDefinition = { ...binary, program: { kind: "binary", binaryPath: "/opt/agent-tag/agent-tag" } };
  expect(
    unitStateFor({ unitPath: "/p.plist", existing: plist, rendered: renderLaunchAgent(moved), installed: parseLaunchAgentPaths(plist), expected: moved }),
  ).toMatchObject({ sameCheckout: false, sameBun: false });
});

/** A scripted launchctl for a fake uid: models a job that is registered (loaded) or not, and running or not. */
class FakeLaunchctl {
  readonly commands: string[] = [];
  loaded = false;
  running = false;
  failBootstrap = false;

  readonly run = async (command: readonly string[]): Promise<CommandResult> => {
    this.commands.push(command.slice(1).join(" "));
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    const notFound: CommandResult = { exitCode: 113, stdout: "", stderr: "Could not find service in domain for user gui: 4242" };
    const verb = command[1];
    if (verb === "print") {
      return this.loaded ? ok(`${target} = {\n\tstate = ${this.running ? "running" : "not running"}\n}`) : notFound;
    }
    if (verb === "kickstart") {
      if (!this.loaded) return notFound;
      this.running = true;
      return ok();
    }
    if (verb === "bootstrap") {
      if (this.failBootstrap) return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      this.loaded = true;
      this.running = true; // RunAtLoad
      return ok();
    }
    if (verb === "bootout") {
      this.loaded = false;
      this.running = false;
      return ok();
    }
    throw new Error(`unexpected launchctl ${command.join(" ")}`);
  };
}

const target = `gui/4242/${AGENT_TAG_LAUNCHD_LABEL}`;

describe("LaunchAgent restart", () => {
  let directory: string;
  let fake: FakeLaunchctl;
  let host: LaunchdHost;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-tag-launchd-"));
    fake = new FakeLaunchctl();
    host = { run: fake.run, sleep: async () => {}, uid: 4242, plistPath: join(directory, `${AGENT_TAG_LAUNCHD_LABEL}.plist`) };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("bootstraps the existing plist when the job was booted out, then starts it", async () => {
    await writeFile(host.plistPath, "<plist/>", { mode: 0o600 });
    const status = await restartLaunchAgent(host);
    expect(status).toMatchObject({ installed: true, loaded: true, running: true, plistPath: host.plistPath });
    expect(fake.commands.slice(0, 3)).toEqual([
      `print ${target}`,
      `bootstrap gui/4242 ${host.plistPath}`,
      `kickstart ${target}`,
    ]);
    expect(fake.commands).not.toContain(`kickstart -k ${target}`);
  });

  test("kickstarts a loaded job without bootstrapping it again", async () => {
    await writeFile(host.plistPath, "<plist/>", { mode: 0o600 });
    fake.loaded = true;
    const status = await restartLaunchAgent(host);
    expect(status).toMatchObject({ loaded: true, running: true });
    expect(fake.commands.slice(0, 2)).toEqual([`print ${target}`, `kickstart -k ${target}`]);
    expect(fake.commands.some((command) => command.startsWith("bootstrap"))).toBe(false);
  });

  test("reports a failed bootstrap and refuses to restart without a plist", async () => {
    await expect(restartLaunchAgent(host)).rejects.toThrow("not installed");
    expect(fake.commands).toEqual([]);

    await writeFile(host.plistPath, "<plist/>", { mode: 0o600 });
    fake.failBootstrap = true;
    await expect(restartLaunchAgent(host)).rejects.toThrow("LaunchAgent bootstrap failed with exit code 5");
    expect(fake.commands.some((command) => command.startsWith("kickstart"))).toBe(false);
  });
});
