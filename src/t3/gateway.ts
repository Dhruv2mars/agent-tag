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

import { readSecretFile } from "../security/secret-file.ts";
import {
  assertRestrictedOrchestrationSession,
  inspectT3Session,
  issueT3WebSocketUrl,
} from "./auth.ts";

const id = z.string().trim().min(1);
const isoDateTime = z.iso.datetime();
const modelSelection = z.object({ instanceId: id, model: id });
const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const interactionMode = z.enum(["default", "plan"]);

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
    attachments: z.array(z.unknown()).max(8),
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

export const t3CommandSchema = z.discriminatedUnion("type", [
  projectCreateCommand,
  projectDeleteCommand,
  turnStartCommand,
  turnInterruptCommand,
  approvalRespondCommand,
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

const serverConfigSchema = z.object({
  environment: z.object({
    environmentId: id,
    capabilities: z.record(z.string(), z.unknown()),
  }),
  providers: z.array(providerSchema),
});

export type T3ServerInfo = z.infer<typeof serverConfigSchema>;

const dispatchResultSchema = z.object({ sequence: z.number().int().nonnegative() });
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

const threadSnapshotSchema = z.object({
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
  requestKind: z.enum(["command", "file-read", "file-change", "mcp-elicitation"]).optional(),
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
  readonly requestKind: "command" | "file-read" | "file-change" | "mcp-elicitation";
  readonly detail?: string;
  readonly appName?: string;
  readonly options: ReadonlyArray<{
    readonly decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
    readonly label: string;
    readonly warning?: string;
  }>;
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

const threadStreamItemSchema = z.discriminatedUnion("kind", [
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
const rpcGroup = RpcGroup.make(probeRpc, configRpc, dispatchRpc, subscribeThreadRpc);

export interface T3ConnectionConfig {
  readonly baseUrl: string;
  readonly tokenFile: string;
}

async function socketUrl(config: T3ConnectionConfig): Promise<string> {
  const token = await readSecretFile(config.tokenFile);
  const session = await inspectT3Session({ baseUrl: config.baseUrl, token });
  assertRestrictedOrchestrationSession(session);
  return issueT3WebSocketUrl({ baseUrl: config.baseUrl, token });
}

function protocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url, { openTimeout: "10 seconds" }).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  return RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.merge(socketLayer, RpcSerialization.layerJson)),
  );
}

export async function inspectT3(config: T3ConnectionConfig): Promise<T3ServerInfo> {
  const url = await socketUrl(config);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    yield* client["server.probe"]({});
    const raw = yield* client["server.getConfig"]({});
    return serverConfigSchema.parse(raw);
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  return Effect.runPromise(program);
}

export async function dispatchT3Command(input: {
  readonly config: T3ConnectionConfig;
  readonly command: T3Command;
}): Promise<T3DispatchResult> {
  const url = await socketUrl(input.config);
  const command = t3CommandSchema.parse(input.command);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(rpcGroup);
    const raw = yield* client["orchestration.dispatchCommand"](command);
    return dispatchResultSchema.parse(raw);
  }).pipe(Effect.provide(protocolLayer(url)), Effect.scoped);
  return Effect.runPromise(program);
}

export async function fetchT3ThreadSnapshot(input: {
  readonly config: T3ConnectionConfig;
  readonly threadId: string;
}): Promise<T3ThreadSnapshot> {
  const threadId = id.parse(input.threadId);
  const token = await readSecretFile(input.config.tokenFile);
  const session = await inspectT3Session({ baseUrl: input.config.baseUrl, token });
  assertRestrictedOrchestrationSession(session);
  const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, input.config.baseUrl);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token.exposeToBoundary()}` },
  });
  if (!response.ok) throw new Error(`T3 thread snapshot endpoint returned HTTP ${response.status}`);
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
  const url = await socketUrl(input.config);
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
