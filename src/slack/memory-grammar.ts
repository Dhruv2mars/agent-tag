// Memory phrases from Slack (PR-K §3.5). Pure: no I/O, no config. A null result means "not a memory
// command", so the message stays an ordinary request. A colon or a `!` is always required, so
// sentences like "remember that outage last week?" or "forget it" are never taken as commands.

export type MemoryCommand =
  | { readonly kind: "remember"; readonly target: "here" | "workspace"; readonly content: string }
  | { readonly kind: "list" }
  | { readonly kind: "forget"; readonly ref: string }
  | { readonly kind: "forget-match"; readonly match: string }
  | { readonly kind: "edit"; readonly ref: string; readonly content: string };

/** A memory ID prefix as typed: 4 to 36 hex characters (dashes allowed after the first). */
const REF = "[0-9a-f][0-9a-f-]{3,35}";
/** A ref written as `ref`, #ref or a bare ref. */
const REF_TOKEN = `(?:\`(?<quoted>${REF})\`|#(?<hashed>${REF})|(?<bare>${REF}))`;

const REMEMBER_HERE = /^(?:please\s+)?remember(?:\s+(?:this\s+)?for\s+(?:this\s+channel|here|this\s+dm|me))?\s*:\s*(?<c>.+)$/is;
const REMEMBER_WORKSPACE = /^(?:please\s+)?remember\s+(?:this\s+)?for\s+(?:the\s+)?(?:workspace|everyone|all\s+channels)\s*:\s*(?<c>.+)$/is;
const BANG_REMEMBER = /^!remember\s+(?:(?<w>--workspace|-w|workspace\s*:)|(?:channel|here)\s*:)?\s*(?<c>.+)$/is;
const LIST = [
  /^what\s+do\s+you\s+remember(?:\s+(?:about\s+)?(?:this\s+channel|here|me|this\s+dm))?\s*\??$/i,
  /^(?:show|list)\s+(?:your\s+)?memor(?:y|ies)\s*\??$/i,
  /^!memory(?:\s+list)?$/i,
];
const FORGET_REF = new RegExp(`^!?forget\\s+${REF_TOKEN}\\s*\\.?$`, "i");
const FORGET_MATCH = /^forget\s*:\s*(?<m>.+)$/is;
const EDIT = [
  new RegExp(`^update\\s+memory\\s+${REF_TOKEN}\\s*:\\s*(?<c>.+)$`, "is"),
  new RegExp(`^!memory\\s+edit\\s+${REF_TOKEN}\\s+(?<c>.+)$`, "is"),
];

/**
 * The ref of a match. A bare ref needs a digit or 8+ characters, so ordinary words made of hex
 * letters ("forget cafe", "forget decade") stay requests; refs shown in lists are 8 characters.
 */
function refOf(groups: Record<string, string | undefined>): string | null {
  const decorated = groups["quoted"] ?? groups["hashed"];
  if (decorated !== undefined) return decorated.toLowerCase();
  const bare = groups["bare"];
  if (bare === undefined || (!/\d/.test(bare) && bare.length < 8)) return null;
  return bare.toLowerCase();
}

function content(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** `text` is the message with the bot mention removed. Matching is anchored to the whole message. */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const s = text.trim();
  if (s === "") return null;

  // Workspace first: "remember for the workspace:" must not fall into the "here" pattern.
  const workspace = REMEMBER_WORKSPACE.exec(s);
  if (workspace !== null) {
    const c = content(workspace.groups?.["c"]);
    return c === null ? null : { kind: "remember", target: "workspace", content: c };
  }
  const here = REMEMBER_HERE.exec(s);
  if (here !== null) {
    const c = content(here.groups?.["c"]);
    return c === null ? null : { kind: "remember", target: "here", content: c };
  }
  const bang = BANG_REMEMBER.exec(s);
  if (bang !== null) {
    const c = content(bang.groups?.["c"]);
    if (c === null || /^(?:--workspace|-w)$/i.test(c)) return null;
    return { kind: "remember", target: bang.groups?.["w"] === undefined ? "here" : "workspace", content: c };
  }
  if (LIST.some((pattern) => pattern.test(s))) return { kind: "list" };
  const forget = FORGET_REF.exec(s);
  if (forget !== null) {
    const ref = refOf(forget.groups ?? {});
    return ref === null ? null : { kind: "forget", ref };
  }
  const match = FORGET_MATCH.exec(s);
  if (match !== null) {
    const m = content(match.groups?.["m"]);
    return m === null ? null : { kind: "forget-match", match: m };
  }
  for (const pattern of EDIT) {
    const edit = pattern.exec(s);
    if (edit === null) continue;
    const ref = refOf(edit.groups ?? {});
    const c = content(edit.groups?.["c"]);
    return ref === null || c === null ? null : { kind: "edit", ref, content: c };
  }
  return null;
}
