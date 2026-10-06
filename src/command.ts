export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

/** Runs a command without a shell and captures trimmed output. A missing binary is exit code 127. */
export const runCommand: CommandRunner = async (command) => {
  let child;
  try {
    child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { exitCode: 127, stdout: "", stderr: `command not found: ${command[0] ?? ""}` };
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
};

export async function requireSuccess(
  run: CommandRunner,
  command: readonly string[],
  description: string,
): Promise<CommandResult> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
  return result;
}
