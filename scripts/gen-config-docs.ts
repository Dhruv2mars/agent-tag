// Generates docs/configuration.md from `agentTagConfigSchema`, so the reference cannot drift from the
// parser. Types and limits come from Zod's JSON Schema. A default the JSON Schema cannot show (one set
// by a transform, or by a default on the enclosing object) is found by deleting the key from the
// example config, then each enclosing object in turn, and reading what the parser fills in.
//
//   bun run docs:config            rewrite docs/configuration.md
//   bun run docs:config --stdout   print it instead
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { agentTagConfigSchema } from "../src/config.ts";

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
};

export type ConfigKey = {
  /** Dotted path; `[]` marks an array element, e.g. `profiles[].memory.retentionDays`. */
  path: string;
  type: string;
  limits: string;
  default: string;
  /** Set when the key exists only in some variants of a union, e.g. `t3.mode = "managed"`. */
  when: string;
};

const REPOSITORY = resolve(import.meta.dir, "..");

function variantsOf(node: JsonSchema): JsonSchema[] | undefined {
  const variants = node.anyOf ?? node.oneOf;
  return variants?.every((variant) => variant.properties !== undefined) ? variants : undefined;
}

/** The property whose `const` or `enum` values tell the variants apart, e.g. `mode` or `conversationType`. */
function discriminator(variants: JsonSchema[]): string | undefined {
  const names = Object.keys(variants[0]!.properties!);
  return names.find((name) => {
    const values = variants.map((variant) => tagValues(variant.properties![name]));
    if (values.some((list) => list === undefined)) return false;
    const all = values.flatMap((list) => list!.map((value) => JSON.stringify(value)));
    return new Set(all).size === all.length;
  });
}

function tagValues(node: JsonSchema | undefined): unknown[] | undefined {
  return node?.const !== undefined ? [node.const] : node?.enum;
}

function describeType(node: JsonSchema): string {
  if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``;
  if (node.enum !== undefined) return node.enum.map((value) => `\`${JSON.stringify(value)}\``).join(" \\| ");
  const variants = node.anyOf ?? node.oneOf;
  if (variants !== undefined) return [...new Set(variants.map(describeType))].join(" or ");
  if (node.type === "array") return node.items === undefined ? "array" : `array of ${describeType(node.items)}`;
  if (Array.isArray(node.type)) return node.type.join(" or ");
  if (node.type === "string" && node.format === "uri") return "URL";
  return node.type ?? "any";
}

function describeLimits(node: JsonSchema): string {
  const parts: string[] = [];
  const low = node.minimum ?? (node.exclusiveMinimum === undefined ? undefined : node.exclusiveMinimum + 1);
  if (low !== undefined && node.maximum !== undefined) parts.push(`${low}–${node.maximum}`);
  else if (low !== undefined) parts.push(`≥ ${low}`);
  else if (node.maximum !== undefined) parts.push(`≤ ${node.maximum}`);
  if (node.minItems !== undefined && node.minItems > 0) parts.push(`at least ${node.minItems} item${node.minItems === 1 ? "" : "s"}`);
  if (node.maxItems !== undefined) parts.push(`at most ${node.maxItems} items`);
  if (node.maxLength !== undefined) parts.push(`at most ${node.maxLength} characters`);
  if (node.pattern !== undefined) {
    parts.push(node.pattern.length > 60 ? "a pattern, see `src/config.ts`" : `matches \`${node.pattern.replaceAll("|", "\\|")}\``);
  }
  if (node.type === "array" && node.items !== undefined) {
    const item = describeLimits(node.items);
    if (item !== "") parts.push(`each ${item}`);
  }
  for (const variant of node.anyOf ?? node.oneOf ?? []) {
    const limits = describeLimits(variant);
    if (limits !== "") parts.push(limits);
  }
  return parts.join("; ");
}

type Leaf = { path: string[]; node: JsonSchema; required: boolean; when: string[]; inherited: { value: unknown; from: string[] } | undefined };

/**
 * Every leaf under `node`. Objects recurse, arrays of objects recurse as `name[]`, unions of objects
 * merge. `required` is local: the enclosing object needs the key. `inherited` carries a value from the
 * nearest enclosing object's default.
 */
function leaves(node: JsonSchema, path: string[], required: boolean, when: string[], inherited: Leaf["inherited"] = undefined): Leaf[] {
  const own = node.default !== undefined && typeof node.default === "object" && node.default !== null && Object.keys(node.default).length > 0;
  const carried = own ? { value: node.default, from: path } : inherited;
  const variants = variantsOf(node);
  if (variants !== undefined) {
    const tag = variants.length > 1 ? discriminator(variants) : undefined;
    return variants.flatMap((variant) => {
      const values = tag === undefined ? [] : tagValues(variant.properties![tag])!;
      const condition = tag === undefined ? [] : [`\`${[...path, tag].join(".")}\` is ${values.map((value) => `\`${JSON.stringify(value)}\``).join(" or ")}`];
      const { anyOf: _anyOf, oneOf: _oneOf, ...plain } = variant;
      return leaves(plain, path, required, [...when, ...condition], carried);
    });
  }
  if (node.properties !== undefined) {
    return Object.entries(node.properties).flatMap(([name, child]) => {
      const value = carried === undefined ? undefined : (carried.value as Record<string, unknown>)[name];
      return leaves(child, [...path, name], (node.required ?? []).includes(name), when, value === undefined ? undefined : { value, from: carried!.from });
    });
  }
  if (node.type === "array" && (node.items?.properties !== undefined || (node.items !== undefined && variantsOf(node.items) !== undefined))) {
    return leaves(node.items!, [...path.slice(0, -1), `${path.at(-1)}[]`], true, when);
  }
  return [{ path, node, required, when, inherited: carried }];
}

/** Path segments with `name[]` read as element 0. */
function segments(path: readonly string[]): (string | number)[] {
  return path.flatMap((part) => (part.endsWith("[]") ? [part.slice(0, -2), 0] : [part]));
}

function getAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function deleteAt(value: unknown, path: readonly (string | number)[]): boolean {
  const parent = getAt(value, path.slice(0, -1));
  if (parent === null || typeof parent !== "object" || !(path.at(-1)! in parent)) return false;
  delete (parent as Record<string | number, unknown>)[path.at(-1)!];
  return true;
}

/** What the parser fills in when the key, or the nearest enclosing object it can drop, is left out. */
function probeDefault(example: unknown, path: readonly (string | number)[]): string | undefined {
  for (let length = path.length; length >= 1; length -= 1) {
    if (typeof path[length - 1] === "number") continue;
    const copy = structuredClone(example);
    if (!deleteAt(copy, path.slice(0, length))) {
      if (length === path.length) continue;
      return undefined;
    }
    const parsed = agentTagConfigSchema.safeParse(copy);
    if (!parsed.success) continue;
    const value = getAt(parsed.data, path);
    if (value === undefined) return undefined;
    const omitted = length === path.length ? "" : ` when \`${path.slice(0, length).join(".").replaceAll(".0", "[]")}\` is omitted`;
    return `\`${JSON.stringify(value)}\`${omitted}`;
  }
  return undefined;
}

export function configKeys(example: unknown): ConfigKey[] {
  const schema = z.toJSONSchema(agentTagConfigSchema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const merged = new Map<string, ConfigKey & { types: Set<string>; limitSet: Set<string>; whens: Set<string>; always: boolean }>();
  const variantCounts = new Map<string, number>();
  for (const leaf of leaves(schema, [], true, [])) {
    const path = leaf.path.join(".");
    const known =
      leaf.node.default !== undefined
        ? `\`${JSON.stringify(leaf.node.default)}\``
        : (probeDefault(example, segments(leaf.path)) ??
          (leaf.inherited === undefined
            ? undefined
            : `\`${JSON.stringify(leaf.inherited.value)}\` when \`${leaf.inherited.from.join(".")}\` is omitted`) ??
          (leaf.required ? "required" : "optional"));
    const entry = merged.get(path) ?? {
      path,
      type: "",
      limits: "",
      default: known,
      when: "",
      types: new Set<string>(),
      limitSet: new Set<string>(),
      whens: new Set<string>(),
      always: false,
    };
    entry.types.add(describeType(leaf.node));
    const limits = describeLimits(leaf.node);
    if (limits !== "") entry.limitSet.add(limits);
    if (leaf.when.length === 0) entry.always = true;
    else entry.whens.add(leaf.when.join(" and "));
    if (["optional", "required"].includes(entry.default) && known !== entry.default && known !== "optional") entry.default = known;
    merged.set(path, entry);
    variantCounts.set(path, (variantCounts.get(path) ?? 0) + 1);
  }
  return [...merged.values()].map(({ types, limitSet, whens, always, ...entry }) => {
    // A key every variant has (such as `t3.tokenFile`) needs no condition.
    const allVariants = whens.size > 1 && [...whens].every((when) => !when.includes(" and "));
    return {
      ...entry,
      type: [...types].join(" or "),
      limits: [...limitSet].join("; "),
      when: always || allVariants || path_isDiscriminator(entry.path, whens) ? "" : [...whens].join(", or "),
    };
  });
}

/** The discriminator itself (`t3.mode`) is listed once with all its values, unconditionally. */
function path_isDiscriminator(path: string, whens: ReadonlySet<string>): boolean {
  return [...whens].every((when) => when.startsWith(`\`${path}\` is `));
}

export function renderConfigDocs(keys: readonly ConfigKey[]): string {
  const sections = new Map<string, ConfigKey[]>();
  for (const key of keys) {
    const top = key.path.split(/[.[]/)[0]!;
    sections.set(top, [...(sections.get(top) ?? []), key]);
  }
  const cell = (text: string) => (text === "" ? "—" : text);
  const lines = [
    "# Configuration reference",
    "",
    "<!-- Generated by `bun run docs:config` from `agentTagConfigSchema` in src/config.ts. Do not edit by hand. -->",
    "",
    "Every key `agent-tag.json` accepts. **Default** is what the parser uses when the key is left out: `required` means the enclosing object is rejected without it, and `optional` means unset. A default \"when `x` is omitted\" applies only if that whole enclosing object is left out; if you write the object, write its required keys too. **Only when** names the variant a key belongs to.",
    "",
    "Paths like `/var/lib/...` must be absolute, Slack IDs are uppercase (`T…`, `C…`, `U…`), and cross-key rules (a route's profile must exist, admins must be allowed users, and so on) are checked after these. [Operations](operations.md) explains what each area does, and `config/agent-tag.example.json` is a complete example.",
    "",
  ];
  for (const [section, sectionKeys] of sections) {
    lines.push(`## \`${section}\``, "", "| Key | Type | Limits | Default | Only when |", "| --- | --- | --- | --- | --- |");
    for (const key of sectionKeys) {
      lines.push(`| \`${key.path}\` | ${cell(key.type)} | ${cell(key.limits)} | ${key.default} | ${cell(key.when)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function generateConfigDocs(repository = REPOSITORY): string {
  const example = JSON.parse(readFileSync(join(repository, "config/agent-tag.example.json"), "utf8"));
  return renderConfigDocs(configKeys(example));
}

if (import.meta.main) {
  const markdown = generateConfigDocs();
  if (process.argv.includes("--stdout")) process.stdout.write(markdown);
  else writeFileSync(join(REPOSITORY, "docs/configuration.md"), markdown);
}
