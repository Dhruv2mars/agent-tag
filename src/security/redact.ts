import { KNOWN_CREDENTIAL_PATTERNS } from "./secret-scan.ts";

const globalCredentialPatterns = KNOWN_CREDENTIAL_PATTERNS.map((pattern) => ({
  name: pattern.name,
  expression: new RegExp(pattern.expression.source, "g"),
}));

/** Replaces every known credential shape with a class-labelled marker. Never returns the matched value. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of globalCredentialPatterns) {
    redacted = redacted.replace(pattern.expression, `[REDACTED:${pattern.name}]`);
  }
  return redacted;
}

export function containsKnownSecret(text: string): boolean {
  return KNOWN_CREDENTIAL_PATTERNS.some((pattern) => pattern.expression.test(text));
}

export function knownSecretClasses(text: string): ReadonlyArray<string> {
  return KNOWN_CREDENTIAL_PATTERNS.filter((pattern) => pattern.expression.test(text)).map(
    (pattern) => pattern.name,
  );
}

export function redactAuditMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, string | number | boolean | null> {
  const redacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return redacted;
}
