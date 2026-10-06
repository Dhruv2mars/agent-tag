import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

export interface Prompter {
  /** Asks for a line of text; an empty answer returns `defaultValue` when one is given. */
  readonly ask: (question: string, defaultValue?: string) => Promise<string>;
  /** Asks for a secret without echoing it. */
  readonly secret: (question: string) => Promise<string>;
  readonly confirm: (question: string, defaultValue: boolean) => Promise<boolean>;
  readonly close: () => void;
}

/** Output stream that can stop echoing keystrokes while a secret is typed. */
class MutableOutput extends Writable {
  muted = false;
  readonly #target: NodeJS.WriteStream;

  constructor(target: NodeJS.WriteStream) {
    super();
    this.#target = target;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) this.#target.write(chunk);
    callback();
  }
}

export function parseYesNo(answer: string, defaultValue: boolean): boolean | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) return defaultValue;
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return undefined;
}

/** A plain readline prompter for interactive terminals. */
export function createReadlinePrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  const mutable = new MutableOutput(output);
  const readline: Interface = createInterface({ input, output: mutable, terminal: input.isTTY === true });
  readline.on("SIGINT", () => {
    readline.close();
    output.write("\n");
    process.exit(130);
  });
  return {
    ask: async (question, defaultValue) => {
      const suffix = defaultValue === undefined || defaultValue.length === 0 ? "" : ` [${defaultValue}]`;
      const answer = (await readline.question(`${question}${suffix}: `)).trim();
      return answer.length === 0 && defaultValue !== undefined ? defaultValue : answer;
    },
    secret: async (question) => {
      output.write(`${question} (input hidden): `);
      mutable.muted = true;
      try {
        return (await readline.question("")).trim();
      } finally {
        mutable.muted = false;
        output.write("\n");
      }
    },
    confirm: async (question, defaultValue) => {
      for (;;) {
        const answer = await readline.question(`${question} ${defaultValue ? "[Y/n]" : "[y/N]"}: `);
        const parsed = parseYesNo(answer, defaultValue);
        if (parsed !== undefined) return parsed;
      }
    },
    close: () => readline.close(),
  };
}

/** A prompter that refuses to prompt; used by `--yes` and non-TTY runs. */
export function nonInteractivePrompter(): Prompter {
  const refuse = (question: string): never => {
    throw new Error(`missing required value in non-interactive mode: ${question}`);
  };
  return {
    ask: async (question, defaultValue) => defaultValue ?? refuse(question),
    secret: async (question) => refuse(question),
    confirm: async (_question, defaultValue) => defaultValue,
    close: () => {},
  };
}
