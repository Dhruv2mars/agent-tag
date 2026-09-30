import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `command failed with exit code ${exitCode}: ${command.join(" ")}\n${stdout.trim()}\n${stderr.trim()}`,
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

const repository = resolve(import.meta.dir, "..");
const status = await run(["/usr/bin/git", "status", "--porcelain"], repository);
if (status.stdout !== "") throw new Error("clean-install verification requires a clean checkout");

const commit = (await run(["/usr/bin/git", "rev-parse", "HEAD"], repository)).stdout;
const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-tag-clean-install-"));
const archivePath = join(temporaryRoot, "source.tar");
const checkout = join(temporaryRoot, "checkout");

try {
  await mkdir(checkout, { mode: 0o700 });
  await run(
    ["/usr/bin/git", "archive", "--format=tar", `--output=${archivePath}`, "HEAD"],
    repository,
  );
  await run(["/usr/bin/tar", "-xf", archivePath, "-C", checkout], repository);
  await run([process.execPath, "install", "--frozen-lockfile"], checkout);
  await run([process.execPath, "run", "check"], checkout);
  await run([process.execPath, "run", "verify:t3-pin"], checkout);
  console.log(
    JSON.stringify(
      {
        commit,
        source: "git-archive",
        install: "frozen-lockfile",
        checks: ["typecheck", "tests", "t3-release-pin"],
        result: "pass",
      },
      null,
      2,
    ),
  );
} finally {
  if (!temporaryRoot.startsWith(`${tmpdir()}/agent-tag-clean-install-`)) {
    throw new Error(`refusing to remove unexpected temporary path ${temporaryRoot}`);
  }
  await rm(temporaryRoot, { recursive: true });
}
