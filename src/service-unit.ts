import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isCompiledEntrypoint } from "./version.ts";

/**
 * What a generated service unit executes. A source checkout runs `bun run <checkout>/src/cli.ts`; a
 * release binary installed by install.sh carries its own Bun runtime and has no `src/cli.ts`.
 */
export type ServiceProgram =
  | { readonly kind: "source"; readonly bunPath: string; readonly cliPath: string }
  | { readonly kind: "binary"; readonly binaryPath: string };

/** Absolute paths a generated service unit (plist or systemd unit) runs with. */
export interface ServiceUnitPaths {
  readonly program: ServiceProgram;
  readonly configPath: string;
  /** The checkout root for a source program; the config's directory for a binary. */
  readonly workingDirectory: string;
}

/** `[bun, "run", cli, command, config]` for a checkout, `[binary, command, config]` for a release binary. */
export function serviceProgramArguments(program: ServiceProgram, command: "run" | "doctor", configPath: string): string[] {
  return program.kind === "binary"
    ? [program.binaryPath, command, configPath]
    : [program.bunPath, "run", program.cliPath, command, configPath];
}

/** Every filesystem path the program refers to, for absolute-path validation. */
export function serviceProgramPaths(program: ServiceProgram): string[] {
  return program.kind === "binary" ? [program.binaryPath] : [program.bunPath, program.cliPath];
}

/** Chooses the service program for this process: the compiled binary itself, or Bun plus this checkout's CLI. */
export function serviceProgramFor(input: {
  readonly mainPath: string;
  readonly execPath: string;
  readonly sourceRoot: string;
}): ServiceProgram {
  if (isCompiledEntrypoint(input.mainPath)) return { kind: "binary", binaryPath: input.execPath };
  return { kind: "source", bunPath: input.execPath, cliPath: join(input.sourceRoot, "src", "cli.ts") };
}

/** The unit paths this process would install for `configPath` (already resolved and validated). */
export async function currentServiceUnitPaths(configPath: string): Promise<ServiceUnitPaths> {
  const sourceRoot = resolve(import.meta.dir, "..");
  const program = serviceProgramFor({ mainPath: Bun.main, execPath: process.execPath, sourceRoot });
  if (program.kind === "binary") {
    // Resolve symlinks so the unit names the file `agent-tag update` replaces, however it was invoked.
    return { program: { kind: "binary", binaryPath: await realpath(program.binaryPath) }, configPath, workingDirectory: dirname(configPath) };
  }
  if (!(await Bun.file(program.cliPath).exists())) {
    throw new Error(`cannot find ${program.cliPath}; install the service from a source checkout or the agent-tag release binary`);
  }
  return { program, configPath, workingDirectory: sourceRoot };
}

export interface ServiceUnitState {
  readonly unitPath: string;
  readonly installed: boolean;
  /** The installed unit is byte-identical to what this process would generate now. */
  readonly current: boolean;
  /** The installed unit runs the same config path. */
  readonly sameConfig: boolean;
  /**
   * The installed unit runs this install: the same checkout's `src/cli.ts` from the same checkout root,
   * or the same release binary. A checkout and a binary are never the same install.
   */
  readonly sameCheckout: boolean;
  /** The installed unit runs the same Bun executable (for a binary, the same binary) as this process. */
  readonly sameBun: boolean;
  /** Working directory (checkout root) of an installed source unit, when it could be read. */
  readonly installedCheckout?: string;
  /** Release binary an installed binary unit runs. */
  readonly installedBinary?: string;
  /** Bun executable an installed source unit runs. */
  readonly installedBunPath?: string;
}

export const NOT_INSTALLED = {
  installed: false,
  current: false,
  sameConfig: false,
  sameCheckout: false,
  sameBun: false,
} as const;

/** Reads the program, config, and working directory back out of an installed unit's argument vector. */
export function installedUnitPaths(
  programArguments: readonly string[],
  workingDirectory: string | undefined,
): Partial<ServiceUnitPaths> {
  const [executable, second, third, fourth, fifth] = programArguments;
  let program: ServiceProgram | undefined;
  let configPath: string | undefined;
  if (programArguments.length === 5 && executable !== undefined && second === "run" && third !== undefined && fourth === "run") {
    program = { kind: "source", bunPath: executable, cliPath: third };
    configPath = fifth;
  } else if (programArguments.length === 3 && executable !== undefined && second === "run") {
    program = { kind: "binary", binaryPath: executable };
    configPath = third;
  }
  return {
    ...(program === undefined ? {} : { program }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

function executableOf(program: ServiceProgram): string {
  return program.kind === "binary" ? program.binaryPath : program.bunPath;
}

function sameInstall(installed: Partial<ServiceUnitPaths>, expected: ServiceUnitPaths): boolean {
  const program = installed.program;
  if (program === undefined || program.kind !== expected.program.kind) return false;
  if (program.kind === "binary" || expected.program.kind === "binary") return executableOf(program) === executableOf(expected.program);
  return program.cliPath === expected.program.cliPath && installed.workingDirectory === expected.workingDirectory;
}

/** Classifies an installed unit against the one this process would render. */
export function unitStateFor(input: {
  readonly unitPath: string;
  readonly existing: string;
  readonly rendered: string;
  readonly installed: Partial<ServiceUnitPaths>;
  readonly expected: ServiceUnitPaths;
}): ServiceUnitState {
  const { installed, expected } = input;
  const program = installed.program;
  return {
    unitPath: input.unitPath,
    installed: true,
    current: input.existing === input.rendered,
    sameConfig: installed.configPath === expected.configPath,
    sameCheckout: sameInstall(installed, expected),
    sameBun: program !== undefined && program.kind === expected.program.kind && executableOf(program) === executableOf(expected.program),
    ...(program?.kind !== "binary" && installed.workingDirectory !== undefined ? { installedCheckout: installed.workingDirectory } : {}),
    ...(program?.kind === "binary" ? { installedBinary: program.binaryPath } : {}),
    ...(program?.kind === "source" ? { installedBunPath: program.bunPath } : {}),
  };
}

/** Names the install an existing unit runs, for operator-facing messages. */
export function describeInstalledProgram(unit: ServiceUnitState): string {
  if (unit.installedBinary !== undefined) return `binary ${unit.installedBinary}`;
  if (unit.installedCheckout !== undefined) return `checkout ${unit.installedCheckout}`;
  return "unrecognized unit";
}
