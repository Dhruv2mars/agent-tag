import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { z } from "zod";

import { readSecretFile, type SecretString } from "../security/secret-file.ts";
import {
  assertRestrictedOrchestrationSession,
  inspectT3Session,
  issueT3WebSocketUrl,
  T3HttpError,
} from "./auth.ts";
import { assertSupportedT3Protocol } from "./protocol.ts";

const id = z.string().trim().min(1);
const isoDateTime = z.iso.datetime();
const modelSelection = z.object({ instanceId: id, model: id });
const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const interactionMode = z.enum(["default", "plan"]);

const attachmentBase = z.object({
  id,
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
});
export const t3AttachmentSchema = z.discriminatedUnion("type", [
  attachmentBase.extend({
    type: z.literal("image"),
    mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  }),
  attachmentBase.extend({
    type: z.literal("file"),
    sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  }),
]);
export type T3Attachment = z.infer<typeof t3AttachmentSchema>;

const projectCreateCommand = z.object({
  type: z.literal("project.create"),
  commandId: id,
  projectId: id,
  title: id,
  workspaceRoot: id,
  createWorkspaceRootIfMissing: z.boolean().optional(),
  defaultModelSelection: modelSelection.nullable().optional(),
  createdAt: isoDateTime,
});

const projectDeleteCommand = z.object({
  type: z.literal("project.delete"),
  commandId: id,
  projectId: id,
  force: z.boolean().optional(),
});

const turnStartCommand = z.object({
  type: z.literal("thread.turn.start"),
  commandId: id,
  threadId: id,
  message: z.object({
    messageId: id,
    role: z.literal("user"),
    text: z.string(),
    attachments: z.array(t3AttachmentSchema).max(8),
  }),
  modelSelection: modelSelection.optional(),
  titleSeed: id.optional(),
  runtimeMode,
  interactionMode,
  bootstrap: z
    .object({
      createThread: z
        .object({
          projectId: id,
          title: id,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: z.string().nullable(),
          worktreePath: z.string().nullable(),
          createdAt: isoDateTime,
        })
        .optional(),
      prepareWorktree: z
        .object({
          projectCwd: id,
          baseBranch: id,
          branch: id.optional(),
          startFromOrigin: z.boolean().optional(),
        })
        .optional(),
      runSetupScript: z.boolean().optional(),
    })
    .optional(),
  createdAt: isoDateTime,
});

const turnInterruptCommand = z.object({
  type: z.literal("thread.turn.interrupt"),
  commandId: id,
  threadId: id,
  turnId: id.optional(),
  createdAt: isoDateTime,
});

const approvalRespondCommand = z.object({
  type: z.literal("thread.approval.respond"),
  commandId: id,
  threadId: id,
  requestId: id,
  decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
  createdAt: isoDateTime,
});

const userInputRespondCommand = z.object({
  type: z.literal("thread.user-input.respond"),
  commandId: id,
  threadId: id,
  requestId: id,
  answers: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
});

const userInputDismissCommand = z.object({
  type: z.literal("thread.user-input.dismiss"),
  commandId: id,
  threadId: id,
  requestId: id,
  createdAt: isoDateTime,
});

export const t3CommandSchema = z.discriminatedUnion("type", [
  projectCreateCommand,
  projectDeleteCommand,
  turnStartCommand,
  turnInterruptCommand,
  approvalRespondCommand,
  userInputRespondCommand,
  userInputDismissCommand,
]);
export type T3Command = z.infer<typeof t3CommandSchema>;

const providerSchema = z.object({
  instanceId: id,
  driver: id,
  enabled: z.boolean(),
  installed: z.boolean(),
  status: z.enum(["ready", "warning", "error", "disabled"]),
  auth: z.object({ status: z.enum(["authenticated", "unauthenticated", "unknown"]) }),
  models: z.array(
    z.object({
      slug: id,
      name: id,
      isDefault: z.boolean().optional(),
      capabilities: z.unknown().nullable(),
    }),
  ),
});

export const serverConfigSchema = z.object({
  environment: z.object({
    environmentId: id,
    capabilities: z.record(z.string(), z.unknown()),
  }),
  providers: z.array(providerSchema),
});

export type T3ServerInfo = z.infer<typeof serverConfigSchema>;

export const dispatchResultSchema = z.object({ sequence: z.number().int().nonnegative() });
export type T3DispatchResult = z.infer<typeof dispatchResultSchema>;

const latestTurnSchema = z
  .object({
    turnId: id,
    state: z.enum(["running", "interrupted", "completed", "error"]),
    requestedAt: isoDateTime,
    startedAt: isoDateTime.nullable(),
    completedAt: isoDateTime.nullable(),
    assistantMessageId: id.nullable(),
  })
  .nullable();

const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  turnId: id.nullable(),
  streaming: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

const activitySchema = z.object({
  id,
  tone: z.enum(["info", "tool", "approval", "error"]),
  kind: id,
  summary: id,
  payload: z.unknown(),
  turnId: id.nullable(),
  sequence: z.number().int().nonnegative().optional(),
  createdAt: isoDateTime,
});

const sessionSchema = z
  .object({
    threadId: id,
    status: z.enum(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"]),
    providerName: id.nullable(),
    providerInstanceId: id.optional(),
    runtimeMode,
    activeTurnId: id.nullable(),
    lastError: id.nullable(),
    updatedAt: isoDateTime,
  })
  .nullable();

export const threadSnapshotSchema = z.object({
  snapshotSequence: z.number().int().nonnegative(),
  thread: z.object({
    id,
    projectId: id,
    title: id,
    modelSelection,
    runtimeMode,
    interactionMode,
    branch: id.nullable(),
    worktreePath: id.nullable(),
    latestTurn: latestTurnSchema,
    messages: z.array(messageSchema),
    activities: z.array(activitySchema),
    session: sessionSchema,
  }),
});
export type T3ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

const approvalRequestPayloadSchema = z.object({
  requestId: id,
  requestKind: z.enum(["command", "file-read", "file-change", "mcp-elicitation", "permission"]).optional(),
  requestType: id.optional(),
  detail: z.string().optional(),
  appName: z.string().optional(),
  options: z
    .array(
      z.object({
        decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
        label: id,
        warning: id.optional(),
      }),
    )
    .optional(),
});

export interface T3PendingApproval {
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
  readonly detail?: string;
  readonly appName?: string;
  readonly options: ReadonlyArray<{
    readonly decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
    readonly label: string;
    readonly warning?: string;
  }>;
}

const userInputQuestionSchema = z.object({
  id,
  header: z.string(),
  question: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string().optional(),
    }),
  ),
  multiSelect: z.boolean(),
  allowCustomAnswer: z.boolean().optional(),
});

const userInputRequestPayloadSchema = z.object({
  requestId: id,
  questions: z.array(userInputQuestionSchema).min(1),
  responseMode: z.enum(["callback", "message"]).optional(),
});
const requestIdPayloadSchema = z.object({ requestId: id });

export interface T3PendingUserInput {
  readonly requestId: string;
  readonly questions: ReadonlyArray<z.infer<typeof userInputQuestionSchema>>;
  readonly dismissible: boolean;
}

function legacyRequestKind(requestType: string | undefined): T3PendingApproval["requestKind"] {
  switch (requestType) {
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permission_approval":
      return "permission";
    default:
      return "command";
  }
}

export function pendingT3Approvals(snapshot: T3ThreadSnapshot): ReadonlyArray<T3PendingApproval> {
  const pending = new Map<string, T3PendingApproval>();
  for (const activity of snapshot.thread.activities) {
    const parsed = approvalRequestPayloadSchema.safeParse(activity.payload);
    if (!parsed.success) continue;
    if (activity.kind === "approval.requested") {
      pending.set(parsed.data.requestId, {
        requestId: parsed.data.requestId,
        requestKind: parsed.data.requestKind ?? legacyRequestKind(parsed.data.requestType),
        ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
        ...(parsed.data.appName === undefined ? {} : { appName: parsed.data.appName }),
        options: (parsed.data.options ?? []).map((option) => ({
          decision: option.decision,
          label: option.label,
          ...(option.warning === undefined ? {} : { warning: option.warning }),
        })),
      });
    } else if (activity.kind === "approval.resolved") {
      pending.delete(parsed.data.requestId);
    }
  }
  return [...pending.values()];
}

export function pendingT3UserInputs(snapshot: T3ThreadSnapshot): ReadonlyArray<T3PendingUserInput> {
  const pending = new Map<string, T3PendingUserInput>();
  for (const activity of snapshot.thread.activities) {
    if (activity.kind === "user-input.requested") {
      const parsed = userInputRequestPayloadSchema.safeParse(activity.payload);
      if (!parsed.success) continue;
      pending.set(parsed.data.requestId, {
        requestId: parsed.data.requestId,
        questions: parsed.data.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
          multiSelect: question.multiSelect,
          ...(question.allowCustomAnswer === undefined
            ? {}
            : { allowCustomAnswer: question.allowCustomAnswer }),
        })),
        dismissible: parsed.data.responseMode === "message",
      });
    } else if (activity.kind === "user-input.resolved") {
      const parsed = requestIdPayloadSchema.safeParse(activity.payload);
      if (parsed.success) pending.delete(parsed.data.requestId);
    }
  }
  return [...pending.values()];
}

const messageAnswerPayloadSchema = z.object({
  requestId: id,
  responseMode: z.literal("message"),
  answers: z.record(z.string(), z.unknown()),
});

/**
 * Whether T3 has accepted one of `requestIds`' answers to a message-mode question, but the latest turn
 * does not reflect it yet, so its state must not settle the operation that asked.
 *
 * T3 (0.0.45 decider, `thread.user-input.respond`) answers such a question in one command: it appends
 * `user-input.resolved` with the answers and issues `thread.turn.start` with the answer as a user
 * message, both stamped with the answer's `createdAt`. That turn start resumes an idle session in a
 * new turn, or steers a running one; when steered, some providers open a new turn and others keep the
 * same turn id. So the latest turn reflects the answer once it was requested at or after the answer
 * (a new turn), or ended at or after it (the turn the answer steered, which was still running). A
 * latest turn that ended before the answer is the one that asked: its continuation has not started.
 * A running latest turn is never settled from, so it needs no wait here. A dismissal has no answers
 * and starts no turn. Answers to other operations' requests are ignored: their turns are not this
 * operation's to wait for.
 */
export function awaitingT3AnswerContinuation(snapshot: T3ThreadSnapshot, requestIds: ReadonlySet<string>): boolean {
  if (requestIds.size === 0) return false;
  let answeredAt: number | null = null;
  for (const activity of snapshot.thread.activities) {
    if (activity.kind !== "user-input.resolved") continue;
    const parsed = messageAnswerPayloadSchema.safeParse(activity.payload);
    if (!parsed.success || !requestIds.has(parsed.data.requestId)) continue;
    answeredAt = Math.max(answeredAt ?? 0, Date.parse(activity.createdAt));
  }
  if (answeredAt === null) return false;
  const latestTurn = snapshot.thread.latestTurn;
  if (latestTurn === null) return true;
  if (Date.parse(latestTurn.requestedAt) >= answeredAt) return false;
  if (latestTurn.state === "running") return false;
  // T3 stamps a turn's end as completedAt; when the session leaves "running" it settles the turn at
  // the session's updatedAt.
  const session = snapshot.thread.session;
  const endedAt = latestTurn.completedAt ??
    (session !== null && session.status !== "running" && session.status !== "starting" ? session.updatedAt : null);
  return endedAt === null || Date.parse(endedAt) < answeredAt;
}

export const threadStreamItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("synchronized") }),
  z.object({ kind: z.literal("snapshot"), snapshot: z.unknown() }),
  z.object({
    kind: z.literal("event"),
    event: z.object({
      sequence: z.number().int().nonnegative(),
      eventId: id,
      type: id,
      occurredAt: z.string(),
      commandId: id.nullable(),
      correlationId: id.nullable(),
      payload: z.unknown(),
    }),
  }),
]);
export type T3ThreadStreamItem = z.infer<typeof threadStreamItemSchema>;

const probeRpc = Rpc.make("server.probe", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: Schema.Unknown,
});
const configRpc = Rpc.make("server.getConfig", {
  payload: Schema.Struct({}),
  success: Schema.Unknown,
  error: Schema.Unknown,
});
const dispatchRpc = Rpc.make("orchestration.dispatchCommand", {
  payload: Schema.Unknown,
  success: Schema.Unknown,
  error: Schema.Unknown,
});
const subscribeThreadRpc = Rpc.make("orchestration.subscribeThread", {
  payload: Schema.Unknown,
  success: Schema.Unknown,
  error: Schema.Unknown,
  stream: true,
});
const attachmentUploadRpc = Rpc.make("attachments.createUploadUrl", {
  payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
});
const attachmentDeleteRpc = Rpc.make("attachments.delete", {
  payload: Schema.Unknown, error: Schema.Unknown,
});
const assetUrlRpc = Rpc.make("assets.createUrl", {
  payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown,
});
export const rpcGroup = RpcGroup.make(
  probeRpc, configRpc, dispatchRpc, subscribeThreadRpc, attachmentUploadRpc, attachmentDeleteRpc, assetUrlRpc,
);

export interface T3ConnectionConfig {
  readonly baseUrl: string;
  readonly tokenFile: string;
}

function signalOption(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function socketUrl(config: T3ConnectionConfig, signal?: AbortSignal): Promise<string> {
  const token = await readSecretFile(config.tokenFile);
  const session = await inspectT3Session({ baseUrl: config.baseUrl, token, ...signalOption(signal) });
  assertRestrictedOrchestrationSession(session);
  return issueT3WebSocketUrl({ baseUrl: config.baseUrl, token, ...signalOption(signal) });
}

/**
 * Runs a scoped RPC program. Aborting `signal` interrupts the fiber, which closes the scoped
 * WebSocket instead of leaving it open until T3 replies.
 */
function runRpc<A, E>(program: Effect.Effect<A, E>, signal: AbortSignal | undefined): Promise<A> {
  return Effect.runPromise(program, signalOption(signal));
}

export function protocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url, { openTimeout: "10 seconds" }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.merge(socketLayer, RpcSerialization.layerJson)),
  );
}

/**
 * Startup and doctor probe. Gates on the unauthenticated environment descriptor first so an
 * incompatible T3 fails closed with a clear protocol message before any token is presented.
 */
export async function inspectT3(
  config: T3ConnectionConfig,
  signal?: AbortSignal,
): Promise<T3ServerInfo & { readonly orchestrationProtocol: number }> {
  const orchestrationProtocol = await assertSupportedT3Protocol({ baseUrl: config.baseUrl, ...signalOption(signal) });
  const url = await socketUrl(config, signal);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    yield* client["server.probe"]({});
    const raw = yield* client["server.getConfig"]({});
    return serverConfigSchema.parse(raw);
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  return { ...(await runRpc(program, signal)), orchestrationProtocol };
}

/**
 * Dispatches one orchestration command. Aborting `signal` interrupts the RPC and closes its socket;
 * the command may or may not have reached T3, which is safe because T3 deduplicates by the stable
 * `commandId`, so the caller can replay the same command after restart.
 */
export async function dispatchT3Command(input: {
  readonly config: T3ConnectionConfig;
  readonly command: T3Command;
  readonly signal?: AbortSignal;
}): Promise<T3DispatchResult> {
  const url = await socketUrl(input.config, input.signal);
  const command = t3CommandSchema.parse(input.command);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    const raw = yield* client["orchestration.dispatchCommand"](command);
    return dispatchResultSchema.parse(raw);
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  return runRpc(program, input.signal);
}

/** T3 answered the snapshot request with HTTP 404: the thread does not exist. */
export class T3ThreadNotFoundError extends Error {
  constructor(readonly threadId: string) {
    super("T3 thread snapshot endpoint returned HTTP 404");
    this.name = "T3ThreadNotFoundError";
  }
}

export async function fetchT3ThreadSnapshot(input: {
  readonly config: T3ConnectionConfig;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<T3ThreadSnapshot> {
  const token = await readSecretFile(input.config.tokenFile);
  const session = await inspectT3Session({ baseUrl: input.config.baseUrl, token, ...signalOption(input.signal) });
  assertRestrictedOrchestrationSession(session);
  return requestT3ThreadSnapshot({ baseUrl: input.config.baseUrl, token, threadId: input.threadId, ...signalOption(input.signal) });
}

/** The snapshot GET alone, with a token whose session the caller has already checked. */
export async function requestT3ThreadSnapshot(input: {
  readonly baseUrl: string;
  readonly token: SecretString;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<T3ThreadSnapshot> {
  const threadId = id.parse(input.threadId);
  const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, input.baseUrl);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.token.exposeToBoundary()}` },
    ...signalOption(input.signal),
  });
  if (response.status === 404) throw new T3ThreadNotFoundError(threadId);
  if (!response.ok) throw new T3HttpError("thread snapshot", response.status);
  const raw: unknown = await response.json();
  return threadSnapshotSchema.parse(raw);
}

function abortEffect(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function watchT3Thread(input: {
  readonly config: T3ConnectionConfig;
  readonly threadId: string;
  readonly afterSequence?: number;
  readonly signal: AbortSignal;
  readonly onItem: (item: T3ThreadStreamItem) => Promise<void>;
}): Promise<void> {
  const url = await socketUrl(input.config, input.signal);
  const payload = {
    threadId: id.parse(input.threadId),
    requestCompletionMarker: true,
    ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
  };
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    const consume = client["orchestration.subscribeThread"](payload).pipe(
      Stream.map((item) => threadStreamItemSchema.parse(item)),
      Stream.runForEach((item) =>
        Effect.tryPromise({
          try: () => input.onItem(item),
          catch: (cause) => new Error("T3 thread callback failed", { cause }),
        }),
      ),
    );
    yield* Effect.raceFirst(consume, abortEffect(input.signal));
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  await Effect.runPromise(program);
}

class T3AssetTransferError extends Error {
  constructor() {
    super("T3 asset transfer failed");
    this.name = "T3AssetTransferError";
  }
}

function assetTransferUrl(relativeUrl: string, config: T3ConnectionConfig, prefix: string): URL {
  const url = new URL(relativeUrl, config.baseUrl);
  if (
    !relativeUrl.startsWith(`${prefix}/`) ||
    url.origin !== new URL(config.baseUrl).origin ||
    !url.pathname.startsWith(`${prefix}/`)
  ) throw new T3AssetTransferError();
  return url;
}

export async function uploadT3Attachment(input: {
  readonly config: T3ConnectionConfig;
  readonly type: T3Attachment["type"];
  readonly name: string;
  readonly mimeType: string;
  readonly data: Blob;
  readonly signal?: AbortSignal;
}): Promise<T3Attachment> {
  const attachment = t3AttachmentSchema.parse({
    type: input.type, id: "pending", name: input.name, mimeType: input.mimeType, sizeBytes: input.data.size,
  });
  const url = await socketUrl(input.config, input.signal);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    return z.object({ attachmentId: id, relativeUrl: id }).parse(yield* client["attachments.createUploadUrl"]({
      type: attachment.type, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
    }));
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  const upload = await runRpc(program, input.signal);
  try {
    const response = await fetch(assetTransferUrl(upload.relativeUrl, input.config, "/api/attachments/upload"), {
      method: "POST", body: input.data, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": attachment.mimeType },
    });
    if (!response.ok) throw new T3AssetTransferError();
    return { ...attachment, id: upload.attachmentId };
  } catch {
    await deletePendingT3Attachment({ config: input.config, attachmentId: upload.attachmentId }).catch(() => undefined);
    // Signed URLs contain bearer authority and must never appear in error output.
    throw new T3AssetTransferError();
  }
}

export async function downloadT3Attachment(input: {
  readonly config: T3ConnectionConfig;
  readonly attachment: T3Attachment;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  const attachment = t3AttachmentSchema.parse(input.attachment);
  const url = await socketUrl(input.config, input.signal);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    return z.object({ relativeUrl: id }).parse(yield* client["assets.createUrl"]({
      resource: { _tag: "attachment", attachmentId: attachment.id, fileName: attachment.name, mimeType: attachment.mimeType },
    }));
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  const asset = await runRpc(program, input.signal);
  try {
    const response = await fetch(assetTransferUrl(asset.relativeUrl, input.config, "/api/assets"), {
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.body === null) throw new T3AssetTransferError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > attachment.sizeBytes) throw new T3AssetTransferError();
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    if (length !== attachment.sizeBytes) throw new T3AssetTransferError();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { throw new T3AssetTransferError(); }
}

export async function deletePendingT3Attachment(input: {
  readonly config: T3ConnectionConfig;
  readonly attachmentId: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const attachmentId = id.parse(input.attachmentId);
  const url = await socketUrl(input.config, input.signal);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    yield* client["attachments.delete"]({ attachmentId });
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  await runRpc(program, input.signal);
}
