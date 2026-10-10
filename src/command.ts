export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  /** Kills the command (SIGKILL) when aborted; the result then has the signal's exit code. */
  readonly signal?: AbortSignal;
}

export type CommandRunner = (command: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

/** Runs a command without a shell and captures trimmed output. A missing binary is exit code 127. */
export const runCommand: CommandRunner = async (command, options) => {
  if (options?.signal?.aborted) return { exitCode: 130, stdout: "", stderr: "aborted before start" };
  let child;
  try {
    child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { exitCode: 127, stdout: "", stderr: `command not found: ${command[0] ?? ""}` };
  }
  const kill = () => child.kill("SIGKILL");
  options?.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    options?.signal?.removeEventListener("abort", kill);
  }
};

export async function requireSuccess(
  run: CommandRunner,
  command: readonly string[],
  description: string,
): Promise<CommandResult> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    // Tools such as `agent-tag doctor` report failures on stdout, so keep both streams in the error.
    const output = [result.stderr, result.stdout].filter((text) => text.length > 0).join("\n");
    throw new Error(`${description} failed with exit code ${result.exitCode}: ${output}`);
  }
  return result;
}
