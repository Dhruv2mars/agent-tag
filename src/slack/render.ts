// Slack renderer for untrusted agent output.
//
// Model text is treated as untrusted: it is converted from GitHub Markdown to
// Slack mrkdwn, entity-escaped per Slack rules, and every broadcast, user, or
// user-group mention is neutralized so agent output can never notify anyone.
//
// Mention neutralization: Slack only notifies for control sequences such as
// `<!channel>` or `<@U123>` (bot `chat.postMessage` text does not resolve raw
// "@channel" unless `link_names` is set, which Agent Tag never sends). Control
// sequences are rewritten to plain text and a ZERO WIDTH SPACE (U+200B) is
// inserted after the "@" (e.g. "@​U123", "@​channel") so the text
// reads naturally but can never be re-parsed as a mention, even if a later
// sender enables `link_names`.

export const SLACK_MESSAGE_TEXT_LIMIT = 3_500;
export const SLACK_SECTION_TEXT_LIMIT = 3_000;

const MENTION_BREAK = "​";
const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";
const BOLD_OPEN = "";
const BOLD_CLOSE = "";
const PRIVATE_SENTINELS = /[-]/g;
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Escape the three characters Slack reserves for control sequences. */
function escapeEntities(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Rewrite Slack mention control sequences and raw broadcast words to inert text. */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/gi, (_match, name: string) => `@${MENTION_BREAK}${name}`)
    .replace(/<!subteam\^([A-Za-z0-9]+)(?:\|([^>]*))?>/gi, (_match, id: string, label: string | undefined) => {
      const handle = label?.replace(/^@+/, "").trim();
      return `@${MENTION_BREAK}${handle === undefined || handle === "" ? id : handle}`;
    })
    .replace(/<@([A-Za-z0-9]+)(?:\|[^>]*)?>/g, (_match, id: string) => `@${MENTION_BREAK}${id}`)
    .replace(/<#([A-Za-z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name: string | undefined) =>
      `#${name === undefined || name === "" ? id : name}`
    )
    .replace(/<!([^>]*)>/g, (_match, body: string) => `!${body}`)
    .replace(/(^|[^\w@​])@(channel|here|everyone)\b/gi, (_match, before: string, name: string) =>
      `${before}@${MENTION_BREAK}${name}`
    );
}

/**
 * Make arbitrary text safe for a Slack mrkdwn field: neutralize mentions, then
 * escape `&`, `<`, `>`. The result contains no Slack control sequences.
 */
export function escapeSlackText(text: string): string {
  return escapeEntities(neutralizeMentions(text.replace(PRIVATE_SENTINELS, "")));
}

/**
 * Break every run of three or more backticks with U+200B (after each pair) so
 * code content can never close a Slack code block, wherever it sits on a line.
 */
function breakFences(text: string): string {
  return text.replace(/`{3,}/g, (run) => (run.match(/``?/g) ?? []).join(MENTION_BREAK));
}

/** Entity-escape one line of code-block content and break embedded fences. */
function escapeCodeLine(line: string): string {
  return breakFences(escapeEntities(line));
}

/**
 * Render untrusted verbatim text (commands, diffs) as a Slack code block. Only
 * entity escaping is applied; embedded ``` sequences are broken with U+200B.
 */
export function renderCodeBlock(text: string): string {
  const body = escapeCodeLine(text.replace(PRIVATE_SENTINELS, "").replace(/\r\n?/g, "\n"));
  return `\`\`\`\n${body}\n\`\`\``;
}

function escapeUrl(url: string): string {
  return url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll("|", "%7C");
}

function renderLink(label: string, url: string): string {
  const safeLabel = escapeSlackText(label.trim());
  if (!SAFE_URL.test(url)) return safeLabel === "" ? escapeSlackText(url) : `${safeLabel} (${escapeSlackText(url)})`;
  return safeLabel === "" || safeLabel === escapeEntities(url) ? `<${escapeUrl(url)}>` : `<${escapeUrl(url)}|${safeLabel}>`;
}

function convertEmphasis(text: string): string {
  return text
    .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, `${BOLD_OPEN}_$1_${BOLD_CLOSE}`)
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`)
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, `$1${BOLD_OPEN}$2${BOLD_CLOSE}`)
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "~$1~")
    .replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])/g, "$1_$2_")
    .replaceAll(BOLD_OPEN, "*")
    .replaceAll(BOLD_CLOSE, "*");
}

/** Convert one Markdown line (outside code fences and tables) to mrkdwn. */
function convertInline(line: string): string {
  const tokens: string[] = [];
  // Raw text of each held token, used where formatting is impossible (link labels).
  const plain: string[] = [];
  const placeholder = new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g");
  const hold = (rendered: string, raw: string): string => {
    tokens.push(rendered);
    plain.push(raw);
    return `${PLACEHOLDER_OPEN}${tokens.length - 1}${PLACEHOLDER_CLOSE}`;
  };
  const protectedLine = line
    .replace(/(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\1(?!`)/g, (_match, _ticks: string, content: string) => {
      // CommonMark: a span may use N backticks to contain shorter runs; one padding space is stripped.
      const code = /^ .* $/.test(content) && content.trim() !== "" ? content.slice(1, -1) : content;
      // Slack inline code cannot contain backticks; show them as look-alike U+02CB so the span stays verbatim.
      return hold(`\`${escapeEntities(code.replaceAll("`", "\u02cb"))}\``, code);
    })
    .replace(/!?\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s>]*\))+)>?(?:\s+"[^"\n]*")?\s*\)/g, (_match, label: string, url: string) => {
      // Slack link labels cannot carry formatting: inline code becomes plain label text.
      const restore = (text: string): string => text.replace(placeholder, (_token, index: string) => `\`${plain[Number(index)] ?? ""}\``);
      const rawLabel = label.replace(placeholder, (_token, index: string) => plain[Number(index)] ?? "");
      // Backticks inside a destination are literal URL characters, not code spans.
      return hold(renderLink(rawLabel, restore(url)), rawLabel);
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>\s|]+)>/gi, (_match, url: string) => hold(`<${escapeUrl(url)}>`, url));
  const rendered = convertEmphasis(escapeEntities(neutralizeMentions(protectedLine)));
  return rendered.replace(placeholder, (_match, index: string) => tokens[Number(index)] ?? "");
}

function convertLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading !== null) {
    // Drop bold markers (the whole heading is bolded) but leave code spans untouched.
    const content = (heading[1] ?? "")
      .split(/(`[^`\n]+`)/)
      .map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part : part.replace(/\*\*|__/g, "")))
      .join("");
    return content === "" ? "" : `*${convertInline(content)}*`;
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────────";
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet !== null) return `${bullet[1] ?? ""}• ${convertInline(bullet[2] ?? "")}`;
  const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
  if (quote !== null) return `>${convertInline(quote[1] ?? "")}`;
  return convertInline(line);
}

/**
 * Convert common GitHub Markdown to Slack mrkdwn. Code (fenced blocks and inline
 * spans) is never converted; it is only entity-escaped, which Slack requires.
 * Tables are wrapped in a code block because Slack has no table syntax.
 */
export function markdownToMrkdwn(markdown: string): string {
  const lines = markdown.replace(PRIVATE_SENTINELS, "").replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const oneLineCode = /^\s*```([^`]+)```\s*$/.exec(line);
    if (oneLineCode !== null) {
      output.push(`\`${escapeEntities(oneLineCode[1] ?? "")}\``);
      index += 1;
      continue;
    }
    const fence = FENCE_LINE.exec(line);
    // CommonMark: a backtick fence's info string cannot contain backticks.
    if (fence !== null && !((fence[1] ?? "").startsWith("`") && (fence[2] ?? "").includes("`"))) {
      const marker = fence[1] ?? "```";
      output.push("```");
      index += 1;
      while (index < lines.length) {
        const inner = lines[index] ?? "";
        const close = FENCE_LINE.exec(inner);
        index += 1;
        if (close !== null && (close[1] ?? "")[0] === marker[0] && (close[1] ?? "").length >= marker.length &&
          (close[2] ?? "").trim() === "") {
          break;
        }
        // Any embedded ``` would end Slack's code block early; break it with U+200B.
        output.push(escapeCodeLine(inner));
      }
      output.push("```");
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      output.push("```");
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) {
        output.push(escapeCodeLine((lines[index] ?? "").trim()));
        index += 1;
      }
      output.push("```");
      continue;
    }
    output.push(convertLine(line));
    index += 1;
  }
  return output.join("\n");
}

function isFenceToggle(line: string): boolean {
  // A fence line is ``` plus an optional info string; info strings cannot contain backticks.
  return /^\s*```[^`]*$/.test(line);
}

/** Number of UTF-16 units to keep so a cut never splits a surrogate pair, entity, or `<...>` link. */
function safeCutLength(text: string, max: number): number {
  let cut = Math.max(0, Math.min(max, text.length));
  if (cut === text.length) return cut;
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const head = text.slice(0, cut);
  const amp = head.lastIndexOf("&");
  if (amp !== -1 && amp >= cut - 6 && !head.slice(amp).includes(";")) cut = amp;
  const open = head.lastIndexOf("<", cut);
  if (open !== -1 && !text.slice(open, cut).includes(">")) {
    if (open > 0) cut = open;
    else {
      // A link at offset zero that fits the budget is kept whole; oversized links were unlinked upstream.
      const close = text.indexOf(">", open);
      if (close !== -1 && close + 1 <= max) cut = close + 1;
    }
  }
  return cut > 0 ? cut : Math.min(max, text.length);
}

const RENDERED_LINK = /<([^<>|\s]+)(?:\|([^<>]*))?>/g;

/**
 * Replace every `<url|label>` link longer than `max` with plain text ("label (url)")
 * so it can be wrapped without leaving a partial `<...>` fragment in any message.
 * Rendered text only contains `<` as link syntax; everything else is entity-escaped.
 */
function unlinkOversized(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.replace(RENDERED_LINK, (link, url: string, label: string | undefined) => {
    if (link.length <= max) return link;
    const shown = label === undefined || label === "" || label === url ? url : `${label} (${url})`;
    return neutralizeMentions(shown);
  });
}

function insideLink(text: string, cut: number): boolean {
  const open = text.lastIndexOf("<", cut - 1);
  return open !== -1 && !text.slice(open, cut).includes(">");
}

/** Break a single over-long line into pieces no longer than `max`, preferring whitespace. */
function hardWrap(line: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = unlinkOversized(line, max);
  while (rest.length > max) {
    let cut = safeCutLength(rest, max);
    // Prefer the last space, but only one whose cut is itself outside any link or entity.
    for (let space = rest.lastIndexOf(" ", cut - 1); space > max / 2; space = rest.lastIndexOf(" ", space - 1)) {
      if (safeCutLength(rest, space + 1) === space + 1 && !insideLink(rest, space + 1)) {
        cut = space + 1;
        break;
      }
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * Split rendered mrkdwn into Slack-sized chunks at paragraph or line boundaries.
 * A chunk that ends inside a code fence is closed with ``` and the next chunk
 * reopens it. Multi-chunk replies get a trailing "(i/n)" marker. Every chunk is
 * at most `limit` UTF-16 units.
 */
export function splitForSlack(text: string, limit = SLACK_MESSAGE_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const markerReserve = "\n(9999/9999)".length;
  const fenceReserve = "```\n".length + "\n```".length;
  const budget = limit - markerReserve - fenceReserve;
  if (budget < 16) throw new Error("splitForSlack limit is too small");

  const lines = text.split("\n").flatMap((line) => hardWrap(line, budget));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let openedInFence = false;
  let inFence = false;
  // Candidate split points: index into `current` after which a paragraph ends outside a fence.
  let paragraphBreak = -1;

  const fenceStateAfter = (start: boolean, body: readonly string[]): boolean =>
    body.reduce((state, line) => (isFenceToggle(line) ? !state : state), start);

  const flush = (count: number): void => {
    const body = current.slice(0, count);
    const endsInFence = fenceStateAfter(openedInFence, body);
    while (body.length > 0 && body[body.length - 1] === "" && !endsInFence) body.pop();
    const parts = [...(openedInFence ? ["```"] : []), ...body, ...(endsInFence ? ["```"] : [])];
    // Drop empty code blocks at chunk edges: a reopen immediately closed by the
    // source fence, or a source fence opened on the chunk's last line.
    if (openedInFence && body.length > 0 && isFenceToggle(body[0] ?? "")) {
      parts.splice(0, 2);
      while (parts[0] === "") parts.shift();
    }
    if (endsInFence && body.length > 0 && isFenceToggle(body[body.length - 1] ?? "")) {
      parts.splice(-2, 2);
      while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    }
    chunks.push(parts.join("\n"));
    const rest = current.slice(count);
    while (rest.length > 0 && rest[0] === "" && !endsInFence) rest.shift();
    openedInFence = endsInFence;
    current = rest;
    currentLength = rest.reduce((sum, line) => sum + line.length + 1, 0);
    paragraphBreak = -1;
    let state = openedInFence;
    rest.forEach((line, position) => {
      if (isFenceToggle(line)) state = !state;
      if (line === "" && !state && position > 0) paragraphBreak = position;
    });
  };

  for (const line of lines) {
    while (currentLength + line.length + 1 > budget && current.length > 0) {
      flush(paragraphBreak > 0 && paragraphBreak >= current.length / 2 ? paragraphBreak : current.length);
    }
    if (isFenceToggle(line)) inFence = !inFence;
    current.push(line);
    currentLength += line.length + 1;
    if (line === "" && !inFence) paragraphBreak = current.length - 1;
  }
  if (current.length > 0) flush(current.length);

  const nonEmpty = chunks.filter((chunk) => chunk.trim() !== "");
  if (nonEmpty.length <= 1) return nonEmpty.length === 1 ? nonEmpty : [text.slice(0, limit)];
  return nonEmpty.map((chunk, position) => `${chunk}\n(${position + 1}/${nonEmpty.length})`);
}

/**
 * Truncate mrkdwn for a section block (Slack limit: 3000 characters). Cuts at a
 * line boundary when one is close, closes an open code fence, and appends an
 * ellipsis plus a note saying how much was omitted.
 */
export function truncateBlockText(text: string, limit = SLACK_SECTION_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const note = (omitted: number): string => `…\n_(truncated ${omitted} more characters)_`;
  const reserve = note(text.length).length + "\n```".length + 1;
  if (limit <= reserve) throw new Error("truncateBlockText limit is too small");
  const budget = limit - reserve;
  // A link longer than the budget would be cut mid-syntax; render it as plain text instead.
  const linkSafe = unlinkOversized(text, budget);
  if (linkSafe !== text) return truncateBlockText(linkSafe, limit);
  let cut = safeCutLength(text, budget);
  const newline = text.lastIndexOf("\n", cut);
  if (newline > cut * 0.8) cut = newline;
  const head = text.slice(0, cut);
  const inFence = head.split("\n").reduce((state, line) => (isFenceToggle(line) ? !state : state), false);
  return `${head}${inFence ? "\n```" : ""}\n${note(text.length - cut)}`;
}
