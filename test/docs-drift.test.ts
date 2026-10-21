import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IMPLEMENTED_COMMANDS } from "../src/commands/parse.ts";
import { HELP_TEXT } from "../src/distribution.ts";
import { AUDIT_ACTIONS } from "../src/store/schema.ts";
import {
  checkAgentCommands,
  checkAuditActions,
  checkBunScripts,
  checkCliCommands,
  checkLinks,
  checkManifest,
  headingAnchors,
  helpCommands,
  readDocs,
  readLinkedDocs,
} from "../scripts/docs-drift.ts";
import { configKeys, generateConfigDocs } from "../scripts/gen-config-docs.ts";

const REPOSITORY = resolve(import.meta.dir, "..");
const docs = readDocs(REPOSITORY);
const read = (path: string) => readFileSync(join(REPOSITORY, path), "utf8");
const readIfExists = (path: string) => (existsSync(join(REPOSITORY, path)) ? read(path) : undefined);
const manifest = read("config/slack-manifest.example.json");
const slackSetup = read("docs/slack-setup.md");
const commands = helpCommands(HELP_TEXT);

describe("docs drift", () => {
  test("the Slack setup manifest block and admin scope table match the manifest", () => {
    expect(checkManifest(slackSetup, manifest)).toEqual([]);
  });

  test("every CLI command is documented and every documented command exists", () => {
    expect(commands.size).toBeGreaterThanOrEqual(18);
    expect(checkCliCommands(docs, commands)).toEqual([]);
  });

  test("every `bun run` in the docs is a package.json script", async () => {
    const { scripts } = (await Bun.file(join(REPOSITORY, "package.json")).json()) as { scripts: Record<string, string> };
    expect(checkBunScripts(docs, scripts)).toEqual([]);
  });

  test("every implemented !command is in the Slack usage doc", () => {
    expect(checkAgentCommands(read("docs/slack-usage.md"), IMPLEMENTED_COMMANDS)).toEqual([]);
  });

  test("relative links and anchors resolve in every doc, evidence included", () => {
    const linked = readLinkedDocs(REPOSITORY);
    expect(linked.length).toBeGreaterThan(docs.length);
    expect(checkLinks(linked, REPOSITORY, readIfExists)).toEqual([]);
  });

  test("every audit action has exactly one row in docs/audit-actions.md", () => {
    expect(checkAuditActions(read("docs/audit-actions.md"), AUDIT_ACTIONS)).toEqual([]);
  });

  test("docs/configuration.md is what `bun run docs:config` generates", () => {
    expect(read("docs/configuration.md")).toBe(generateConfigDocs(REPOSITORY));
  });

  test("the config reference lists every schema key exactly once", () => {
    const keys = configKeys(JSON.parse(read("config/agent-tag.example.json")));
    // The count when the generator landed; a generator branch that silently drops keys fails here.
    expect(keys.length).toBeGreaterThanOrEqual(127);
    const reference = read("docs/configuration.md");
    for (const key of ["limits.stalledTurn.timeoutSeconds", "profiles[].memory.retentionDays", "routes[].ownerUserId", "t3.rotation.rotateBeforeDays"]) {
      expect(keys.map((entry) => entry.path)).toContain(key);
    }
    for (const { path } of keys) {
      expect(reference.split(`| \`${path}\` |`).length - 1).toBe(1);
    }
  });
});

describe("docs drift checks catch broken docs", () => {
  test("a manifest mismatch", () => {
    const changed = JSON.stringify({ ...JSON.parse(manifest), oauth_config: { scopes: { bot: ["chat:write"] } } });
    expect(checkManifest(slackSetup, changed).length).toBe(2);
  });

  test("a scope missing from the admin table", () => {
    const without = slackSetup.replace(/^\| `users:read` \|.*\n/m, "");
    expect(checkManifest(without, manifest)).toEqual([expect.stringContaining('"For the Slack admin" lists')]);
  });

  test("a stale and an undocumented command", () => {
    const stale = [{ path: "docs/x.md", text: "```sh\nagent-tag frobnicate CONFIG\n```\n" }];
    expect(checkCliCommands(stale, new Set(["run"]))).toEqual([
      "`agent-tag run` is not mentioned in any doc",
      "docs/x.md: `agent-tag frobnicate` is not a CLI command",
    ]);
  });

  test("an unknown bun script", () => {
    expect(checkBunScripts([{ path: "docs/x.md", text: "Run `bun run nope` first." }], { check: "x" })).toEqual([
      "docs/x.md: `bun run nope` is not a package.json script",
    ]);
  });

  test("a missing, a duplicated and an unknown audit action", () => {
    const reference = "| `access.denied` | x | — |\n| `access.denied` | y | — |\n| `made.up` | z | — |\n";
    expect(checkAuditActions(reference, ["access.denied", "ambient.decided"])).toEqual([
      "docs/audit-actions.md has 2 rows for `access.denied`, expected 1",
      "docs/audit-actions.md has 0 rows for `ambient.decided`, expected 1",
      "docs/audit-actions.md lists `made.up`, which is not an audit action",
    ]);
  });

  test("an undocumented !command", () => {
    expect(checkAgentCommands("Use !help.", ["help", "mute"])).toEqual(["docs/slack-usage.md does not mention `!mute`"]);
  });

  test("a broken link and a broken anchor", () => {
    const fixture = [{ path: "docs/x.md", text: "[a](missing.md) [b](slack-setup.md#no-such-heading) [c](slack-setup.md#4-verify-and-start)" }];
    expect(checkLinks(fixture, REPOSITORY, readIfExists)).toEqual([
      "docs/x.md: link missing.md points at a missing file",
      "docs/x.md: link slack-setup.md#no-such-heading has no heading #no-such-heading in docs/slack-setup.md",
    ]);
  });

  test("GitHub anchors drop punctuation and number duplicates", () => {
    expect([...headingAnchors("# GitHub pull requests (draft PRs, `auto` mode)\n## Notes\n## Notes\n")]).toEqual([
      "github-pull-requests-draft-prs-auto-mode",
      "notes",
      "notes-1",
    ]);
  });
});
