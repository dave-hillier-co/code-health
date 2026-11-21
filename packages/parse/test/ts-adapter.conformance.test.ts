import { readFileSync, readdirSync } from "node:fs";
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
        `${consumer.from}${consumer.fromUnit ? `#${consumer.fromUnit}` : ""} -> ${consumer.to}${consumer.toSymbol ? `#${consumer.toSymbol}` : ""} ${consumer.kind} x${consumer.count}`,
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

describe.each(cases)("ts-adapter fixture %s", (name) => {
  const expected = JSON.parse(readFileSync(`${root}${name}/expected.json`, "utf8")) as Expected;
  const sections = Object.keys(expected) as (keyof Expected)[];

  it.each(sections)("%s", async (section) => {
    const tree = await treeFromDirectory(`${root}${name}`);
    const actual = render(await analyseTree(tree));
    expect(actual[section]).toEqual(expected[section]);
  });
});
