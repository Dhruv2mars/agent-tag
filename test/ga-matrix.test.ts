import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkGaMatrix, GA_CRITICAL_PR_IDS, readRepositoryInputs, type MatrixInputs } from "../scripts/ga-matrix.ts";

const REPOSITORY = resolve(import.meta.dir, "..");

const HEADER = [
  "| ID | Capability | Claude Tag ref | Spec Done | Evidence | Kind | Status | Build |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];
const CRITICAL = `(${GA_CRITICAL_PR_IDS.join(",")})`;

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** A small consistent matrix: one PASS on real evidence, one owner row, one fixture row. */
function fixture(): MatrixInputs {
  return {
    matrix: [
      "# GA acceptance",
      "",
      ...HEADER,
      row(["T3-01", "Probe", "concepts/how-it-works", `legacy ${CRITICAL}`, "docs/evidence/2026-01-01-real.md", "automated-real", "PASS", "0.1.0-rc.1"]),
      row(["SLK-01", "Thread context", "users/when-claude-responds", "PR-G D1", "—", "owner-session", "PENDING-OWNER-SESSION", "—"]),
      row(["DOC-01", "Docs match code", "—", "PR-U D2", "docs/evidence/2026-01-01-fixture.md", "automated-fixture", "PASS", "0.1.0-rc.1"]),
      "",
    ].join("\n"),
    index: [
      "path\tdate\tbuild\tplatform\tt3\tproviders\tactor\trows",
      "docs/evidence/2026-01-01-real.md\t2026-01-01\tabc\tdarwin-arm64\t0.0.45\tcodex\tautomated-real\tT3-01",
      "docs/evidence/2026-01-01-fixture.md\t2026-01-01\tabc\tdarwin-arm64\tnone\tnone\tautomated-fixture\tDOC-01",
    ].join("\n"),
    evidenceFiles: ["docs/evidence/2026-01-01-real.md", "docs/evidence/2026-01-01-fixture.md"],
    decisions: "ts\tphase\tdecision\twhy\tevidence\tresult\n2026-01-01T00:00:00Z\tga\tSLK-01 waits for the owner session\twhy\tdocs/owner-session.md\theld\n",
    ownerSession: "### 3. G\n- **Matrix rows:** SLK-01\n",
    gate: false,
  };
}

function withRow(inputs: MatrixInputs, from: string, to: string): MatrixInputs {
  if (!inputs.matrix.includes(from)) throw new Error(`fixture has no "${from}"`);
  return { ...inputs, matrix: inputs.matrix.replace(from, to) };
}

describe("GA matrix", () => {
  test("the repository's matrix, evidence index, decisions and owner script agree", async () => {
    expect(checkGaMatrix(await readRepositoryInputs(REPOSITORY, false))).toEqual([]);
  });

  test("the release gate rejects the repository's open rows until the owner session resolves them", async () => {
    const problems = checkGaMatrix(await readRepositoryInputs(REPOSITORY, true));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.includes("AGENT_TAG_GA_GATE=1"))).toBe(true);
  });

  test("a well-formed fixture passes", () => {
    expect(checkGaMatrix(fixture())).toEqual([]);
  });

  test("a missing column fails", () => {
    const inputs = fixture();
    const problems = checkGaMatrix({ ...inputs, matrix: inputs.matrix.replace(" Build |", "").replace(" --- | --- |\n", " --- |\n") });
    expect(problems.join("\n")).toContain("matrix columns are");
  });

  test("a row with the wrong number of cells fails", () => {
    const problems = checkGaMatrix(withRow(fixture(), "| PENDING-OWNER-SESSION | — |", "| PENDING-OWNER-SESSION |"));
    expect(problems.join("\n")).toContain("SLK-01 (line 6) has 7 cells");
  });

  test("evidence that does not exist fails", () => {
    const problems = checkGaMatrix(withRow(fixture(), "docs/evidence/2026-01-01-real.md |", "docs/evidence/2026-01-01-real.md; docs/evidence/missing.md |"));
    expect(problems).toContain("matrix row T3-01 (line 5): evidence docs/evidence/missing.md does not exist");
  });

  test("free-text evidence fails", () => {
    const problems = checkGaMatrix(withRow(fixture(), "| — | owner-session |", "| ran it by hand | owner-session |"));
    expect(problems.join("\n")).toContain('evidence "ran it by hand" is not under docs/evidence/');
  });

  test("an evidence file missing from the index fails, and so does an index row without a file", () => {
    const inputs = fixture();
    const extraFile = checkGaMatrix({ ...inputs, evidenceFiles: [...inputs.evidenceFiles, "docs/evidence/2026-01-02-new.md"] });
    expect(extraFile).toContain("docs/evidence/2026-01-02-new.md is not listed in docs/evidence/index.tsv");
    const extraRow = checkGaMatrix({ ...inputs, evidenceFiles: inputs.evidenceFiles.slice(0, 1) });
    expect(extraRow).toContain("index.tsv lists docs/evidence/2026-01-01-fixture.md, which does not exist");
  });

  test("an index row naming an unknown matrix row or actor fails", () => {
    const inputs = fixture();
    const problems = checkGaMatrix({ ...inputs, index: inputs.index.replace("automated-real\tT3-01", "robot\tT3-99") });
    expect(problems).toContain('index.tsv docs/evidence/2026-01-01-real.md: unknown actor "robot"');
    expect(problems).toContain("index.tsv docs/evidence/2026-01-01-real.md: row T3-99 is not in the matrix");
  });

  test("fixture evidence cannot pass a row outside the allow-list", () => {
    const problems = checkGaMatrix(
      withRow(fixture(), "docs/evidence/2026-01-01-real.md | automated-real |", "docs/evidence/2026-01-01-fixture.md | automated-fixture |"),
    );
    expect(problems).toContain("matrix row T3-01 (line 5): Kind automated-fixture is only allowed for DOC-01, REL-01");
    expect(problems).toContain("matrix row T3-01 (line 5) is PASS without evidence from an allowed actor ()");
  });

  test("a real-Kind PASS on fixture-only evidence fails", () => {
    const problems = checkGaMatrix(withRow(fixture(), "docs/evidence/2026-01-01-real.md | automated-real |", "docs/evidence/2026-01-01-fixture.md | automated-real |"));
    expect(problems).toContain("matrix row T3-01 (line 5) is PASS without evidence from an allowed actor (automated-real)");
  });

  test("an owner-session PASS needs human evidence", () => {
    const problems = checkGaMatrix(
      withRow(fixture(), "| — | owner-session | PENDING-OWNER-SESSION | — |", "| docs/evidence/2026-01-01-real.md | owner-session; automated-real | PASS | 0.1.0-rc.1 |"),
    );
    expect(problems).toContain("matrix row SLK-01 (line 6) is PASS but its owner-session half has no human evidence");
  });

  test("PENDING passes without the gate and fails under it", () => {
    expect(checkGaMatrix(fixture())).toEqual([]);
    expect(checkGaMatrix({ ...fixture(), gate: true })).toEqual([
      "matrix row SLK-01 (line 6) is PENDING-OWNER-SESSION; AGENT_TAG_GA_GATE=1 requires every row resolved",
    ]);
  });

  test("FAIL passes without the gate and fails under it", () => {
    const failing = withRow(fixture(), "| automated-real | PASS | 0.1.0-rc.1 |", "| automated-real | FAIL | 0.1.0-rc.1 |");
    const decided = { ...failing, decisions: `${failing.decisions}2026-01-01T00:00:00Z\tga\tT3-01 fails until the rerun\twhy\tdocs/evidence/2026-01-01-real.md\theld\n` };
    expect(checkGaMatrix(decided)).toEqual([]);
    expect(checkGaMatrix({ ...decided, gate: true })).toContain(
      "matrix row T3-01 (line 5) is FAIL; AGENT_TAG_GA_GATE=1 requires every row resolved",
    );
  });

  test("a GA-critical PR ID missing from Spec Done fails", () => {
    const problems = checkGaMatrix(withRow(fixture(), ",U1)", ")"));
    expect(problems).toEqual(["GA-critical PR U1 is not named in any row's Spec Done column"]);
  });

  test("an owner-session row the script never names fails", () => {
    const problems = checkGaMatrix({ ...fixture(), ownerSession: "### 3. G\n- **Matrix rows:** SLK-010\n" });
    expect(problems).toEqual(["matrix row SLK-01 (line 6) needs an owner session but docs/owner-session.md never names it"]);
  });

  test("a non-PASS row without a ga decision fails", () => {
    const inputs = fixture();
    const problems = checkGaMatrix({ ...inputs, decisions: inputs.decisions.replace("\tga\t", "\tbuild\t") });
    expect(problems).toEqual(['matrix row SLK-01 (line 6) is PENDING-OWNER-SESSION but no "ga" row in docs/audit/decisions.tsv names it']);
  });

  test("unknown Kind and Status values fail", () => {
    const problems = checkGaMatrix(withRow(fixture(), "| owner-session | PENDING-OWNER-SESSION |", "| manual | PENDING |"));
    expect(problems).toContain('matrix row SLK-01 (line 6): unknown Kind "manual"');
    expect(problems).toContain('matrix row SLK-01 (line 6): unknown Status "PENDING"');
  });
});
