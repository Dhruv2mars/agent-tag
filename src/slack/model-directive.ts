// Plain-language model switch (PR-P2 §3.5): "switch to opus", "use `codex/gpt-5.6-mini`: fix x",
// "model: sonnet". A deterministic, anchored parser, not intent detection: a message is a directive
// only when the named model is one this thread may use (or one the T3 catalog knows, which is then
// refused as not allowed). Anything else stays an ordinary prompt, so "use the README to…" is unaffected.
import { type ModelChoice, resolveModelQuery } from "../policy/models.ts";
import type { T3ModelSelection, T3ServerInfo } from "../t3/gateway.ts";

export type ModelDirective =
  | { readonly kind: "match"; readonly query: string; readonly choice: ModelChoice; readonly remainder: string }
  | {
      readonly kind: "ambiguous";
      readonly query: string;
      readonly candidates: ReadonlyArray<ModelChoice>;
      readonly remainder: string;
    }
  /** A model the T3 catalog knows but this thread may not use; `known` is null when several instances serve it. */
  | { readonly kind: "not-allowed"; readonly query: string; readonly known: T3ModelSelection | null; readonly remainder: string };

/** `switch|change (the )?(model )?to`, `use`, `model:`; optional leading "please". */
const VERB =
  /^(?:please[ \t]+)?(?:(?:(?:switch|change)[ \t]+(?:the[ \t]+)?(?:model[ \t]+)?to|use)[ \t]+|model[ \t]*:[ \t]*)/i;
/** What may follow the model name before the directive ends: "model", "for (the rest of) this thread". */
const TAIL =
  /^(?:[ \t]+model)?(?:[ \t]+for[ \t]+(?:the[ \t]+rest[ \t]+of[ \t]+)?this[ \t]+thread)?[ \t]*(?:$|\n|[:,;.—])/i;
const TRAILING_TERMINATORS = /[:,;.—]+$/;
/** Extra terminators after the one that ended the directive, e.g. "use opus...". */
const LEADING_TERMINATORS = /^[\s:,;.—]+/;
const QUOTES: Readonly<Record<string, string>> = { "`": "`", '"': '"', "'": "'", "“": "”", "‘": "’" };
const MAX_TOKENS = 3;

interface Candidate {
  readonly query: string;
  /** Index in the text after the verb where the model name ends. */
  readonly end: number;
}

/** Quoted name, or the first 1-3 tokens of the first line, longest first. */
function candidates(rest: string): Candidate[] {
  const close = QUOTES[rest[0] ?? ""];
  if (close !== undefined) {
    const end = rest.indexOf(close, 1);
    if (end <= 1 || rest.slice(1, end).includes("\n")) return [];
    return [{ query: rest.slice(1, end).trim(), end: end + 1 }];
  }
  const line = rest.split("\n", 1)[0]!;
  const tokens = [...line.matchAll(/\S+/g)].slice(0, MAX_TOKENS);
  const found: Candidate[] = [];
  for (let count = tokens.length; count >= 1; count -= 1) {
    const last = tokens[count - 1]!;
    const raw = line.slice(0, last.index + last[0].length);
    const query = raw.replace(TRAILING_TERMINATORS, "");
    if (query.trim().length > 0) found.push({ query, end: query.length });
  }
  return found;
}

/** The text after the model name, or null when the directive does not end there. */
function remainderAfter(rest: string, end: number): string | null {
  const tail = TAIL.exec(rest.slice(end));
  if (tail === null) return null;
  const remainder = rest.slice(end + tail[0].length).replace(LEADING_TERMINATORS, "").trim();
  return /[\p{L}\p{N}]/u.test(remainder) ? remainder : "";
}

/** A catalog model named by slug (case-insensitive) or exact `instance/model`. */
function catalogModel(catalog: T3ServerInfo | null, query: string): { readonly known: T3ModelSelection | null } | null {
  if (catalog === null || /\s/.test(query)) return null;
  const key = query.toLowerCase();
  const hits: T3ModelSelection[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (`${provider.instanceId}/${model.slug}` === query || model.slug.toLowerCase() === key) {
        hits.push({ instanceId: provider.instanceId, model: model.slug });
      }
    }
  }
  if (hits.length === 0) return null;
  return { known: hits.length === 1 ? hits[0]! : null };
}

/**
 * Parses a mention-stripped message. Returns null for an ordinary prompt. The directive ends at the
 * end of the text or at `:` `,` `;` `.` `—` or a newline; whatever follows is `remainder` (the request
 * to run on the new model).
 */
export function parseModelDirective(
  text: string,
  choices: ReadonlyArray<ModelChoice>,
  catalog: T3ServerInfo | null,
): ModelDirective | null {
  const trimmed = text.trim();
  const verb = VERB.exec(trimmed);
  if (verb === null) return null;
  const rest = trimmed.slice(verb[0].length);
  const options = candidates(rest);
  for (const candidate of options) {
    const resolved = resolveModelQuery(choices, candidate.query);
    if (resolved.kind === "none") continue;
    const remainder = remainderAfter(rest, candidate.end);
    if (remainder === null) continue;
    return resolved.kind === "match"
      ? { kind: "match", query: candidate.query.trim(), choice: resolved.choice, remainder }
      : { kind: "ambiguous", query: candidate.query.trim(), candidates: resolved.candidates, remainder };
  }
  for (const candidate of options) {
    const known = catalogModel(catalog, candidate.query.trim());
    if (known === null) continue;
    const remainder = remainderAfter(rest, candidate.end);
    if (remainder === null) continue;
    return { kind: "not-allowed", query: candidate.query.trim(), known: known.known, remainder };
  }
  return null;
}
