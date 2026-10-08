/**
 * Classifies a failed `orchestration.dispatchCommand` call.
 *
 * T3 0.0.45 maps every dispatch failure to `OrchestrationDispatchCommandError { message }` on the
 * wire. Our RPC client decodes errors as `Schema.Unknown`, so `Effect.runPromise` rejects with that
 * plain tagged object, not an `Error`. The message carries the server-side cause:
 *
 * - `Orchestration command invariant failed (<type>): ...` for a missing thread or project, an
 *   answered or no-longer-pending question, and similar state checks,
 * - `Command previously rejected (<id>): ...` when the same command id was rejected before,
 * - `Invalid orchestration command payload: ...` / `Invalid orchestration command JSON: ...`,
 * - `Command id '...' already used for ...`,
 * - provider-side request errors such as `Unknown pending approval request` or
 *   `stale pending approval request`.
 *
 * Those are rejections: T3 will give the same answer every time, so retrying only hammers it. Other
 * dispatch failures (storage or listener errors, transport loss, authorization lookups) may clear up
 * and are retried with backoff by the caller.
 */
export type T3DispatchErrorClass =
  | { readonly kind: "rejected"; readonly code: "T3CommandRejected" }
  | { readonly kind: "transient"; readonly code: string };

const DISPATCH_ERROR_TAG = "OrchestrationDispatchCommandError";

const REJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /invariant failed/i,
  /previously rejected/i,
  /invalid orchestration command/i,
  /already used for/i,
  /does not exist/i,
  /no longer pending/i,
  /already (?:been )?(?:answered|resolved|archived)/i,
  /(?:unknown|stale) pending/i,
  /not running/i,
  /no active turn/i,
  /still needs attention/i,
  /validation/i,
];

function taggedFields(error: unknown): { readonly tag: string; readonly message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const tag: unknown = Reflect.get(error, "_tag");
  if (typeof tag !== "string" || tag.length === 0) return null;
  const message: unknown = Reflect.get(error, "message");
  return { tag, message: typeof message === "string" ? message : "" };
}

/** Returns a stable error code for storage and audit. Never returns T3's message text. */
export function classifyT3DispatchError(error: unknown): T3DispatchErrorClass {
  const tagged = taggedFields(error);
  if (tagged !== null) {
    if (tagged.tag === DISPATCH_ERROR_TAG && REJECTION_PATTERNS.some((pattern) => pattern.test(tagged.message))) {
      return { kind: "rejected", code: "T3CommandRejected" };
    }
    return { kind: "transient", code: tagged.tag === DISPATCH_ERROR_TAG ? "T3DispatchFailed" : tagged.tag };
  }
  if (error instanceof Error && error.name) return { kind: "transient", code: error.name };
  return { kind: "transient", code: "InteractionDispatchError" };
}
