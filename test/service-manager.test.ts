import { expect, test } from "bun:test";

import { launchAgentLogsCommand } from "../src/launchd.ts";
import {
  isServiceAction,
  serviceManagerFor,
  serviceManagerKindFor,
  systemdServiceManager,
} from "../src/service-manager.ts";
import { SystemdUserService } from "../src/systemd.ts";

test("dispatches launchd on macOS, systemd on Linux, and nothing elsewhere", () => {
  expect(serviceManagerKindFor("darwin")).toBe("launchd");
  expect(serviceManagerKindFor("linux")).toBe("systemd");
  expect(serviceManagerKindFor("win32")).toBeUndefined();
  expect(serviceManagerFor("win32")).toBeUndefined();
  if (process.platform === "darwin") expect(serviceManagerFor("darwin")?.kind).toBe("launchd");
});

test("accepts only the documented service actions", () => {
  for (const action of ["install", "upgrade", "uninstall", "status", "restart", "logs"]) {
    expect(isServiceAction(action)).toBe(true);
  }
  expect(isServiceAction("start")).toBe(false);
  expect(isServiceAction(undefined)).toBe(false);
});

test("the systemd adapter exposes journalctl logs", () => {
  const manager = systemdServiceManager(
    new SystemdUserService({
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      unitDirectory: "/nonexistent/systemd/user",
      user: "agent",
      sleep: async () => {},
      definition: async () => {
        throw new Error("unused");
      },
      preflight: async () => {},
    }),
  );
  expect(manager.kind).toBe("systemd");
  expect(manager.logsCommand({ lines: 5, follow: false })[0]).toBe("journalctl");
});

test("launchd logs tail both private service logs", () => {
  const command = launchAgentLogsCommand({ lines: 20, follow: true });
  expect(command.slice(0, 4)).toEqual(["/usr/bin/tail", "-n", "20", "-F"]);
  expect(command.at(-2)).toEndWith("/Library/Logs/AgentTag/service.stdout.log");
  expect(command.at(-1)).toEndWith("/Library/Logs/AgentTag/service.stderr.log");
});
