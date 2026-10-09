import type { SlackUserDirectory } from "./users.ts";

/**
 * Slack reads the coordinator may make before a turn's text is frozen. Built by the Socket Mode
 * bridge; absent in unit tests, where speakers fall back to raw user IDs.
 */
export interface SlackContextSource {
  /** The agent's own Slack user ID (`auth.test.user_id`). */
  readonly botUserId: string;
  /** The agent's own bot ID (`auth.test.bot_id`), when Slack reports it. */
  readonly selfBotId?: string;
  readonly users: SlackUserDirectory;
}
