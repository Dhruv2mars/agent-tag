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

export const t3CommandSchema = z.discriminatedUnion("type", [
  projectCreateCommand,
  projectDeleteCommand,
  turnStartCommand,
  turnInterruptCommand,
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
