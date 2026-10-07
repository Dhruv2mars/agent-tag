export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

/**
 * Parses `--name value`, `--name=value`, and boolean `--flag` arguments. Only names in `booleans`
 * are treated as flags; every other `--name` requires a value. Unknown names are rejected.
 */
export function parseArguments(
  argv: readonly string[],
  spec: { readonly booleans: readonly string[]; readonly values: readonly string[] },
): ParsedArguments {
  const booleans = new Set(spec.booleans);
  const valueNames = new Set(spec.values);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (booleans.has(name)) {
      if (separator !== -1) throw new Error(`--${name} does not take a value`);
      flags.add(name);
    } else if (valueNames.has(name)) {
      const value = separator === -1 ? argv[(index += 1)] : argument.slice(separator + 1);
      if (value === undefined || (separator === -1 && value.startsWith("--"))) {
        throw new Error(`--${name} requires a value`);
      }
      values.set(name, value);
    } else {
      throw new Error(`unknown option --${name}`);
    }
  }
  return { positionals, values, flags };
}
