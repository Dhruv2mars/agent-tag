import { afterEach, describe, expect, test } from "bun:test";

import { checkT3Environment } from "../src/doctor.ts";
import { SecretString } from "../src/security/secret-file.ts";
import { issueT3WebSocketUrl } from "../src/t3/auth.ts";
import { inspectT3 } from "../src/t3/gateway.ts";
import { assertSupportedT3Protocol, T3ProtocolMismatchError } from "../src/t3/protocol.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fakeT3(descriptor: (() => Response) | undefined): { readonly baseUrl: string; readonly paths: string[] } {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      paths.push(url.pathname);
      if (url.pathname === "/.well-known/t3/environment" && descriptor !== undefined) return descriptor();
      if (url.pathname === "/api/auth/websocket-ticket") {
        return Response.json({ ticket: "ticket-1", expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, paths };
}

const environment = { environmentId: "env-1", label: "fixture", serverVersion: "0.0.45", capabilities: {} };

describe("T3 orchestration protocol gate", () => {
  test("treats a descriptor without a protocol version as protocol 1 (T3 0.0.42)", async () => {
    const t3 = fakeT3(() => Response.json(environment));
    expect(await assertSupportedT3Protocol({ baseUrl: t3.baseUrl })).toBe(1);
  });

  test("accepts an explicit protocol 1 (T3 0.0.45)", async () => {
    const t3 = fakeT3(() => Response.json({ ...environment, orchestrationProtocolVersion: 1 }));
    expect(await assertSupportedT3Protocol({ baseUrl: t3.baseUrl })).toBe(1);
  });

  test("fails closed with an operator-readable message on another protocol", async () => {
    const t3 = fakeT3(() => Response.json({ ...environment, orchestrationProtocolVersion: 2 }));
    const failure = assertSupportedT3Protocol({ baseUrl: t3.baseUrl });
    await expect(failure).rejects.toBeInstanceOf(T3ProtocolMismatchError);
    await expect(failure).rejects.toThrow(
      "T3 server speaks orchestration protocol 2; this Agent Tag build supports protocol 1 (T3 0.0.42–0.0.45)",
    );
  });

  test("fails closed when the environment descriptor is unavailable", async () => {
    const t3 = fakeT3(undefined);
    await expect(assertSupportedT3Protocol({ baseUrl: t3.baseUrl })).rejects.toThrow(
      "T3 environment endpoint returned HTTP 404",
    );
  });

  test("doctor and onboarding accept exactly the servers the runtime gate accepts", async () => {
    const cases: [string, (() => Response) | undefined][] = [
      ["protocol omitted", () => Response.json(environment)],
      ["protocol 1", () => Response.json({ ...environment, orchestrationProtocolVersion: 1 })],
      ["protocol 2", () => Response.json({ ...environment, orchestrationProtocolVersion: 2 })],
      ["malformed protocol", () => Response.json({ ...environment, orchestrationProtocolVersion: "one" })],
      ["not json", () => new Response("<html></html>", { status: 200 })],
      ["legacy 404", undefined],
      ["server error", () => new Response("boom", { status: 500 })],
    ];
    for (const [name, descriptor] of cases) {
      const t3 = fakeT3(descriptor);
      const runtimeAccepts = await assertSupportedT3Protocol({ baseUrl: t3.baseUrl }).then(
        () => true,
        () => false,
      );
      const { check } = await checkT3Environment({ t3: { baseUrl: t3.baseUrl } }, { fetch });
      expect({ name, accepted: check.status !== "fail" }).toEqual({ name, accepted: runtimeAccepts });
    }
  });

  test("startup and doctor probing stop before presenting the token to an incompatible server", async () => {
    const t3 = fakeT3(() => Response.json({ ...environment, orchestrationProtocolVersion: 2 }));
    await expect(inspectT3({ baseUrl: t3.baseUrl, tokenFile: "/nonexistent/agent-tag-token" })).rejects.toBeInstanceOf(
      T3ProtocolMismatchError,
    );
    expect(t3.paths).toEqual(["/.well-known/t3/environment"]);
  });

  test("advertises protocol 1 on the WebSocket URL", async () => {
    const t3 = fakeT3(undefined);
    const url = new URL(await issueT3WebSocketUrl({ baseUrl: t3.baseUrl, token: new SecretString("fixture-token") }));
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("orchestrationProtocol")).toBe("1");
  });
});
