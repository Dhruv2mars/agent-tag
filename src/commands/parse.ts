// `@bot !command` parser. Pure: no I/O, no config. A null result means "not a command", so the
// message is an ordinary prompt (PR-H §3.7.1, Claude Tag grammar).

export const AGENT_COMMANDS = [
  "help",
  "status",
  "restart",
  "stop",
  "mute",
  "unmute",
  "model",
  "routines",
  "memory",
  "remember",
  "forget",
] as const;
export type AgentCommandName = (typeof AGENT_COMMANDS)[number];

/** Commands with a handler today. The rest parse, but the router treats them as ordinary prompts. */
export const IMPLEMENTED_COMMANDS = ["help", "status", "mute", "unmute"] as const satisfies ReadonlyArray<AgentCommandName>;
export type ImplementedCommandName = (typeof IMPLEMENTED_COMMANDS)[number];

export type ParsedAgentCommand =
  | { readonly name: "help" | "status" | "restart" | "stop" | "mute" | "unmute" | "memory" }
  | {
      readonly name: "model";
      readonly action:
        | { readonly kind: "show" }
        | { readonly kind: "list" }
        | { readonly kind: "reset" }
        | { readonly kind: "set"; readonly query: string };
    }
  | {
      readonly name: "routines";
      readonly action:
        | { readonly kind: "list"; readonly channelId: string | null }
        | { readonly kind: "cancel"; readonly ref: string };
    }
  | {
      readonly name: "remember";
      readonly scope: "default" | "thread" | "channel" | "workspace";
      readonly content: string;
    }
  | { readonly name: "forget"; readonly ref: string };

export interface CommandUsage {
  readonly name: "routines" | "remember" | "forget";
  readonly usage: true;
  readonly tooLong?: boolean;
}

export const MAX_REMEMBER_CHARS = 2_000;

const STANDALONE = new Set<AgentCommandName>(["help", "status", "restart", "stop", "mute", "unmute", "memory"]);
const COMMAND_PATTERN = /^!([A-Za-z]+)(?=\s|$)/;
const CHANNEL_MENTION = /^<#([CG][A-Z0-9]+)(\|[^>]*)?>$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const SCOPE_PREFIX = /^(thread|channel|here|workspace):\s*/i;

function isAgentCommand(name: string): name is AgentCommandName {
  return (AGENT_COMMANDS as ReadonlyArray<string>).includes(name);
}

export function isCommandUsage(command: ParsedAgentCommand | CommandUsage): command is CommandUsage {
  return "usage" in command;
}

/**
 * Strips a leading `<@BOT>` or `<@BOT|label>` mention. Returns the rest, or null when the text does
 * not start with the mention or the mention runs straight into more text (`<@BOT>!help`).
 */
function stripLeadingMention(text: string, botUserId: string): string | null {
  const match = new RegExp(`^<@${botUserId}(?:\\|[^>]*)?>`).exec(text);
  if (match === null) return null;
  const rest = text.slice(match[0].length);
  return rest === "" || /^\s/.test(rest) ? rest : null;
}

export function parseAgentCommand(
  text: string,
  opts: { readonly botUserId: string; readonly allowBare: boolean },
): ParsedAgentCommand | CommandUsage | null {
  if (!/^[A-Z][A-Z0-9]+$/.test(opts.botUserId)) throw new Error("invalid bot user id");
  let s = text.trim();
  const afterMention = stripLeadingMention(s, opts.botUserId);
  if (afterMention !== null) {
    s = afterMention;
  } else if (!opts.allowBare) {
    return null;
  }
  s = s.trimStart();
  const match = COMMAND_PATTERN.exec(s);
  if (match === null) return null;
  const name = match[1]!.toLowerCase();
  if (!isAgentCommand(name)) return null;
  const rest = s.slice(match[0].length).trim();
  const tokens = rest === "" ? [] : rest.split(/\s+/);

  if (STANDALONE.has(name)) {
    return tokens.length === 0 ? { name: name as "help" | "status" | "restart" | "stop" | "mute" | "unmute" | "memory" } : null;
  }
  switch (name) {
    case "model": {
      if (tokens.length === 0) return { name, action: { kind: "show" } };
      if (tokens.length > 1) return null;
      const token = tokens[0]!;
      const lowered = token.toLowerCase();
      if (lowered === "list") return { name, action: { kind: "list" } };
      if (lowered === "default" || lowered === "reset") return { name, action: { kind: "reset" } };
      return { name, action: { kind: "set", query: token } };
    }
    case "routines": {
      if (tokens.length === 0) return { name, action: { kind: "list", channelId: null } };
      if (tokens.length === 1) {
        const token = tokens[0]!;
        const mention = CHANNEL_MENTION.exec(token);
        if (mention !== null) return { name, action: { kind: "list", channelId: mention[1]! } };
        if (CHANNEL_ID.test(token)) return { name, action: { kind: "list", channelId: token } };
        return { name, usage: true };
      }
      if (tokens.length === 2 && tokens[0]!.toLowerCase() === "cancel") {
        return { name, action: { kind: "cancel", ref: tokens[1]! } };
      }
      return null;
    }
    case "remember": {
      if (rest === "") return { name, usage: true };
      const prefix = SCOPE_PREFIX.exec(rest);
      const content = prefix === null ? rest : rest.slice(prefix[0].length);
      if (content === "") return { name, usage: true };
      if (content.length > MAX_REMEMBER_CHARS) return { name, usage: true, tooLong: true };
      const word = prefix?.[1]!.toLowerCase();
      const scope = word === undefined ? "default" : word === "here" ? "channel" : (word as "thread" | "channel" | "workspace");
      return { name, scope, content };
    }
    case "forget": {
      if (tokens.length === 0) return { name, usage: true };
      return tokens.length === 1 ? { name, ref: tokens[0]! } : null;
    }
    default:
      return null;
  }
}
