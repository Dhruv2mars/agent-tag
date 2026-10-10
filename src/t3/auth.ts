import { z } from "zod";

import { SecretString } from "../security/secret-file.ts";
import { SUPPORTED_T3_ORCHESTRATION_PROTOCOL } from "./protocol.ts";

export const REQUIRED_T3_SCOPES: readonly ["orchestration:read", "orchestration:operate"] = [
  "orchestration:read",
  "orchestration:operate",
];

const scopeSchema = z.enum([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
]);

const sessionSchema = z.object({
  authenticated: z.literal(true),
  scopes: z.array(scopeSchema),
  sessionMethod: z.enum(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  expiresAt: z.iso.datetime(),
});

const pairingCredentialSchema = z.object({
  id: z.string().min(1),
  credential: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.literal("urn:ietf:params:oauth:token-type:access_token"),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive(),
  scope: z.string().min(1),
});

const webSocketTicketSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export type T3Session = z.infer<typeof sessionSchema>;

/** A non-2xx answer from T3. `status` lets callers tell a rejected credential from an outage. */
export class T3HttpError extends Error {
  readonly status: number;

  constructor(endpoint: string, status: number) {
    super(`T3 ${endpoint} endpoint returned HTTP ${status}`);
    this.name = "T3HttpError";
    this.status = status;
  }
}

/**
 * `GET /api/auth/session` answers HTTP 200 `{authenticated:false}` for a revoked or expired bearer
 * (confirmed live on 0.0.45), so that answer is a credential rejection like a 401.
 */
export class T3UnauthenticatedSessionError extends T3HttpError {
  constructor() {
    super("session", 401);
    this.name = "T3UnauthenticatedSessionError";
    this.message = "T3 session endpoint reports the token is not authenticated (revoked or expired)";
  }
}

/** True when T3 answered and refused the credential itself (as opposed to being unreachable). */
export function isT3CredentialRejection(error: unknown): error is T3HttpError {
  return error instanceof T3HttpError && (error.status === 401 || error.status === 403);
}

async function parseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

function bearerHeaders(token: SecretString): HeadersInit {
  return { authorization: `Bearer ${token.exposeToBoundary()}` };
}

export async function inspectT3Session(input: {
  readonly baseUrl: string;
  readonly token: SecretString;
  readonly signal?: AbortSignal;
}): Promise<T3Session> {
  const response = await fetch(new URL("/api/auth/session", input.baseUrl), {
    headers: bearerHeaders(input.token),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new T3HttpError("session", response.status);
  const body = await parseJson(response);
  if (typeof body === "object" && body !== null && (body as { authenticated?: unknown }).authenticated === false) {
    throw new T3UnauthenticatedSessionError();
  }
  return sessionSchema.parse(body);
}

export function assertRestrictedOrchestrationSession(session: T3Session): void {
  const actual = new Set(session.scopes);
  const required = new Set<string>(REQUIRED_T3_SCOPES);
  const missing = REQUIRED_T3_SCOPES.filter((scope) => !actual.has(scope));
  const extra = session.scopes.filter((scope) => !required.has(scope));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `T3 token scopes must be exactly ${REQUIRED_T3_SCOPES.join(" ")}; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`,
    );
  }
  if (session.sessionMethod !== "bearer-access-token") {
    throw new Error(`T3 token must use bearer-access-token, received ${session.sessionMethod}`);
  }
}

export async function mintRestrictedT3Token(input: {
  readonly baseUrl: string;
  readonly administrativeToken: SecretString;
  readonly label: string;
  readonly signal?: AbortSignal;
}): Promise<SecretString> {
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const pairingResponse = await fetch(new URL("/api/auth/pairing-token", input.baseUrl), {
    method: "POST",
    headers: { ...bearerHeaders(input.administrativeToken), "content-type": "application/json" },
    body: JSON.stringify({ label: input.label, scopes: REQUIRED_T3_SCOPES }),
    ...signal,
  });
  if (!pairingResponse.ok) {
    throw new Error(`T3 pairing endpoint returned HTTP ${pairingResponse.status}`);
  }
  const pairing = pairingCredentialSchema.parse(await parseJson(pairingResponse));
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: pairing.credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: REQUIRED_T3_SCOPES.join(" "),
    client_label: input.label,
    client_device_type: "desktop",
    client_os: process.platform === "darwin" ? "macOS" : process.platform,
  });
  const tokenResponse = await fetch(new URL("/oauth/token", input.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    ...signal,
  });
  if (!tokenResponse.ok) throw new Error(`T3 token endpoint returned HTTP ${tokenResponse.status}`);
  const token = accessTokenSchema.parse(await parseJson(tokenResponse));
  if (token.scope.split(" ").sort().join(" ") !== [...REQUIRED_T3_SCOPES].sort().join(" ")) {
    throw new Error("T3 issued a token with unexpected scopes");
  }
  return new SecretString(token.access_token);
}

export async function issueT3WebSocketUrl(input: {
  readonly baseUrl: string;
  readonly token: SecretString;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", input.baseUrl), {
    method: "POST",
    headers: bearerHeaders(input.token),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new T3HttpError("WebSocket ticket", response.status);
  const issued = webSocketTicketSchema.parse(await parseJson(response));
  const url = new URL("/ws", input.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", issued.ticket);
  url.searchParams.set("clientSurface", "cli");
  url.searchParams.set("clientAppVersion", "agent-tag/0.0.0");
  url.searchParams.set("clientDeviceType", "desktop");
  url.searchParams.set("clientOs", process.platform === "darwin" ? "macOS" : "Linux");
  url.searchParams.set("connectionMethod", "direct");
  // Ignored by protocol-1 servers; lets a future protocol-2 server negotiate down instead of guessing.
  url.searchParams.set("orchestrationProtocol", String(SUPPORTED_T3_ORCHESTRATION_PROTOCOL));
  return url.toString();
}

export async function expectAdministrativeAccessDenied(input: {
  readonly baseUrl: string;
  readonly token: SecretString;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(new URL("/api/auth/clients", input.baseUrl), {
    headers: bearerHeaders(input.token),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status !== 403) {
    throw new Error(`expected T3 administrative endpoint to deny access, received ${response.status}`);
  }
}

const authClientSchema = z
  .object({
    sessionId: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    current: z.boolean().optional(),
    client: z.object({ label: z.string().optional() }).loose().optional(),
  })
  .loose();

export type T3AuthClient = z.infer<typeof authClientSchema>;

/**
 * `GET /api/auth/clients` with an administrative bearer. Live 0.0.45 returns a JSON array of
 * `{sessionId, subject, scopes, client: {label, …}, issuedAt, expiresAt, current, …}`; any other
 * shape is reported as `undefined` so callers can skip revocation instead of guessing.
 */
export async function listT3AuthClients(input: {
  readonly baseUrl: string;
  readonly administrativeToken: SecretString;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<T3AuthClient> | undefined> {
  const response = await fetch(new URL("/api/auth/clients", input.baseUrl), {
    headers: bearerHeaders(input.administrativeToken),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new T3HttpError("clients", response.status);
  const parsed = z.array(authClientSchema).safeParse(await parseJson(response).catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

/** `POST /api/auth/clients/revoke {sessionId}`; live 0.0.45 answers `{revoked: true}`. */
export async function revokeT3AuthClient(input: {
  readonly baseUrl: string;
  readonly administrativeToken: SecretString;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const response = await fetch(new URL("/api/auth/clients/revoke", input.baseUrl), {
    method: "POST",
    headers: { ...bearerHeaders(input.administrativeToken), "content-type": "application/json" },
    body: JSON.stringify({ sessionId: input.sessionId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new T3HttpError("clients/revoke", response.status);
  const body: unknown = await parseJson(response).catch(() => undefined);
  return z.object({ revoked: z.literal(true) }).loose().safeParse(body).success;
}
