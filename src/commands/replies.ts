// Every user-facing `!command` string (PR-H §3.6). The bot name comes from `auth.test`; it and any
// other non-constant fragment go through escapeSlackText. The only mention emitted is the actor's.
import { escapeSlackText } from "../slack/render.ts";
import type { SlackOutboxPayload } from "../store/store.ts";
import type { CommandDenialReason } from "./authority.ts";
import type { ImplementedCommandName } from "./parse.ts";

export const DEFAULT_BOT_NAME = "Agent Tag";

function payload(text: string): SlackOutboxPayload {
  return { text };
}

const HELP_LINES: Readonly<Record<ImplementedCommandName, string>> = {
  help: "`!help` — list the commands you can use here (only you see it)",
  status: "`!status` — what I'm doing in this thread (only you see it)",
  mute: "`!mute` — stop answering messages in this thread unless they mention me",
  unmute: "`!unmute` — answer every message in this thread again",
};

export function helpReply(input: {
  readonly botName: string;
  readonly commands: ReadonlyArray<{ readonly name: ImplementedCommandName; readonly adminOnly: boolean }>;
}): SlackOutboxPayload {
  const lines = input.commands.map(({ name, adminOnly }) => `• ${HELP_LINES[name]}${adminOnly ? " (admins)" : ""}`);
  return payload(
    [
      `*${escapeSlackText(input.botName)} commands*`,
      ...lines,
      "Commands must start the message right after the mention; anything else is a normal request.",
    ].join("\n"),
  );
}

/** `6m`, `2h 5m`, `3d 4h`; under a minute is `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface ThreadStatusView {
  readonly botName: string;
  readonly conversationType: "channel" | "dm";
  /** false: no task is bound to this thread. */
  readonly bound: boolean;
  readonly muted: boolean;
  readonly workingForMs: number | null;
  readonly waitingForMs: number | null;
  readonly queued: number;
  readonly model: { readonly instanceId: string; readonly model: string; readonly override: boolean } | null;
}

/** Never quotes the conversation: only state, durations and the model. */
export function threadStatusReply(view: ThreadStatusView): SlackOutboxPayload {
  const where = view.conversationType === "dm" ? "in this DM" : "in this thread";
  const activity: string[] = [];
  if (!view.bound) {
    activity.push("I'm not part of this thread yet.");
  } else {
    if (view.waitingForMs !== null) {
      activity.push(`I'm waiting for an answer to an approval or question here (since ${formatDuration(view.waitingForMs)} ago).`);
    } else if (view.workingForMs !== null) {
      activity.push(`I'm working in this thread (started ${formatDuration(view.workingForMs)} ago).`);
    }
    if (view.queued > 0) activity.push(`I have ${plural(view.queued, "request", "requests")} queued here.`);
    if (activity.length === 0) activity.push("I'm not working on anything in this thread.");
  }
  const lines = [`*${escapeSlackText(view.botName)} ${where}*`, activity.join(" ")];
  if (view.bound) {
    lines.push(view.muted ? "• Muted: yes (unmute with `!unmute` or mention me)" : "• Muted: no (mute with `!mute`)");
  }
  if (view.model !== null) {
    lines.push(
      `• Model: ${escapeSlackText(view.model.instanceId)} / ${escapeSlackText(view.model.model)}${view.model.override ? " (thread override)" : ""}`,
    );
  }
  return payload(lines.join("\n"));
}

export function conversationStatusReply(view: {
  readonly botName: string;
  readonly conversationType: "channel" | "dm";
  readonly working: number;
  readonly waiting: number;
  readonly queued: number;
}): SlackOutboxPayload {
  const where = view.conversationType === "dm" ? "in this DM" : "in this channel";
  const busy = view.working + view.waiting + view.queued > 0;
  return payload(
    [
      `*${escapeSlackText(view.botName)} ${where}*`,
      busy
        ? `I'm working in ${plural(view.working, "thread", "threads")} here, ${view.waiting} waiting on people, ${view.queued} queued.`
        : "I'm not working on anything here.",
      "Each @-mention starts its own thread; run `!status` inside a thread for details.",
    ].join("\n"),
  );
}

export function mutedReply(botName: string): SlackOutboxPayload {
  const name = escapeSlackText(botName);
  return payload(`:mute: ${name} is muted in this thread. Mention me or send \`@${name} !unmute\` to bring me back.`);
}

export function unmutedReply(botName: string): SlackOutboxPayload {
  return payload(`:loud_sound: ${escapeSlackText(botName)} is unmuted in this thread.`);
}

export const ALREADY_MUTED = payload("This thread is already muted.");
export const NOT_MUTED = payload("This thread isn't muted.");
export const MUTE_UNBOUND = payload("I'm not part of this thread, so there's nothing to mute.");
export const UNMUTE_UNBOUND = payload("I'm not part of this thread, so there's nothing to unmute.");

/** Claude Tag's top-level hint, verbatim apart from the name. */
export function muteTopLevelReply(botName: string): SlackOutboxPayload {
  return payload(
    `:mute: Muting works per thread — reply \`@${escapeSlackText(botName)} !mute\` (or \`!unmute\`) inside the thread you mean.`,
  );
}

export function deniedReply(input: {
  readonly botName: string;
  readonly command: string;
  readonly reason: CommandDenialReason;
}): SlackOutboxPayload {
  const command = `\`!${input.command}\``;
  switch (input.reason) {
    case "command-disabled":
      return payload(`${command} isn't enabled in this workspace.`);
    case "admin-required":
      return payload(`Only ${escapeSlackText(input.botName)} admins can use ${command}.`);
    case "task-authority":
      return payload(`I can't run ${command} in this thread with the current configuration.`);
  }
}

export const COMMAND_FAILED = payload("Something went wrong running that command. Please try again.");
