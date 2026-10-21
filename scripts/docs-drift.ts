// Checks that the docs still match the code: the Slack manifest and scope table,
// the CLI commands, `bun run` scripts, `!commands`, and relative links with their
// anchors. `test/docs-drift.test.ts` runs each check; every check is a pure function
// over file contents so the tests can feed it broken fixtures.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export type DocFile = { path: string; text: string };

/** README, SECURITY and docs/*.md. Evidence files and architecture records are frozen history. */
export function readDocs(repository: string): DocFile[] {
  const paths = ["README.md", "SECURITY.md", ...readdirSync(join(repository, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  return paths.map((path) => ({ path, text: readFileSync(join(repository, path), "utf8") }));
}

function fencedBlocks(markdown: string, language?: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(/^```([a-z]*)\n([\s\S]*?)^```$/gm)) {
    if (language === undefined || match[1] === language) blocks.push(match[2]!);
  }
  return blocks;
}

/** The slack-setup JSON block must equal the manifest, and the admin table must list exactly its bot scopes. */
export function checkManifest(slackSetup: string, manifest: string): string[] {
  const problems: string[] = [];
  const expected = JSON.parse(manifest);
  const blocks = fencedBlocks(slackSetup, "json");
  if (blocks.length !== 1) problems.push(`docs/slack-setup.md has ${blocks.length} json blocks, expected the manifest only`);
  else if (!Bun.deepEquals(JSON.parse(blocks[0]!), expected)) problems.push("docs/slack-setup.md manifest block differs from config/slack-manifest.example.json");
  const section = slackSetup.split("### For the Slack admin")[1]?.split(/\n### /)[0] ?? "";
  const tableScopes = [...section.matchAll(/^\| `([a-z:._]+)` \|/gm)].map((match) => match[1]!).sort();
  const manifestScopes = [...(expected.oauth_config?.scopes?.bot ?? [])].sort();
  if (tableScopes.join(" ") !== manifestScopes.join(" ")) {
    problems.push(`"For the Slack admin" lists [${tableScopes.join(", ")}], the manifest has [${manifestScopes.join(", ")}]`);
  }
  return problems;
}

/** First words of the `agent-tag <command>` lines in the CLI help. */
export function helpCommands(helpText: string): Set<string> {
  return new Set([...helpText.matchAll(/^\s+agent-tag ([a-z][a-z0-9-]*)/gm)].map((match) => match[1]!));
}

/** Every CLI command is documented, and every `agent-tag <word>` in a code block is a real command. */
export function checkCliCommands(docs: readonly DocFile[], commands: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const all = docs.map((doc) => doc.text).join("\n");
  for (const command of commands) {
    if (!new RegExp(`\\bagent-tag ${command}\\b`).test(all)) problems.push(`\`agent-tag ${command}\` is not mentioned in any doc`);
  }
  for (const doc of docs) {
    for (const block of fencedBlocks(doc.text)) {
      for (const match of block.matchAll(/(?<![\w./-])agent-tag ([a-z][a-z0-9-]*)/g)) {
        if (!commands.has(match[1]!)) problems.push(`${doc.path}: \`agent-tag ${match[1]}\` is not a CLI command`);
      }
    }
  }
  return problems;
}

/** `bun run <name>` names a package.json script (not a file path such as src/cli.ts). */
export function checkBunScripts(docs: readonly DocFile[], scripts: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const doc of docs) {
    for (const match of doc.text.matchAll(/bun run ([A-Za-z0-9:_-]+)(?![\w./<:-])/g)) {
      if (!(match[1]! in scripts)) problems.push(`${doc.path}: \`${match[0]}\` is not a package.json script`);
    }
  }
  return problems;
}

/** Each implemented `!command` appears in the Slack usage doc. */
export function checkAgentCommands(slackUsage: string, commands: readonly string[]): string[] {
  return commands.filter((name) => !slackUsage.includes(`!${name}`)).map((name) => `docs/slack-usage.md does not mention \`!${name}\``);
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const withoutCode = markdown.replace(/^```[\s\S]*?^```$/gm, "");
  for (const match of withoutCode.matchAll(/^#{1,6} (.+)$/gm)) {
    const base = match[1]!
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

/** Relative links resolve to a file, and `#anchors` to a heading in it. */
export function checkLinks(docs: readonly DocFile[], repository: string, readFile: (path: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const doc of docs) {
    const text = doc.text.replace(/^```[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "");
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      const [pathPart = "", anchor] = target.split("#");
      const resolved = pathPart === "" ? doc.path : normalize(join(dirname(doc.path), pathPart));
      if (resolved.startsWith("..")) {
        problems.push(`${doc.path}: link ${target} leaves the repository`);
        continue;
      }
      if (!existsSync(join(repository, resolved))) {
        problems.push(`${doc.path}: link ${target} points at a missing file`);
        continue;
      }
      if (anchor !== undefined && resolved.endsWith(".md")) {
        const content = readFile(resolved);
        if (content !== undefined && !headingAnchors(content).has(anchor)) {
          problems.push(`${doc.path}: link ${target} has no heading #${anchor} in ${relative(".", resolved)}`);
        }
      }
    }
  }
  return problems;
}
