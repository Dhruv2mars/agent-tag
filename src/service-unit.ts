/** Absolute paths a generated service unit (plist or systemd unit) runs with. */
export interface ServiceUnitPaths {
  readonly bunPath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly workingDirectory: string;
}

export interface ServiceUnitState {
  readonly unitPath: string;
  readonly installed: boolean;
  /** The installed unit is byte-identical to what this checkout would generate now. */
  readonly current: boolean;
  /** The installed unit runs the same config path. */
  readonly sameConfig: boolean;
  /** The installed unit runs this checkout's `src/cli.ts` from this checkout's root. */
  readonly sameCheckout: boolean;
  /** The installed unit runs the same Bun executable as this process. */
  readonly sameBun: boolean;
  /** Working directory (checkout root) the installed unit runs from, when it could be read. */
  readonly installedCheckout?: string;
  /** Bun executable the installed unit runs, when it could be read. */
  readonly installedBunPath?: string;
}

export const NOT_INSTALLED = {
  installed: false,
  current: false,
  sameConfig: false,
  sameCheckout: false,
  sameBun: false,
} as const;

/** Reads `[bun, "run", cli, "run", config]` back out of an installed unit's argument vector. */
export function installedUnitPaths(
  programArguments: readonly string[],
  workingDirectory: string | undefined,
): Partial<ServiceUnitPaths> {
  const [bunPath, run, cliPath, command, configPath] = programArguments;
  const shaped = programArguments.length === 5 && run === "run" && command === "run";
  return {
    ...(bunPath === undefined ? {} : { bunPath }),
    ...(shaped && cliPath !== undefined ? { cliPath } : {}),
    ...(shaped && configPath !== undefined ? { configPath } : {}),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

/** Classifies an installed unit against the one this checkout would render. */
export function unitStateFor(input: {
  readonly unitPath: string;
  readonly existing: string;
  readonly rendered: string;
  readonly installed: Partial<ServiceUnitPaths>;
  readonly expected: ServiceUnitPaths;
}): ServiceUnitState {
  const { installed, expected } = input;
  return {
    unitPath: input.unitPath,
    installed: true,
    current: input.existing === input.rendered,
    sameConfig: installed.configPath === expected.configPath,
    sameCheckout: installed.cliPath === expected.cliPath && installed.workingDirectory === expected.workingDirectory,
    sameBun: installed.bunPath === expected.bunPath,
    ...(installed.workingDirectory === undefined ? {} : { installedCheckout: installed.workingDirectory }),
    ...(installed.bunPath === undefined ? {} : { installedBunPath: installed.bunPath }),
  };
}
