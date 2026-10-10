import { describe, expect, test } from "bun:test";

import { SecretString } from "../src/security/secret-file.ts";
import {
  assertRestrictedOrchestrationSession,
  inspectT3Session,
  isT3CredentialRejection,
  listT3AuthClients,
  revokeT3AuthClient,
  T3HttpError,
  T3UnauthenticatedSessionError,
} from "../src/t3/auth.ts";

async function withT3Server<T>(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  try {
    return await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
  }
}

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

describe("T3 session and client administration", () => {
  const token = new SecretString("restricted-canary");
  const administrativeToken = new SecretString("admin-canary");

  test("an authenticated:false 200 session is a credential rejection with status 401", async () => {
    await withT3Server(() => Response.json({ authenticated: false }), async (baseUrl) => {
      const error = await inspectT3Session({ baseUrl, token }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(T3UnauthenticatedSessionError);
      expect(isT3CredentialRejection(error)).toBe(true);
      expect((error as T3HttpError).status).toBe(401);
    });
  });

  test("listT3AuthClients returns the parsed client array", async () => {
    const clients = [
      {
        sessionId: "s1",
        scopes: ["orchestration:read"],
        expiresAt: "2026-11-01T00:00:00.000Z",
        current: false,
        client: { label: "x", deviceType: "bot" },
      },
    ];
    await withT3Server(() => Response.json(clients), async (baseUrl) => {
      expect(await listT3AuthClients({ baseUrl, administrativeToken })).toEqual(clients);
    });
  });

  test("listT3AuthClients reports a non-array or non-JSON body as undefined", async () => {
    for (const body of [JSON.stringify({ clients: [] }), "not json"]) {
      await withT3Server(() => new Response(body), async (baseUrl) => {
        expect(await listT3AuthClients({ baseUrl, administrativeToken })).toBeUndefined();
      });
    }
  });

  test("listT3AuthClients throws T3HttpError with status 403 when the admin token is denied", async () => {
    await withT3Server(() => new Response("no", { status: 403 }), async (baseUrl) => {
      const error = await listT3AuthClients({ baseUrl, administrativeToken }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(T3HttpError);
      expect((error as T3HttpError).status).toBe(403);
      expect(isT3CredentialRejection(error)).toBe(true);
    });
  });

  test("revokeT3AuthClient posts the session id with the administrative bearer", async () => {
    const requests: Array<{
      readonly method: string;
      readonly pathname: string;
      readonly authorization: string | null;
      readonly contentType: string | null;
      readonly body: unknown;
    }> = [];
    await withT3Server(
      async (request) => {
        requests.push({
          method: request.method,
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
          body: await request.json(),
        });
        return Response.json({ revoked: true });
      },
      async (baseUrl) => {
        expect(await revokeT3AuthClient({ baseUrl, administrativeToken, sessionId: "s1" })).toBe(true);
      },
    );
    expect(requests).toEqual([
      {
        method: "POST",
        pathname: "/api/auth/clients/revoke",
        authorization: "Bearer admin-canary",
        contentType: "application/json",
        body: { sessionId: "s1" },
      },
    ]);
  });

  test("revokeT3AuthClient returns false when T3 does not confirm the revoke", async () => {
    await withT3Server(() => Response.json({ revoked: false }), async (baseUrl) => {
      expect(await revokeT3AuthClient({ baseUrl, administrativeToken, sessionId: "s1" })).toBe(false);
    });
  });

  test("revokeT3AuthClient throws T3HttpError on a server error", async () => {
    await withT3Server(() => new Response("boom", { status: 500 }), async (baseUrl) => {
      const error = await revokeT3AuthClient({ baseUrl, administrativeToken, sessionId: "s1" }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(T3HttpError);
      expect((error as T3HttpError).status).toBe(500);
    });
  });
});
