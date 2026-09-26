import { isAbsolute } from "node:path";

import { z } from "zod";

import { createSecretFile, readSecretFile } from "../src/security/secret-file.ts";
import {
  assertRestrictedOrchestrationSession,
  expectAdministrativeAccessDenied,
  inspectT3Session,
  mintRestrictedT3Token,
} from "../src/t3/auth.ts";

const argumentsSchema = z.object({
  baseUrl: z.url(),
  adminTokenFile: z.string().refine(isAbsolute),
  output: z.string().refine(isAbsolute),
});

function parseArguments(argv: string[]): z.infer<typeof argumentsSchema> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("usage: enroll-t3 --base-url URL --admin-token-file PATH --output PATH");
    }
    values.set(key.slice(2), value);
  }
  return argumentsSchema.parse({
    baseUrl: values.get("base-url"),
    adminTokenFile: values.get("admin-token-file"),
    output: values.get("output"),
  });
}

const args = parseArguments(Bun.argv.slice(2));
const administrativeToken = await readSecretFile(args.adminTokenFile);
const token = await mintRestrictedT3Token({
  baseUrl: args.baseUrl,
  administrativeToken,
  label: "Agent Tag",
});
const session = await inspectT3Session({ baseUrl: args.baseUrl, token });
assertRestrictedOrchestrationSession(session);
await expectAdministrativeAccessDenied({ baseUrl: args.baseUrl, token });
await createSecretFile({ path: args.output, secret: token });
await Bun.write(Bun.stdout, `wrote restricted T3 credential to ${args.output}\n`);
