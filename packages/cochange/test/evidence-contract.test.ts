import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readEvidence } from "../src/risk/evidence-inputs.ts";
import { readLocalityFanIn } from "../src/risk/composition.ts";
import { reportPath } from "../src/reports.ts";

/**
 * What change-risk reads from the other plugins is checked against their own committed golden outputs,
 * which `check:schemas` validates against their real JSON schemas. Nothing here is a shape this repository
 * made up: if a plugin changes its output, this is where change-risk finds out.
 */
const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const golden = (...parts: string[]): string => join(packages, ...parts);
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { inputs: Record<string, any>; repo: { head: string }; config: string; results: Record<string, any>[] };

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "evidence-contract-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("structure check, as the structure plugin prints it", () => {
  const file = golden("structure", "test", "golden", "layers", "check.violations.json");
  const document = read(file);

  test("every row of its results is a finding, and its own base and tip are the ones checked", () => {
    const { baseSha, analysed } = document.inputs;
    const evidence = readEvidence(scratch, [file], { base: baseSha, head: analysed, worktree: false });
    expect(evidence.structure!.findings).toEqual(document.results.map((row) => ({ kind: row.kind, id: row.id })));
    expect(evidence.structure!.findings.length).toBeGreaterThan(0);
  });

  test("a check made from another base, or up to another tip, describes another change", () => {
    const { baseSha, analysed } = document.inputs;
    expect(() => readEvidence(scratch, [file], { base: "0".repeat(40), head: analysed, worktree: false })).toThrow(/starts at/);
    expect(() => readEvidence(scratch, [file], { base: baseSha, head: "1".repeat(40), worktree: false })).toThrow(/ends at/);
  });

  test("a change in the working tree is not held to the commit the check analysed", () => {
    expect(() => readEvidence(scratch, [file], { base: document.inputs.baseSha, head: "1".repeat(40), worktree: true })).not.toThrow();
  });
});

describe("complexity diff, as the complexity plugin prints it", () => {
  const file = golden("complexity", "test", "golden", "ratchet-worsened", "diff.json");
  const document = read(file);

  test("units over a guideline that got worse are counted, from its own labels and cognitive delta", () => {
    const evidence = readEvidence(scratch, [file], { base: document.inputs.base.sha, head: document.inputs.head.sha, worktree: false });
    expect(evidence.complexity!.units).toEqual([
      { id: "src/pricing.ts#price", path: "src/pricing.ts", change: "changed", cognitive: document.results[0]!.after.cognitive, delta: 1, labels: ["cyclomatic-warn", "cognitive-warn"] },
    ]);
  });

  test("a diff made from another base is refused", () => {
    expect(() => readEvidence(scratch, [file], { base: "0".repeat(40), head: document.inputs.head.sha, worktree: false })).toThrow(/starts at/);
  });
});

describe("locality analyse, as the locality plugin stores it", () => {
  test("the report gives the fan-in of every file it lists", () => {
    const source = read(golden("locality", "test", "golden", "distant-helpers", "analyse.json"));
    const file = reportPath(scratch, "analyse", "locality");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, readFileSync(golden("locality", "test", "golden", "distant-helpers", "analyse.json"), "utf8"));
    const fanIn = readLocalityFanIn(scratch, source.repo.head)!;
    expect(fanIn.input).toEqual({ report: "locality.analyse", head: source.repo.head, config: source.config });
    expect(fanIn.byFile.get("src/shared/format.ts")).toBe(8);
    expect(fanIn.population).toHaveLength(source.results.length);
  });
});
