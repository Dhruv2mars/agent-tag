import { z } from "zod";

/** The only T3 orchestration wire protocol this build speaks. */
export const SUPPORTED_T3_ORCHESTRATION_PROTOCOL = 1;
const SUPPORTED_T3_RANGE = "T3 0.0.42–0.0.45";

const environmentDescriptorSchema = z.object({
  // T3 documents a missing value as protocol 1 (0.0.42 omits it; 0.0.45 sends 1).
  orchestrationProtocolVersion: z.number().int().positive().optional(),
});

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

/** Reads the unauthenticated environment descriptor and returns its orchestration protocol. */
export async function fetchT3OrchestrationProtocol(input: {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const response = await fetch(new URL("/.well-known/t3/environment", input.baseUrl), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: input.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`T3 environment endpoint returned HTTP ${response.status}`);
  const descriptor = environmentDescriptorSchema.parse(await response.json());
  return descriptor.orchestrationProtocolVersion ?? 1;
}

/** Fails closed unless the T3 server speaks the orchestration protocol this build supports. */
export async function assertSupportedT3Protocol(input: {
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const protocol = await fetchT3OrchestrationProtocol(input);
  if (protocol !== SUPPORTED_T3_ORCHESTRATION_PROTOCOL) throw new T3ProtocolMismatchError(protocol);
  return protocol;
}
