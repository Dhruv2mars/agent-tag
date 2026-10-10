import { describe, expect, test } from "bun:test";

import { type CommandResult, requireSuccess, runCommand } from "../src/command.ts";

const runner = (result: CommandResult) => async (): Promise<CommandResult> => result;

describe("requireSuccess", () => {
  test("returns the result of a successful command", async () => {
    const result = { exitCode: 0, stdout: "ok", stderr: "" };
    expect(await requireSuccess(runner(result), ["true"], "probe")).toEqual(result);
  });

  test("keeps a stdout-only failure report, such as doctor's, in the error", async () => {
    const report = "fail secret:slack-bot-token  secret file /s/slack-bot-token is missing";
    await expect(
      requireSuccess(runner({ exitCode: 1, stdout: report, stderr: "" }), ["agent-tag", "doctor"], "Agent Tag doctor"),
    ).rejects.toThrow(`Agent Tag doctor failed with exit code 1: ${report}`);
  });

  test("includes both stderr and stdout when both are present", async () => {
    await expect(
      requireSuccess(runner({ exitCode: 2, stdout: "details", stderr: "boom" }), ["x"], "x"),
    ).rejects.toThrow("x failed with exit code 2: boom\ndetails");
  });
});

describe("runCommand", () => {
  test("kills the command when its signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await runCommand(["sleep", "30"], { signal: controller.signal });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("kills descendants that inherited the output pipes when its signal aborts", async () => {
    const controller = new AbortController();
    const marker = `/tmp/agent-tag-command-test-${process.pid}-${Date.now()}`;
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand(["sh", "-c", `(sleep 2; touch ${marker}) & wait`], { signal: controller.signal });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    await Bun.sleep(2_500);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("returns promptly after abort even when a descendant left the process group and holds the pipes", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand(["sh", "-c", `perl -e 'setpgrp(0, 0); sleep 3' & wait`], { signal: controller.signal });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("does not start a command whose signal already aborted", async () => {
    const result = await runCommand(["sleep", "30"], { signal: AbortSignal.abort() });
    expect(result.exitCode).toBe(130);
  });
});
