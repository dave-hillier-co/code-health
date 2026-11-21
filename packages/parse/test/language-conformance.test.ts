import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureAreas, fixtureCases, fixtureGaps, languageFolders, readExpected } from "@code-health/fixtures/language-conformance";
import { analyseTree, type ProjectAnalysis } from "../src/analyse-tree.ts";
import { parseWith } from "../src/file-facts.ts";
import { GrammarSet } from "../src/grammars.ts";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "../src/languages.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

/**
 * The structural layer's side of the conformance harness (suite.md, Testing). Every registered adapter,
 * supported or not, runs the fixtures in `fixtures/languages/<id>/`: the dependency model (`adapter`), the
 * hand-counted metrics of every function (`metrics`, `metrics-wide`) and the interface shapes (`depth`).
 * Complexity, structure and locality run the areas they own through their own commands.
 */

interface AdapterExpected {
  units?: Record<string, [string, string, number, number][]>;
  importEdges?: string[];
  fileEdges?: string[];
  consumers?: string[];
  unresolved?: string[];
  barrels?: string[];
  syntaxErrors?: string[];
}

function render(analysis: ProjectAnalysis): Required<AdapterExpected> {
  const units: Record<string, [string, string, number, number][]> = {};
  for (const unit of analysis.units) (units[unit.path] ??= []).push([unit.qualifiedName, unit.kind, unit.startLine, unit.endLine]);
  return {
    units,
    importEdges: analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind}${edge.typeOnly ? " type" : ""}`),
    fileEdges: analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind} call=${edge.calls} reference=${edge.references}`),
    consumers: analysis.consumers.map(
      (consumer) =>
        `${consumer.from}${consumer.fromUnit ? `#${consumer.fromUnit}` : ""} -> ${consumer.to}${consumer.toSymbol ? `#${consumer.toSymbol}` : `:${consumer.toExport}`} ${consumer.kind} x${consumer.count}`,
    ),
    unresolved: analysis.unresolved.map((item) => `${item.from}:${item.line} ${item.specifier ?? "<expression>"} ${item.reason}`),
    barrels: analysis.barrels,
    syntaxErrors: analysis.filesWithSyntaxErrors,
  };
}

const knownSections = ["units", "importEdges", "fileEdges", "consumers", "unresolved", "barrels", "syntaxErrors"];

/** Registered adapters analyse as if supported while their own suite runs. */
function useAdapter(id: string): void {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));
}

describe("the fixture folders", () => {
  it("each belong to a registered adapter", () => {
    expect(languageFolders()).toEqual(registeredAdapters.map((adapter) => adapter.id));
  });

  it.each(registeredAdapters.filter((adapter) => adapter.support === "supported").map((adapter) => adapter.id))("%s, supported, has every required fixture area", (id) => {
    expect(fixtureGaps(id)).toEqual([]);
  });
});

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: the adapter fixtures", (id) => {
  useAdapter(id);
  const cases = fixtureCases(id, "adapter");

  it.each(cases.map((fixture) => fixture.name))("%s names only known sections and pins something", (name) => {
    const expected = readExpected<Record<string, unknown>>(cases.find((fixture) => fixture.name === name)!);
    for (const section of Object.keys(expected)) {
      expect(knownSections, `${name}/expected.json has an unknown section "${section}", which would be silently skipped`).toContain(section);
    }
    expect(Object.keys(expected).length, `${name} pins nothing`).toBeGreaterThan(0);
  });

  describe.each(cases)("$name", (fixture) => {
    // A malformed expected.json fails this one case: reading it where the suite is collected would abort the whole file.
    const expected = ((): AdapterExpected | Error => {
      try {
        return readExpected<AdapterExpected>(fixture);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();
    if (expected instanceof Error) {
      it("has an expected.json that parses", () => {
        throw expected;
      });
      return;
    }
    it.each(Object.keys(expected) as (keyof AdapterExpected)[])("%s", async (section) => {
      const actual = render(await analyseTree(await treeFromDirectory(fixture.directory)));
      expect(actual[section]).toEqual(expected[section]);
    });
  });

  it("gives identical output whatever order the tree lists its files in", async () => {
    for (const fixture of cases) {
      const tree = await treeFromDirectory(fixture.directory);
      const shuffled = { ...tree, files: new Map([...tree.files].reverse()) };
      expect(JSON.stringify(await analyseTree(shuffled)), fixture.name).toBe(JSON.stringify(await analyseTree(tree)));
    }
  });

  it("gives every unit an id of its own: path, then qualified name", async () => {
    for (const fixture of cases) {
      const analysis = await analyseTree(await treeFromDirectory(fixture.directory));
      expect(new Set(analysis.units.map((unit) => unit.id)).size, `${fixture.name} has two units with one id`).toBe(analysis.units.length);
      for (const unit of analysis.units) expect(unit.id).toBe(`${unit.path}#${unit.qualifiedName}`);
    }
  });
});

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: the metric fixtures", (id) => {
  useAdapter(id);
  const columns = ["cyclomatic", "cyclomaticModified", "cognitive", "nesting", "length", "statements", "parameters", "optionCount"];
  const cases = [...fixtureCases(id, "metrics"), ...fixtureCases(id, "metrics-wide")];

  it.each(cases.map((fixture) => fixture.directory))("%s has an expected.json with known keys", (directory) => {
    const fixture = cases.find((candidate) => candidate.directory === directory)!;
    expect(Object.keys(readExpected<Record<string, unknown>>(fixture)).sort()).toEqual(["columns", "files"]);
  });

  // A file lists every function unit it has, so an unlisted unit is a failure too.
  it.each(cases.map((fixture) => [`${fixture.directory.split("/").slice(-3, -1).join("/")}`, fixture] as const))("%s matches the hand-counted metrics of every function unit", async (_label, fixture) => {
    const expected = readExpected<{ columns: string[]; files: Record<string, [string, ...number[]][]> }>(fixture);
    expect(expected.columns.slice(1)).toEqual(columns);
    const analysis = await analyseTree(await treeFromDirectory(fixture.directory));
    const actual: Record<string, [string, ...number[]][]> = {};
    for (const unit of analysis.units) {
      if (unit.metrics === undefined) continue;
      const m = unit.metrics;
      (actual[unit.path] ??= []).push([unit.qualifiedName, m.cyclomatic, m.cyclomaticModified, m.cognitive, m.nesting, m.length, m.statements, m.parameters, m.optionCount]);
    }
    expect(actual).toEqual(expected.files);
  });

  it("gives classes no metrics, on function units only", async () => {
    for (const fixture of cases) {
      const analysis = await analyseTree(await treeFromDirectory(fixture.directory));
      for (const unit of analysis.units.filter((candidate) => candidate.kind === "class")) expect(unit.metrics, unit.id).toBeUndefined();
    }
  });
});

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: the interface shape fixtures", (id) => {
  useAdapter(id);
  const [fixture] = fixtureCases(id, "depth");

  // Each file is a small project whose node counts, interface sizes and forwarded calls were counted by hand from the syntax tree.
  it.runIf(fixture !== undefined)("match the hand-counted shape of every unit and of the module", async () => {
    interface Expected {
      files: Record<string, [string, number, number, string | null][]>;
      /** Named nodes of the whole file, not counting import statements. */
      modules: Record<string, number>;
    }
    const expected = readExpected<Expected>(fixture!);
    const files = readdirSync(fixture!.directory).filter((name) => name !== "expected.json").sort();
    expect(Object.keys(expected.files)).toEqual(files);
    expect(Object.keys(expected.modules)).toEqual(files);
    const grammars = new GrammarSet();
    for (const file of files) {
      const language = (await grammars.forPath(file))!;
      const facts = parseWith(language.adapter, language.grammar, readFileSync(`${fixture!.directory}${file}`, "utf8"));
      expect(facts.units.map((unit) => [unit.qualifiedName, unit.shape?.nodes, unit.shape?.interfaceSize, unit.passThrough ?? null]), file).toEqual(expected.files[file]);
      expect(facts.nodes, file).toBe(expected.modules[file]);
    }
  });
});

describe.each(registeredAdapters.map((adapter) => adapter.id))("%s: the fixtures of the areas other plugins run", (id) => {
  const pins: [string, (expected: Record<string, unknown>) => unknown][] = [
    ["census", (expected) => expected.occurrences],
    ["packaging", (expected) => expected.packages],
    ["moves", (expected) => expected.operations],
  ];

  it.each(pins)("every %s case that is not the quiet one pins something, so an emptied fixture cannot pass vacuously", (area, pinned) => {
    for (const fixture of fixtureCases(id, area as "census" | "packaging" | "moves")) {
      if (area === "census" && fixture.name === "quiet") continue;
      const value = pinned(readExpected<Record<string, unknown>>(fixture));
      const size = Array.isArray(value) ? value.length : typeof value === "object" && value !== null ? Object.keys(value).length : 0;
      expect(size, `${id}/${area}/${fixture.name} pins nothing`).toBeGreaterThan(0);
    }
  });
});

describe("the fixture areas", () => {
  it("name the plugin that checks each, so no area is run by nobody", () => {
    for (const [name, area] of Object.entries(fixtureAreas)) expect(["parse", "complexity", "structure", "locality", "lexical"], name).toContain(area.checkedBy);
  });
});
