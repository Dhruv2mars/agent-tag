import { describe, expect, test } from "bun:test";

import { SecretString } from "../src/security/secret-file.ts";
import { assertRestrictedOrchestrationSession } from "../src/t3/auth.ts";

describe("T3 credential policy", () => {
  test("redacts a secret during string and JSON conversion", () => {
    const secret = new SecretString("do-not-print");
    expect(String(secret)).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
  });

  test("rejects an administrative token", () => {
    expect(() =>
      assertRestrictedOrchestrationSession({
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:operate", "access:write"],
        sessionMethod: "bearer-access-token",
        expiresAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toThrow("extra=access:write");
  });
});
