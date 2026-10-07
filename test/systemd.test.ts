import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult } from "../src/command.ts";
import {
  AGENT_TAG_SYSTEMD_UNIT,
  lingerHint,
  parseSystemctlShow,
  parseSystemdUnitPaths,
  renderSystemdUnit,
  type SystemdUnitDefinition,
  SystemdUserService,
  systemdLogsCommand,
  systemdQuote,
  systemdUnitDirectory,
} from "../src/systemd.ts";

const sourceProgram = { kind: "source", bunPath: "/home/agent/.bun/bin/bun", cliPath: "/srv/agent-tag/src/cli.ts" } as const;

const definition: SystemdUnitDefinition = {
  program: sourceProgram,
  configPath: "/home/agent/.agent-tag/agent-tag.json",
  workingDirectory: "/srv/agent-tag",
};

describe("systemd unit rendering", () => {
  test("renders a restartable user unit with quoted absolute arguments", () => {
    const unit = renderSystemdUnit(definition);
    expect(unit).toContain(
      'ExecStart="/home/agent/.bun/bin/bun" "run" "/srv/agent-tag/src/cli.ts" "run" "/home/agent/.agent-tag/agent-tag.json"',
    );
    expect(unit).toContain("WorkingDirectory=/srv/agent-tag\n");
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("UMask=0077\n");
    expect(unit).toContain("WantedBy=default.target\n");
    // A --user manager cannot see network-online.target, and a start limit would stop retries for good.
    expect(unit).not.toMatch(/^(After|Wants)=network-online\.target$/m);
    expect(unit).toContain("StartLimitIntervalSec=0\n");
    expect(unit).not.toContain("StartLimitBurst");
    expect(unit).toContain("RestartSec=10\n");
  });

  test("reads ExecStart and WorkingDirectory back, including escaped characters", () => {
    const odd = { ...definition, configPath: '/srv/50% off/$USER "q" \\b.json', workingDirectory: "/srv/100% repo" };
    expect(parseSystemdUnitPaths(renderSystemdUnit(odd))).toEqual(odd);
    expect(parseSystemdUnitPaths("[Service]\nExecStart=/bin/true\n")).toEqual({});
  });

  test("runs a release binary directly instead of bun and src/cli.ts", () => {
    const binary: SystemdUnitDefinition = {
      program: { kind: "binary", binaryPath: "/home/agent/.local/bin/agent-tag" },
      configPath: "/home/agent/.agent-tag/agent-tag.json",
      workingDirectory: "/home/agent/.agent-tag",
    };
    const unit = renderSystemdUnit(binary);
    expect(unit).toContain('ExecStart="/home/agent/.local/bin/agent-tag" "run" "/home/agent/.agent-tag/agent-tag.json"\n');
    expect(unit).toContain("WorkingDirectory=/home/agent/.agent-tag\n");
    expect(unit).not.toContain("cli.ts");
    expect(parseSystemdUnitPaths(unit)).toEqual(binary);
    expect(() => renderSystemdUnit({ ...binary, program: { kind: "binary", binaryPath: "agent-tag" } })).toThrow("must be absolute");
  });

  test("escapes specifiers, variables, quotes, and backslashes", () => {
    expect(systemdQuote('/srv/a "b"\\c%h$HOME')).toBe('"/srv/a \\"b\\"\\\\c%%h$$HOME"');
    const unit = renderSystemdUnit({ ...definition, configPath: "/srv/50% off/$USER.json", workingDirectory: "/srv/100%" });
    expect(unit).toContain('"/srv/50%% off/$$USER.json"');
    expect(unit).toContain("WorkingDirectory=/srv/100%%\n");
  });

  test("rejects relative paths and control characters", () => {
    expect(() => renderSystemdUnit({ ...definition, program: { ...sourceProgram, bunPath: "bun" } })).toThrow("must be absolute");
    expect(() => renderSystemdUnit({ ...definition, configPath: "/srv/a\nExecStartPre=/bin/sh" })).toThrow(
      "control characters",
    );
  });

  test("parses systemctl show output and the lingering hint", () => {
    const values = parseSystemctlShow("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n");
    expect(values.get("SubState")).toBe("running");
    expect(lingerHint("Linger=yes", "agent")).toBeUndefined();
    expect(lingerHint("Linger=no", "agent")).toContain("loginctl enable-linger agent");
  });

  test("builds journalctl and unit directory paths", () => {
    expect(systemdLogsCommand({ lines: 50, follow: true })).toEqual([
      "journalctl", "--user", "--unit", AGENT_TAG_SYSTEMD_UNIT, "--lines", "50", "--no-pager", "--follow",
    ]);
    expect(systemdLogsCommand({ lines: 10, follow: false })).not.toContain("--follow");
    expect(systemdUnitDirectory({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/systemd/user");
    expect(systemdUnitDirectory({ XDG_CONFIG_HOME: "relative" })).toEndWith("/.config/systemd/user");
  });
});

/** A scripted systemctl: tracks enabled/active state from the commands it receives. */
class FakeSystemctl {
  readonly commands: string[] = [];
  active = false;
  enabled = false;
  failEnable = false;
  failRestart = false;
  failDisable = false;
  linger = "no";
  preflights = 0;

  readonly run = async (command: readonly string[]): Promise<CommandResult> => {
    const text = command.join(" ");
    this.commands.push(text);
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (command[0] === "loginctl") return ok(`Linger=${this.linger}`);
    const verb = command[2];
    if (verb === "show") {
      return ok(
        [
          `LoadState=${this.enabled || this.active ? "loaded" : "not-found"}`,
          `ActiveState=${this.active ? "active" : "inactive"}`,
          `SubState=${this.active ? "running" : "dead"}`,
          `UnitFileState=${this.enabled ? "enabled" : ""}`,
        ].join("\n"),
      );
    }
    if (verb === "enable") {
      if (this.failEnable) return { exitCode: 1, stdout: "", stderr: "unit failed" };
      this.enabled = true;
      if (command.includes("--now")) this.active = true;
      return ok();
    }
    if (verb === "restart") {
      if (this.failRestart) {
        this.active = false;
        return { exitCode: 1, stdout: "", stderr: "restart failed" };
      }
      this.active = true;
      return ok();
    }
    if (verb === "disable") {
      if (this.failDisable) return { exitCode: 1, stdout: "", stderr: "Failed to stop unit: Access denied\n" };
      this.enabled = false;
      if (command.includes("--now")) this.active = false;
      return ok();
    }
    if (verb === "stop") this.active = false;
    return ok();
  };
}

describe("systemd user service lifecycle", () => {
  let directory: string;
  let fake: FakeSystemctl;
  let service: SystemdUserService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-tag-systemd-"));
    fake = new FakeSystemctl();
    service = new SystemdUserService({
      run: fake.run,
      unitDirectory: join(directory, "systemd", "user"),
      user: "agent",
      sleep: async () => {},
      definition: async (configPath) => ({ ...definition, configPath }),
      preflight: async () => {
        fake.preflights += 1;
      },
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("install runs the doctor, writes a private unit, enables it, and reports linger", async () => {
    const status = await service.install("/cfg/a.json");
    expect(fake.preflights).toBe(1);
    expect(status).toMatchObject({ manager: "systemd", installed: true, loaded: true, enabled: true, running: true });
    expect(status.hints[0]).toContain("loginctl enable-linger agent");
    const unit = await readFile(service.unitPath, "utf8");
    expect(unit).toBe(renderSystemdUnit({ ...definition, configPath: "/cfg/a.json" }));
    expect((await stat(service.unitPath)).mode & 0o777).toBe(0o600);
    expect(fake.commands).toContain("systemctl --user daemon-reload");
    expect(fake.commands).toContain(`systemctl --user enable --now ${AGENT_TAG_SYSTEMD_UNIT}`);
    fake.linger = "yes";
    expect((await service.status()).hints).toEqual([]);
  });

  test("install refuses an existing unit and rolls back a failed start", async () => {
    await service.install("/cfg/a.json");
    await expect(service.install("/cfg/a.json")).rejects.toThrow("already installed");
    await service.uninstall();

    fake.failEnable = true;
    await expect(service.install("/cfg/a.json")).rejects.toThrow("systemd enable failed");
    expect(await Bun.file(service.unitPath).exists()).toBe(false);
    expect(fake.commands.at(-1)).toBe("systemctl --user daemon-reload");
  });

  test("upgrade rewrites the unit and restores the prior unit when restart fails", async () => {
    await service.install("/cfg/a.json");
    await service.upgrade("/cfg/b.json");
    expect(await readFile(service.unitPath, "utf8")).toContain('"/cfg/b.json"');
    expect(fake.preflights).toBe(2);

    fake.failRestart = true;
    await expect(service.upgrade("/cfg/c.json")).rejects.toThrow(
      /systemd restart failed.*restarting the prior unit also failed/,
    );
    expect(await readFile(service.unitPath, "utf8")).toContain('"/cfg/b.json"');
    expect(fake.commands.filter((command) => command.endsWith("daemon-reload")).length).toBeGreaterThanOrEqual(3);
  });

  test("upgrade and restart require an installed unit", async () => {
    await expect(service.upgrade("/cfg/a.json")).rejects.toThrow("not installed");
    await expect(service.restart()).rejects.toThrow("not installed");
  });

  test("unitState distinguishes current, stale, and different-config units", async () => {
    expect(await service.unitState("/cfg/a.json")).toMatchObject({ installed: false, current: false });
    await service.install("/cfg/a.json");
    expect(await service.unitState("/cfg/a.json")).toMatchObject({ installed: true, current: true, sameConfig: true });
    expect(await service.unitState("/cfg/other.json")).toMatchObject({ installed: true, current: false, sameConfig: false });
    await writeFile(service.unitPath, (await readFile(service.unitPath, "utf8")).replace("RestartSec=10", "RestartSec=5"));
    expect(await service.unitState("/cfg/a.json")).toMatchObject({
      installed: true,
      current: false,
      sameConfig: true,
      sameCheckout: true,
      sameBun: true,
    });
    await writeFile(
      service.unitPath,
      renderSystemdUnit({
        ...definition,
        configPath: "/cfg/a.json",
        program: { ...sourceProgram, cliPath: "/srv/live/src/cli.ts" },
        workingDirectory: "/srv/live",
      }),
    );
    expect(await service.unitState("/cfg/a.json")).toMatchObject({
      current: false,
      sameConfig: true,
      sameCheckout: false,
      installedCheckout: "/srv/live",
    });
    await writeFile(service.unitPath, renderSystemdUnit({ ...definition, configPath: "/cfg/a.json", program: { ...sourceProgram, bunPath: "/opt/bun" } }));
    expect(await service.unitState("/cfg/a.json")).toMatchObject({ sameCheckout: true, sameBun: false, installedBunPath: "/opt/bun" });
    // A release binary and a checkout are never the same install, even for the same config.
    await writeFile(
      service.unitPath,
      renderSystemdUnit({
        program: { kind: "binary", binaryPath: "/home/agent/.local/bin/agent-tag" },
        configPath: "/cfg/a.json",
        workingDirectory: "/cfg",
      }),
    );
    expect(await service.unitState("/cfg/a.json")).toMatchObject({
      current: false,
      sameConfig: true,
      sameCheckout: false,
      sameBun: false,
      installedBinary: "/home/agent/.local/bin/agent-tag",
    });
  });

  test("uninstall disables, removes the unit, and reloads", async () => {
    await service.install("/cfg/a.json");
    const status = await service.uninstall();
    expect(status).toMatchObject({ installed: false, running: false, enabled: false });
    expect(fake.commands).toContain(`systemctl --user disable --now ${AGENT_TAG_SYSTEMD_UNIT}`);
    expect(fake.commands).toContain(`systemctl --user reset-failed ${AGENT_TAG_SYSTEMD_UNIT}`);
  });

  test("uninstall keeps the unit when disable --now fails, so it can be retried", async () => {
    await service.install("/cfg/a.json");
    const unit = await readFile(service.unitPath, "utf8");
    fake.failDisable = true;
    fake.commands.length = 0;
    await expect(service.uninstall()).rejects.toThrow(
      `systemd disable --now failed with exit code 1: Failed to stop unit: Access denied; kept ${service.unitPath}`,
    );
    expect(await readFile(service.unitPath, "utf8")).toBe(unit);
    expect(fake.commands).not.toContain("systemctl --user daemon-reload");
    expect(fake.commands).not.toContain(`systemctl --user reset-failed ${AGENT_TAG_SYSTEMD_UNIT}`);

    fake.failDisable = false;
    expect(await service.uninstall()).toMatchObject({ installed: false, running: false });
    expect(await Bun.file(service.unitPath).exists()).toBe(false);
  });

  test("restart waits for the running state", async () => {
    await service.install("/cfg/a.json");
    fake.active = false;
    fake.commands.length = 0;
    expect((await service.restart()).running).toBe(true);
    const reset = fake.commands.indexOf(`systemctl --user reset-failed ${AGENT_TAG_SYSTEMD_UNIT}`);
    const restart = fake.commands.indexOf(`systemctl --user restart ${AGENT_TAG_SYSTEMD_UNIT}`);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reset);
  });

  test("install and upgrade clear a failed state before starting", async () => {
    await service.install("/cfg/a.json");
    const enable = fake.commands.indexOf(`systemctl --user enable --now ${AGENT_TAG_SYSTEMD_UNIT}`);
    expect(fake.commands.slice(0, enable)).toContain(`systemctl --user reset-failed ${AGENT_TAG_SYSTEMD_UNIT}`);
    fake.commands.length = 0;
    await service.upgrade("/cfg/b.json");
    const restart = fake.commands.indexOf(`systemctl --user restart ${AGENT_TAG_SYSTEMD_UNIT}`);
    expect(fake.commands.slice(0, restart)).toContain(`systemctl --user reset-failed ${AGENT_TAG_SYSTEMD_UNIT}`);
  });
});
