import { z } from "zod";

import type { AgentTagConfig } from "../config.ts";
import { ExecutionAuthorityDenied, requireTaskAuthority } from "../policy/execution.ts";
import type { AgentTagStore, SlackOutboxPayload } from "../store/store.ts";

export async function deliverNextSlackOutbox(input: {
  readonly config: AgentTagConfig;
  readonly store: AgentTagStore;
  readonly workerId: string;
  readonly postMessage: (message: SlackOutboxPayload & { channel: string; thread_ts: string }) => Promise<unknown>;
  readonly now?: () => string;
}): Promise<boolean> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = input.store.claimNextOutbox({ workerId: input.workerId, now: now(), leaseMs: 30_000 });
  if (claimed === null) return false;
  try {
    const task = input.store.getTaskExecution(claimed.taskId);
    requireTaskAuthority({ config: input.config, task });
    if (claimed.conversationId !== task.conversationId) throw new ExecutionAuthorityDenied();
    const response = await input.postMessage({
      channel: claimed.conversationId,
      thread_ts: claimed.threadTs,
      ...claimed.payload,
    });
    const { ts } = z.object({ ts: z.string().min(1) }).parse(response);
    input.store.markOutboxDelivered({
      outboxId: claimed.outboxId, workerId: input.workerId, slackMessageTs: ts, now: now(),
    });
    return true;
  } catch (error) {
    input.store.failOutbox({
      outboxId: claimed.outboxId,
      workerId: input.workerId,
      errorCode: error instanceof Error ? error.name : "SlackDeliveryError",
      retryable: false,
      now: now(),
    });
    if (error instanceof ExecutionAuthorityDenied) return true;
    throw error;
  }
}
