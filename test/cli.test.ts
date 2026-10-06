import { expect, test } from "bun:test";
import { resolve } from "node:path";

const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

async function runCli(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function expectCleanUsageError(result: { exitCode: number; stdout: string; stderr: string }, problem: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`agent-tag: ${problem}\n`);
  expect(result.stderr).toContain("usage: agent-tag onboard");
  expect(result.stderr).toContain("agent-tag doctor [CONFIG] [--fix] [--json]");
  expect(result.stderr).toContain("agent-tag service <install|upgrade|uninstall|status|restart|logs>");
  expect(result.stderr).toContain("agent-tag <run|status|audit|backup> CONFIG");
  expect(result.stderr).toContain("agent-tag help");
  // No Bun error banner, code frame, or stack frames.
  expect(result.stderr).not.toContain("cli.ts:");
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toContain("error:");
}

// onboard, doctor, and service are real commands (doctor's CONFIG is optional), so they never reach usage().
test("an unknown command prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["onbaord"]), "unknown command: onbaord");
  expectCleanUsageError(await runCli(["bogus", "x"]), "unknown command: bogus");
});

test("a known command without its argument prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["status"]), "status requires an argument");
  expectCleanUsageError(await runCli(["run"]), "run requires an argument");
  const restore = await runCli(["restore", "/nonexistent/backup.sqlite"]);
  expect(restore.exitCode).toBe(1);
  expect(restore.stderr.startsWith("usage: agent-tag")).toBe(true);
  expect(restore.stderr).not.toContain("cli.ts:");
});
