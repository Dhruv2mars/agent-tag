export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  /**
   * Kills the command and everything it started (SIGKILL to its process group) when aborted; the
   * result then has the signal's exit code. With a signal the command runs in its own process group.
   */
  readonly signal?: AbortSignal;
}

export type CommandRunner = (command: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

/** How long output pipes may stay open after an abort (a descendant outside the group can hold them). */
const ABORT_PIPE_GRACE_MS = 250;

/** Runs a command without a shell and captures trimmed output. A missing binary is exit code 127. */
export const runCommand: CommandRunner = async (command, options) => {
  const signal = options?.signal;
  if (signal?.aborted) return { exitCode: 130, stdout: "", stderr: "aborted before start" };
  let child;
  try {
    child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: signal !== undefined });
  } catch {
    return { exitCode: 127, stdout: "", stderr: `command not found: ${command[0] ?? ""}` };
  }
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let onAbort = () => {};
  const abandoned = new Promise<readonly [string, string]>((resolve) => {
    onAbort = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      setTimeout(() => resolve(["", "aborted"]), ABORT_PIPE_GRACE_MS);
    };
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [exitCode, [stdout, stderr]] = await Promise.all([child.exited, signal === undefined ? output : Promise.race([output, abandoned])]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
