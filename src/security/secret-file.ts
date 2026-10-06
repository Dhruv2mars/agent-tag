import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (value.trim().length === 0) throw new Error("secret must not be empty");
    this.#value = value.trim();
  }

  exposeToBoundary(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`secret parent is not a directory: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`secret parent must not grant group or world access: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`secret parent must be owned by the Agent Tag user: ${path}`);
  }
}

export async function readSecretFile(path: string): Promise<SecretString> {
  await assertPrivateDirectory(dirname(path));
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`secret path is not a regular file: ${path}`);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`secret file must use mode 0600 or stricter: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`secret file must be owned by the Agent Tag user: ${path}`);
  }
  return new SecretString(await Bun.file(path).text());
}

export async function createSecretFile(input: {
  readonly path: string;
  readonly secret: SecretString;
}): Promise<void> {
  await assertPrivateDirectory(dirname(input.path));
  const file = await open(input.path, "wx", 0o600);
  try {
    await file.writeFile(`${input.secret.exposeToBoundary()}\n`, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }
}
