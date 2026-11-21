import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureCases, readExpected } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "@code-health/parse/languages";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { buildCensus, type CensusSettings } from "../src/census/census.ts";
import { censusLanguages } from "../src/census/language.ts";
import { packagingLanguages } from "../src/packaging/language.ts";
import { projectFromTree } from "../src/project.ts";

/**
 * Structure's side of the conformance harness (suite.md, Testing): the census runs over the fixtures in
 * `fixtures/languages/<id>/census`, with values counted by hand, and each language has its census detectors
 * and packaging language. The packaging fixtures run through the real CLI in language-packaging.test.ts.
 */
const ids = registeredAdapters.map((adapter) => adapter.id);

describe("every registered adapter", () => {
  it("has census detectors and a packaging language of its own, one file each", () => {
    expect(censusLanguages.map((language) => language.id)).toEqual(ids);
    expect(packagingLanguages.map((language) => language.id)).toEqual(ids);
  });
});

const settings: CensusSettings = { folderNames: ["ports", "adapters"], eventCalls: [], handlerCalls: [], registerCalls: [] };

interface CensusExpected {
  files: number;
  occurrences: string[];
}

describe.each(ids)("%s: the census fixtures", (id) => {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));

  describe.each(fixtureCases(id, "census"))("$name", (fixture) => {
    it("finds the hand-counted mechanisms, in a fixed order", async () => {
      const expected = readExpected<CensusExpected>(fixture);
      const tree = await treeFromDirectory(fixture.directory);
      const project = await projectFromTree(tree, "fixture", []);
      const census = await buildCensus(tree, project, settings);
      expect({
        files: census.files,
        occurrences: census.occurrences.map((o) => `${o.mechanism} ${o.variant} ${o.path}${o.line === null ? "" : `:${o.line}`} | ${o.detail}`),
      }).toEqual(expected);
    });
  });
});
