// Parses and checks docs/ga-acceptance.md against the evidence index, the
// decisions log and the owner-session script. `test/ga-matrix.test.ts` runs it;
// `bun run scripts/ga-matrix.ts` prints the problems for a human.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MATRIX_COLUMNS = ["ID", "Capability", "Claude Tag ref", "Spec Done", "Evidence", "Kind", "Status", "Build"] as const;
export const KINDS = ["automated-real", "owner-session", "automated-fixture"] as const;
export const STATUSES = ["PASS", "FAIL", "UNCONFIRMED", "OUT-OF-SCOPE", "PENDING-OWNER-SESSION"] as const;
export const ACTORS = ["human", "automated-real", "automated-fixture"] as const;

/** Rows whose capability is local logic, so fixture evidence may pass them (PR-U §3.3). */
export const FIXTURE_ALLOWED_ROWS = ["DOC-01", "REL-01"] as const;

/**
 * GA-critical (C) PR IDs from the WAVES plan, copied at U1 time. WAVES lives
 * outside the repository, so the list is a constant here.
 */
export const GA_CRITICAL_PR_IDS = [
  "G1", "G2", "G3", "I1", "I2", "J1", "J2", "J3", "O1", "O2", "O3", "O4", "M1", "M2",
  "F1", "F2", "F3", "F4", "P2a", "P2b", "P2c", "H1", "H2", "K1", "K2", "K3", "N1", "N2",
  "L1", "L2", "L3", "Q1", "U1",
] as const;

const ACTOR_FOR_KIND: Record<(typeof KINDS)[number], (typeof ACTORS)[number]> = {
  "automated-real": "automated-real",
  "owner-session": "human",
  "automated-fixture": "automated-fixture",
};

export type MatrixRow = Record<(typeof MATRIX_COLUMNS)[number], string> & { line: number };
export type IndexRow = { path: string; date: string; build: string; platform: string; t3: string; providers: string; actor: string[]; rows: string[] };

export type MatrixInputs = {
  matrix: string;
  index: string;
  /** Paths (`docs/evidence/<name>`) of the evidence files on disk. */
  evidenceFiles: readonly string[];
  decisions: string;
  ownerSession: string;
  gate: boolean;
};

function cells(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
}

export function parseMatrix(markdown: string): { header: string[] | undefined; rows: MatrixRow[] } {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| ID |"));
  if (start === -1) return { header: undefined, rows: [] };
  const header = cells(lines[start]!);
  const rows: MatrixRow[] = [];
  for (let index = start + 2; index < lines.length && lines[index]!.startsWith("|"); index += 1) {
    const values = cells(lines[index]!);
    const row = { line: index + 1 } as MatrixRow;
    header.forEach((name, column) => {
      (row as Record<string, string>)[name] = values[column] ?? "";
    });
    if (values.length !== header.length) (row as Record<string, string>)["__columns"] = String(values.length);
    rows.push(row);
  }
  return { header, rows };
}

export function parseIndex(tsv: string): { header: string[]; rows: IndexRow[] } {
  const [headerLine = "", ...lines] = tsv.trimEnd().split("\n");
  const header = headerLine.split("\t");
  const rows = lines.map((line) => {
    const [path = "", date = "", build = "", platform = "", t3 = "", providers = "", actor = "", rowIds = ""] = line.split("\t");
    return { path, date, build, platform, t3, providers, actor: actor.split(","), rows: rowIds.split(",") };
  });
  return { header, rows };
}

function evidencePaths(cell: string): string[] {
  if (cell === "—") return [];
  return cell.split(";").map((part) => part.trim());
}

/** Returns one message per problem; an empty list means the matrix is consistent. */
export function checkGaMatrix(inputs: MatrixInputs): string[] {
  const problems: string[] = [];
  const { header, rows } = parseMatrix(inputs.matrix);
  if (header === undefined) return ["docs/ga-acceptance.md has no `| ID |` table"];
  if (header.join("|") !== MATRIX_COLUMNS.join("|")) {
    problems.push(`matrix columns are [${header.join(", ")}], expected [${MATRIX_COLUMNS.join(", ")}]`);
    return problems;
  }

  const index = parseIndex(inputs.index);
  if (index.header.join("\t") !== "path\tdate\tbuild\tplatform\tt3\tproviders\tactor\trows") {
    problems.push(`index.tsv header is "${index.header.join(" ")}"`);
  }
  const indexed = new Map(index.rows.map((row) => [row.path, row]));
  const onDisk = new Set(inputs.evidenceFiles);
  for (const path of onDisk) if (!indexed.has(path)) problems.push(`${path} is not listed in docs/evidence/index.tsv`);
  const ids = new Set(rows.map((row) => row.ID));
  for (const row of index.rows) {
    if (!onDisk.has(row.path)) problems.push(`index.tsv lists ${row.path}, which does not exist`);
    for (const actor of row.actor) {
      if (!(ACTORS as readonly string[]).includes(actor)) problems.push(`index.tsv ${row.path}: unknown actor "${actor}"`);
    }
    for (const id of row.rows) if (!ids.has(id)) problems.push(`index.tsv ${row.path}: row ${id} is not in the matrix`);
  }

  const decisionLines = inputs.decisions.split("\n").slice(1).filter((line) => line.split("\t")[1] === "ga");
  const seen = new Set<string>();
  for (const row of rows) {
    const where = `matrix row ${row.ID} (line ${row.line})`;
    const columnCount = (row as Record<string, string>)["__columns"];
    if (columnCount !== undefined) problems.push(`${where} has ${columnCount} cells, expected ${MATRIX_COLUMNS.length}`);
    if (seen.has(row.ID)) problems.push(`${where} is a duplicate ID`);
    seen.add(row.ID);
    for (const column of MATRIX_COLUMNS) if (row[column] === "") problems.push(`${where} has an empty ${column} cell`);

    const kinds = row.Kind.split(";").map((kind) => kind.trim());
    for (const kind of kinds) if (!(KINDS as readonly string[]).includes(kind)) problems.push(`${where}: unknown Kind "${kind}"`);
    if (kinds.includes("automated-fixture") && !(FIXTURE_ALLOWED_ROWS as readonly string[]).includes(row.ID)) {
      problems.push(`${where}: Kind automated-fixture is only allowed for ${FIXTURE_ALLOWED_ROWS.join(", ")}`);
    }
    if (!(STATUSES as readonly string[]).includes(row.Status)) problems.push(`${where}: unknown Status "${row.Status}"`);

    const paths = evidencePaths(row.Evidence);
    for (const path of paths) {
      if (!path.startsWith("docs/evidence/")) problems.push(`${where}: evidence "${path}" is not under docs/evidence/`);
      else if (!onDisk.has(path)) problems.push(`${where}: evidence ${path} does not exist`);
      else if (!indexed.has(path)) problems.push(`${where}: evidence ${path} is not indexed`);
    }

    if (row.Status === "PASS") {
      // A PASS needs at least one cited file whose actor matches one of the row's Kinds,
      // and only fixture-allowed rows may pass on fixture evidence.
      const allowedActors = new Set(
        kinds
          .filter((kind) => kind !== "automated-fixture" || (FIXTURE_ALLOWED_ROWS as readonly string[]).includes(row.ID))
          .map((kind) => ACTOR_FOR_KIND[kind as (typeof KINDS)[number]]),
      );
      const qualifying = paths.filter((path) => indexed.get(path)?.actor.some((actor) => allowedActors.has(actor as never)));
      if (qualifying.length === 0) problems.push(`${where} is PASS without evidence from an allowed actor (${[...allowedActors].join(", ")})`);
      if (kinds.includes("owner-session") && !paths.some((path) => indexed.get(path)?.actor.includes("human"))) {
        problems.push(`${where} is PASS but its owner-session half has no human evidence`);
      }
      if (row.Build === "—") problems.push(`${where} is PASS without a Build`);
    } else {
      const pattern = new RegExp(`(^|[^A-Za-z0-9-])${row.ID.replace(/[-]/g, "\\-")}([^A-Za-z0-9-]|$)`);
      if (!decisionLines.some((line) => pattern.test(line))) {
        problems.push(`${where} is ${row.Status} but no "ga" row in docs/audit/decisions.tsv names it`);
      }
    }
    if (inputs.gate && row.Status.startsWith("PENDING")) problems.push(`${where} is ${row.Status}; AGENT_TAG_GA_GATE=1 requires every row resolved`);

    if (kinds.includes("owner-session") && !new RegExp(`\\b${row.ID}\\b`).test(inputs.ownerSession)) {
      problems.push(`${where} needs an owner session but docs/owner-session.md never names it`);
    }
  }

  const specCells = rows.map((row) => row["Spec Done"]).join(" ");
  for (const id of GA_CRITICAL_PR_IDS) {
    if (!new RegExp(`[(,]${id}[,)]`).test(specCells)) problems.push(`GA-critical PR ${id} is not named in any row's Spec Done column`);
  }
  return problems;
}

export async function readRepositoryInputs(repository: string, gate: boolean): Promise<MatrixInputs> {
  const read = (path: string) => Bun.file(join(repository, path)).text();
  const names = await readdir(join(repository, "docs/evidence"));
  return {
    matrix: await read("docs/ga-acceptance.md"),
    index: await read("docs/evidence/index.tsv"),
    evidenceFiles: names.filter((name) => name.endsWith(".md") && !name.startsWith("TEMPLATE-")).map((name) => `docs/evidence/${name}`),
    decisions: await read("docs/audit/decisions.tsv"),
    ownerSession: await read("docs/owner-session.md"),
    gate,
  };
}

if (import.meta.main) {
  const inputs = await readRepositoryInputs(resolve(import.meta.dir, ".."), process.env.AGENT_TAG_GA_GATE === "1");
  const problems = checkGaMatrix(inputs);
  const { rows } = parseMatrix(inputs.matrix);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.Status, (counts.get(row.Status) ?? 0) + 1);
  console.log([...counts].map(([status, count]) => `${status} ${count}`).join(", "));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
