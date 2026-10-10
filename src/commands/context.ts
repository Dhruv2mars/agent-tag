import type { ActiveTaskBinding } from "../store/store.ts";
import type { CommandUsage, ParsedAgentCommand } from "./parse.ts";

/** Where and by whom a `!command` was sent. Built by the router after its access checks. */
export interface CommandContext {
  readonly deliveryId: string;
  /** `${channel}:${ts}`, the same key space as slack_events. */
  readonly eventKey: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly conversationType: "channel" | "dm";
  /** null = top level. */
  readonly threadTs: string | null;
  readonly messageTs: string;
  readonly actorUserId: string;
  readonly profileId: string;
  readonly repositoryRoot: string;
  /** The active task bound to `threadTs`, if any. */
  readonly binding: ActiveTaskBinding | null;
  readonly receivedAt: string;
}

export interface CommandIngress {
  readonly kind: "command";
  readonly command: ParsedAgentCommand | CommandUsage;
  readonly context: CommandContext;
}
