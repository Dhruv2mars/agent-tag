import { z } from "zod";

/** The only T3 orchestration wire protocol this build speaks. */
export const SUPPORTED_T3_ORCHESTRATION_PROTOCOL = 1;
export const SUPPORTED_T3_RANGE = "T3 0.0.42–0.0.45";

const environmentDescriptorSchema = z.object({
  // Informational only: a missing or malformed version never decides compatibility.
  serverVersion: z.string().min(1).optional().catch(undefined),
  // T3 documents a missing value as protocol 1 (0.0.42 omits it; 0.0.45 sends 1).
  orchestrationProtocolVersion: z.number().int().positive().optional(),
});

export interface T3EnvironmentDescriptor {
  readonly serverVersion?: string;
  readonly orchestrationProtocol: number;
}

/** The environment endpoint did not answer 2xx; T3 builds without it (before 0.0.42) are unsupported. */
export class T3EnvironmentUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`T3 environment endpoint returned HTTP ${status}`);
    this.name = "T3EnvironmentUnavailableError";
    this.status = status;
  }
}

export class T3ProtocolMismatchError extends Error {
  readonly serverProtocol: number;

  constructor(serverProtocol: number) {
    super(
      `T3 server speaks orchestration protocol ${serverProtocol}; this Agent Tag build supports protocol ${SUPPORTED_T3_ORCHESTRATION_PROTOCOL} (${SUPPORTED_T3_RANGE})`,
    );
    this.name = "T3ProtocolMismatchError";
    this.serverProtocol = serverProtocol;
  }
}

/** The environment request itself failed (connection refused, timeout, or a redirect, which is never followed). */
export class T3EnvironmentRequestError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "T3EnvironmentRequestError";
  }
}

export type EnvironmentFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The single environment probe, shared by the runtime gate, doctor, and onboarding, so they agree on the
 * request policy as well as the interpretation. Redirects are rejected (`redirect: "error"`): compatibility
 * is checked against the configured origin before any authenticated request is sent to it.
 * Throws `T3EnvironmentRequestError` when the request fails, otherwise as `readT3EnvironmentDescriptor`.
 */
export async function fetchT3EnvironmentDescriptor(input: {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
  readonly fetch?: EnvironmentFetch;
}): Promise<T3EnvironmentDescriptor> {
  const request = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(new URL("/.well-known/t3/environment", input.baseUrl), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: input.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new T3EnvironmentRequestError(error);
  }
  return readT3EnvironmentDescriptor(response);
}

/** Reads the unauthenticated environment descriptor and returns its orchestration protocol. */
export async function fetchT3OrchestrationProtocol(input: {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
}): Promise<number> {
  return (await fetchT3EnvironmentDescriptor(input)).orchestrationProtocol;
}

/**
 * The single interpretation of an environment response, shared by the runtime gate and doctor/onboarding.
 * Throws `T3EnvironmentUnavailableError` on a non-2xx status (including 404) and a parse error on a body
 * that is not a recognized descriptor.
 */
export async function readT3EnvironmentDescriptor(response: Response): Promise<T3EnvironmentDescriptor> {
  if (!response.ok) throw new T3EnvironmentUnavailableError(response.status);
  const descriptor = environmentDescriptorSchema.parse(await response.json());
  return {
    ...(descriptor.serverVersion === undefined ? {} : { serverVersion: descriptor.serverVersion }),
    orchestrationProtocol: descriptor.orchestrationProtocolVersion ?? 1,
  };
}

export function isSupportedT3Protocol(protocol: number): boolean {
  return protocol === SUPPORTED_T3_ORCHESTRATION_PROTOCOL;
}

/** Fails closed unless the T3 server speaks the orchestration protocol this build supports. */
export async function assertSupportedT3Protocol(input: {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const protocol = await fetchT3OrchestrationProtocol(input);
  if (!isSupportedT3Protocol(protocol)) throw new T3ProtocolMismatchError(protocol);
  return protocol;
}
