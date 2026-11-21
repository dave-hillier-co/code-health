import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyseTree, type ProjectAnalysis } from "../src/analyse-tree.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * Conformance fixtures: each directory under fixtures/ts-adapter is a small
 * project on disk with an expected.json of hand-verified values. A case lists
 * only the sections it pins down.
 */
const root = fileURLToPath(new URL("../../../fixtures/ts-adapter/", import.meta.url));

interface Expected {
  units?: Record<string, [string, string, number, number][]>;
  importEdges?: string[];
  fileEdges?: string[];
  consumers?: string[];
  unresolved?: string[];
  barrels?: string[];
}

function render(analysis: ProjectAnalysis): Required<Expected> {
  const units: Record<string, [string, string, number, number][]> = {};
  for (const unit of analysis.units) {
    (units[unit.path] ??= []).push([unit.qualifiedName, unit.kind, unit.startLine, unit.endLine]);
  }
  return {
    units,
    importEdges: analysis.importEdges.map(
      (edge) => `${edge.from} -> ${edge.to} ${edge.kind}${edge.typeOnly ? " type" : ""}`,
    ),
    fileEdges: analysis.fileEdges.map(
      (edge) => `${edge.from} -> ${edge.to} ${edge.kind} call=${edge.calls} reference=${edge.references}`,
    ),
    consumers: analysis.consumers.map(
      (consumer) =>
        `${consumer.from}${consumer.fromUnit ? `#${consumer.fromUnit}` : ""} -> ${consumer.to}${consumer.toSymbol ? `#${consumer.toSymbol}` : `:${consumer.toExport}`} ${consumer.kind} x${consumer.count}`,
    ),
    unresolved: analysis.unresolved.map(
      (item) => `${item.from}:${item.line} ${item.specifier ?? "<expression>"} ${item.reason}`,
    ),
    barrels: analysis.barrels,
  };
}

const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const knownSections = ["units", "importEdges", "fileEdges", "consumers", "unresolved", "barrels"];

describe("conformance fixtures are well formed", () => {
  it.each(cases)("%s has an expected.json that names only known sections and pins its units", (name) => {
    expect(existsSync(`${root}${name}/expected.json`), `${name} has no expected.json`).toBe(true);
    const expected = JSON.parse(readFileSync(`${root}${name}/expected.json`, "utf8")) as Record<string, unknown>;
    for (const section of Object.keys(expected)) {
      expect(knownSections, `${name}/expected.json has an unknown section "${section}", which would be silently skipped`).toContain(section);
    }
    expect(Object.keys(expected).length, `${name} pins nothing`).toBeGreaterThan(0);
  });
});

describe.each(cases)("ts-adapter fixture %s", (name) => {
  const expected = JSON.parse(readFileSync(`${root}${name}/expected.json`, "utf8")) as Expected;
  const sections = Object.keys(expected) as (keyof Expected)[];

  it.each(sections)("%s", async (section) => {
    const tree = await treeFromDirectory(`${root}${name}`);
    const actual = render(await analyseTree(tree));
    expect(actual[section]).toEqual(expected[section]);
  });
});

describe("syntax errors", () => {
  it("are reported for the file that has them, and its other units are still found", async () => {
    const analysis = await analyseTree(await treeFromDirectory(`${root}syntax-errors`));
    expect(analysis.filesWithSyntaxErrors).toEqual(["broken.ts"]);
    expect(analysis.units.map((unit) => unit.qualifiedName)).toContain("ok");
  });
});

describe("determinism", () => {
  it("gives identical output whatever order the tree lists its files in", async () => {
    for (const name of cases) {
      const tree = await treeFromDirectory(`${root}${name}`);
      const shuffled = {
        ...tree,
        files: new Map([...tree.files].reverse()),
      };
      expect(JSON.stringify(await analyseTree(shuffled)), name).toBe(JSON.stringify(await analyseTree(tree)));
    }
  });
});
