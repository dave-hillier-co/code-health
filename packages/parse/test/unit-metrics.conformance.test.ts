import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * Metric conformance (suite.md, Testing). Each directory under fixtures/ts-metrics is a small project
 * with an expected.json whose values were counted by hand from the source, following the definitions
 * in unit-metrics.ts. A file lists every function unit it has, so an unlisted unit is a failure too.
 *
 * fixtures/ts-metrics is also the corpus of the lexical agreement test, so its cases stay as they are.
 * fixtures/ts-metrics-wide holds further cases checked the same way and is not part of that corpus: adding to it
 * widens the metric conformance without moving the recorded agreement.
 */
const root = fileURLToPath(new URL("../../../fixtures/ts-metrics/", import.meta.url));
const roots = [root, fileURLToPath(new URL("../../../fixtures/ts-metrics-wide/", import.meta.url))];

interface Expected {
  columns: string[];
  files: Record<string, [string, ...number[]][]>;
}

const cases = roots.flatMap((base) =>
  readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ label: `${base.split("/").filter(Boolean).pop()}/${entry.name}`, directory: `${base}${entry.name}` }))
    .sort((a, b) => (a.label < b.label ? -1 : 1)),
);

describe("metric fixtures are well formed", () => {
  it.each(cases.map((fixture) => fixture.label))("%s has an expected.json with known keys", (label) => {
    const { directory } = cases.find((fixture) => fixture.label === label)!;
    expect(existsSync(`${directory}/expected.json`), `${label} has no expected.json`).toBe(true);
    const expected = JSON.parse(readFileSync(`${directory}/expected.json`, "utf8")) as Record<string, unknown>;
    expect(Object.keys(expected).sort()).toEqual(["columns", "files"]);
  });
});

describe.each(cases.map((fixture) => [fixture.label, fixture.directory] as const))("metric fixture %s", (_label, directory) => {
  const expected = JSON.parse(readFileSync(`${directory}/expected.json`, "utf8")) as Expected;

  it("matches the hand-counted metrics of every function unit", async () => {
    const analysis = await analyseTree(await treeFromDirectory(directory));
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
