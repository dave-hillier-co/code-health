import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * Metric conformance (suite.md, Testing). Each directory under fixtures/ts-metrics is a small project
 * with an expected.json whose values were counted by hand from the source, following the definitions
 * in unit-metrics.ts. A file lists every function unit it has, so an unlisted unit is a failure too.
 */
const root = fileURLToPath(new URL("../../../fixtures/ts-metrics/", import.meta.url));

interface Expected {
  columns: string[];
  files: Record<string, [string, ...number[]][]>;
}

const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("metric fixtures are well formed", () => {
  it.each(cases)("%s has an expected.json with known keys", (name) => {
    expect(existsSync(`${root}${name}/expected.json`), `${name} has no expected.json`).toBe(true);
    const expected = JSON.parse(readFileSync(`${root}${name}/expected.json`, "utf8")) as Record<string, unknown>;
    expect(Object.keys(expected).sort()).toEqual(["columns", "files"]);
  });
});

describe.each(cases)("ts-metrics fixture %s", (name) => {
  const expected = JSON.parse(readFileSync(`${root}${name}/expected.json`, "utf8")) as Expected;

  it("matches the hand-counted metrics of every function unit", async () => {
    const analysis = await analyseTree(await treeFromDirectory(`${root}${name}`));
    const actual: Record<string, [string, ...number[]][]> = {};
    for (const unit of analysis.units) {
      if (unit.metrics === undefined) continue;
      const m = unit.metrics;
      (actual[unit.path] ??= []).push([
        unit.qualifiedName,
        m.cyclomatic,
        m.cyclomaticModified,
        m.cognitive,
        m.nesting,
        m.length,
        m.statements,
        m.parameters,
        m.optionCount,
      ]);
    }
    expect(expected.columns.slice(1)).toEqual([
      "cyclomatic",
      "cyclomaticModified",
      "cognitive",
      "nesting",
      "length",
      "statements",
      "parameters",
      "optionCount",
    ]);
    expect(actual).toEqual(expected.files);
  });
});

describe("classes carry no metrics", () => {
  it("leaves them on function units only", async () => {
    const analysis = await analyseTree(await treeFromDirectory(`${root}nesting-and-units`));
    const service = analysis.units.find((unit) => unit.qualifiedName === "Service");
    expect(service?.kind).toBe("class");
    expect(service?.metrics).toBeUndefined();
  });
});
