import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createReadlinePrompter } from "../src/prompt.ts";

/** A fake terminal: readline treats the input as a TTY, so arrow keys recall history. */
function fakeTerminal(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream; written: () => string } {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  let written = "";
  (output as unknown as PassThrough).on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe("readline prompter", () => {
  test("never recalls a hidden secret from history at a later visible prompt", async () => {
    const terminal = fakeTerminal();
    const prompter = createReadlinePrompter(terminal.input, terminal.output);
    try {
      const secret = prompter.secret("Slack bot token");
      terminal.input.write("xoxb-secret-token\r");
      expect(await secret).toBe("xoxb-secret-token");

      const answer = prompter.ask("Workspace name");
      terminal.input.write("\x1b[A\r");
      expect(await answer).toBe("");
      expect(terminal.written()).not.toContain("xoxb-secret-token");
    } finally {
      prompter.close();
    }
  });
});
