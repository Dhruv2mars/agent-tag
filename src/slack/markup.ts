/**
 * Pure helpers that turn Slack message markup into plain model input. Outbound text is escaped
 * separately by render.ts, so nothing here can cause a ping when the model echoes it back.
 */

/** A resolved Slack user. `label` is already sanitized; `resolved` is false for ID-only fallbacks. */
export interface SpeakerIdentity {
  readonly userId: string;
  readonly label: string;
  readonly resolved: boolean;
}

export interface ResolveSlackMarkupOptions {
  /** The agent's own user ID; its mentions render as `@<botLabel>`. */
  readonly botUserId?: string;
  readonly botLabel?: string;
}

const MAX_LABEL_CODE_POINTS = 64;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g;
const MARKUP_TOKEN = /<([^<>\n]+)>/g;

/**
 * Makes an untrusted display name safe for a single-line prompt header: NFKC, no control, format
 * (bidi, zero-width) or markup characters, parentheses mapped to brackets so a name cannot mimic
 * the `(Uxxx)` suffix, whitespace collapsed, capped at 64 code points. May return "".
 */
export function sanitizeLabel(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/\p{C}/gu, " ")
    .replace(/[<>&*_~`]/g, "")
    .replace(/\(/g, "[")
    .replace(/\)/g, "]")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(cleaned);
  return codePoints.length <= MAX_LABEL_CODE_POINTS
    ? cleaned
    : codePoints.slice(0, MAX_LABEL_CODE_POINTS).join("").trimEnd();
}

/** Unique user IDs mentioned as `<@U…>` or `<@U…|name>`, in first-seen order. */
export function collectMentionedUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(USER_MENTION)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

function splitLabel(body: string): { readonly target: string; readonly label: string | undefined } {
  const bar = body.indexOf("|");
  return bar === -1 ? { target: body, label: undefined } : { target: body.slice(0, bar), label: body.slice(bar + 1) };
}

function resolveSpecial(target: string, label: string | undefined): string {
  if (target === "here" || target === "channel" || target === "everyone") return `@${target}`;
  if (target.startsWith("subteam^")) {
    const name = label ?? `@${target.slice("subteam^".length)}`;
    return name.startsWith("@") ? name : `@${name}`;
  }
  if (target.startsWith("date^")) return label ?? target;
  return label ?? `@${target}`;
}

/**
 * Renders Slack markup for the model: user mentions become `@Label`, channels `#name`, broadcasts
 * `@here`, links `label (url)`. HTML entities are unescaped last so they cannot form new markup.
 */
export function resolveSlackMarkup(
  text: string,
  names: ReadonlyMap<string, SpeakerIdentity>,
  options: ResolveSlackMarkupOptions = {},
): string {
  const botLabel = options.botLabel ?? "Agent Tag";
  const resolved = text.replace(MARKUP_TOKEN, (_whole, body: string) => {
    const { target, label } = splitLabel(body);
    if (target.startsWith("@")) {
      const userId = target.slice(1);
      if (userId === options.botUserId) return `@${botLabel}`;
      return `@${names.get(userId)?.label ?? userId}`;
    }
    if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
    if (target.startsWith("!")) return resolveSpecial(target.slice(1), label);
    return label === undefined || label === target ? target : `${label} (${target})`;
  });
  return resolved.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
