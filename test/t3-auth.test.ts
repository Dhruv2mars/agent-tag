import { describe, expect, test } from "bun:test";

import { SecretString } from "../src/security/secret-file.ts";
import {
  assertRestrictedOrchestrationSession,
  inspectT3Session,
  isT3CredentialRejection,
  T3HttpError,
} from "../src/t3/auth.ts";

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

  test("tells a rejected token apart from an unavailable T3", async () => {
    const statuses = [401, 403, 503];
    let next = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: statuses[next++] ?? 500 }) });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const token = new SecretString("canary-token");
      const errors: unknown[] = [];
      for (const _status of statuses) errors.push(await inspectT3Session({ baseUrl, token }).catch((error: unknown) => error));
      expect(errors.map((error) => (error instanceof T3HttpError ? error.status : undefined))).toEqual(statuses);
      expect(errors.map(isT3CredentialRejection)).toEqual([true, true, false]);
      expect(String(errors[0])).not.toContain("canary-token");
      expect(isT3CredentialRejection(new Error("T3 session endpoint returned HTTP 401"))).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
