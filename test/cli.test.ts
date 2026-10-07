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
  expect(result.stderr).toContain("usage: agent-tag <run|doctor|status|audit|backup> CONFIG");
  expect(result.stderr).toContain("agent-tag help");
  // No Bun error banner, code frame, or stack frames.
  expect(result.stderr).not.toContain("cli.ts:");
  expect(result.stderr).not.toMatch(/^\s+at /m);
  expect(result.stderr).not.toContain("error:");
}

test("an unknown command prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["onboard"]), "unknown command: onboard");
  expectCleanUsageError(await runCli(["bogus", "x"]), "unknown command: bogus");
});

test("a known command without its argument prints usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["doctor"]), "doctor requires an argument");
  const restore = await runCli(["restore", "/nonexistent/backup.sqlite"]);
  expect(restore.exitCode).toBe(1);
  expect(restore.stderr.startsWith("usage: agent-tag")).toBe(true);
  expect(restore.stderr).not.toContain("cli.ts:");
});

test("security and prune argument mistakes print usage without a stack trace", async () => {
  expectCleanUsageError(await runCli(["security", "audit"]), "invalid security arguments");
  expectCleanUsageError(await runCli(["security", "audit", "/x.json", "--bogus"]), "unknown option --bogus");
  expectCleanUsageError(await runCli(["prune"]), "invalid prune arguments");
});

test("security audit prints its report and exits 1 on a high finding", async () => {
  const result = await runCli(["security", "audit", "/nonexistent/agent-tag.json", "--json", "--offline"]);
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout) as { result: string; findings: Array<{ id: string }> };
  expect(report.result).toBe("fail");
  expect(report.findings.map((finding) => finding.id)).toContain("config-unreadable");
});
