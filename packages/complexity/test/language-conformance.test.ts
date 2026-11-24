import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@code-health/cli-kit/config";
import { fixtureCases, readExpected } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "@code-health/parse/languages";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { complexityConfig, readSettings } from "../src/config.ts";
import { complexityLanguages, explainRule } from "../src/language.ts";
import { measureTree } from "../src/measure.ts";

/**
 * Complexity's side of the conformance harness (CONTRIBUTING.md, Conformance). The fixtures in
 * `fixtures/languages/<id>/metrics`, `metrics-wide` and `depth` carry values counted by hand, and the
 * plugin's own measurement runs over them: cyclomatic in both switch modes, cognitive, nesting, length,
 * parameters, and the interface shape behind the depth signal.
 */
const ids = registeredAdapters.map((adapter) => adapter.id);

describe("every registered adapter", () => {
  it("has a complexity language of its own, one file", () => {
    expect(complexityLanguages.map((language) => language.id)).toEqual(ids);
  });

  it("explains a rule with each language's own notes, and without any when a language has none", () => {
    expect(explainRule("cognitive", "shared")).toBe(
      ["shared", ...complexityLanguages.filter((language) => (language.ruleNotes.cognitive ?? []).length > 0).map((language) => `${adapterById(language.id)!.name}: ${language.ruleNotes.cognitive!.join(" ")}`)].join("\n"),
    );
  });
});

type Row = [string, ...number[]];

describe.each(ids)("%s: the complexity fixtures", (id) => {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));

  const metrics = [...fixtureCases(id, "metrics"), ...fixtureCases(id, "metrics-wide")];

  describe.each(metrics.map((fixture) => [fixture.directory.split("/").slice(-3, -1).join("/"), fixture] as const))("%s", (_label, fixture) => {
    it.each(["case", "modified"] as const)("measures the hand-counted values of every function, with cyclomatic counted per %s", async (mode) => {
      const expected = readExpected<{ columns: string[]; files: Record<string, Row[]> }>(fixture);
      expect(expected.columns, "the columns the harness reads").toEqual(["unit", "cyclomatic", "cyclomaticModified", "cognitive", "nesting", "length", "statements", "parameters", "optionCount"]);
      const base = readSettings(loadConfig(fixture.directory, complexityConfig));
      const measurement = await measureTree(await treeFromDirectory(fixture.directory), { settings: { ...base, cyclomaticSwitch: mode }, layer: "structural" });
      const column = (name: string) => expected.columns.indexOf(name);
      const cyclomatic = mode === "case" ? column("cyclomatic") : column("cyclomaticModified");
      const actual: Record<string, Row[]> = {};
      const wanted: Record<string, Row[]> = {};
      for (const file of measurement.files) {
        if (file.units.length === 0) continue;
        actual[file.path] = file.units.map((unit) => [
          unit.name!,
          unit.values.cyclomatic!,
          unit.values.cognitive!,
          unit.values.nesting!,
          unit.values.length!,
          unit.statements!,
          unit.values.parameters!,
          unit.optionCount!,
        ]);
      }
      for (const [path, rows] of Object.entries(expected.files)) {
        const at = (row: Row, index: number): number => row[index] as number;
        wanted[path] = rows.map((row) => [row[0], at(row, cyclomatic), at(row, column("cognitive")), at(row, column("nesting")), at(row, column("length")), at(row, column("statements")), at(row, column("parameters")), at(row, column("optionCount"))]);
      }
      expect(actual).toEqual(wanted);
    });
  });

  const [depth] = fixtureCases(id, "depth");
  it.runIf(depth !== undefined)("measures the hand-counted interface shape of every unit and module", async () => {
    interface Expected {
      files: Record<string, [string, number, number, string | null][]>;
      modules: Record<string, number>;
    }
    const expected = readExpected<Expected>(depth!);
    const files = readdirSync(depth!.directory).filter((name) => name !== "expected.json").sort();
    const base = readSettings(loadConfig(depth!.directory, complexityConfig));
    const measurement = await measureTree(await treeFromDirectory(depth!.directory), { settings: base, layer: "structural" });
    for (const file of files) {
      const record = measurement.files.find((candidate) => candidate.path === file)!;
      expect(record.interfaces!.units.map((unit) => [unit.name, unit.nodes, unit.interfaceSize, unit.passThrough ?? null]), file).toEqual(expected.files[file]);
      expect(record.interfaces!.module.nodes, file).toBe(expected.modules[file]);
    }
  });
});
