import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureCases, readExpected } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters, registeredAdapters } from "@code-health/parse/languages";
import { treeFromDirectory } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";
import { moverLanguages } from "../src/movers/language.ts";
import type { FileOperation } from "../src/move-plan.ts";

/**
 * Locality's side of the conformance harness (suite.md, Testing). Each folder under
 * `fixtures/languages/<id>/moves` holds a `before/` tree, the operations to make and what a correct move
 * leaves: the specifiers rewritten and the text of every file that changes, worked out by hand. The mover of
 * each language runs over them. External tools that confirm references are optional: without one the result
 * says `not confirmed` and the move is still checked.
 */
const ids = registeredAdapters.map((adapter) => adapter.id);

describe("every registered adapter", () => {
  it("has a mover language of its own, one file", () => {
    expect(moverLanguages.map((language) => language.id)).toEqual(ids);
  });
});

interface MovesExpected {
  operations: { from: string; to: string }[];
  rewrites: { path: string; line: number; from: string; to: string }[];
  texts: Record<string, string>;
  warnings: string[];
}

describe.each(ids)("%s: the move fixtures", (id) => {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));

  describe.each(fixtureCases(id, "moves"))("$name", (fixture) => {
    it("leaves the rewrites and file texts worked out by hand, and a warning for nothing it did not expect", async () => {
      const expected = readExpected<MovesExpected>(fixture);
      const operations: FileOperation[] = expected.operations.map((operation) => ({ ...operation, role: "unit" }));
      const result = await performMove(await treeFromDirectory(`${fixture.directory}before/`), operations);
      expect({
        rewrites: result.rewrites,
        texts: Object.fromEntries([...result.texts].sort(([a], [b]) => (a < b ? -1 : 1))),
        warnings: result.warnings,
      }).toEqual({ rewrites: expected.rewrites, texts: expected.texts, warnings: expected.warnings });
    });

    it("declares what confirms references, or says nothing could", async () => {
      const result = await performMove(await treeFromDirectory(`${fixture.directory}before/`), readExpected<MovesExpected>(fixture).operations.map((operation) => ({ ...operation, role: "unit" as const })));
      const tool = adapterById(id)!.mover.confirmation;
      expect(result.confirmations.map((entry) => entry.tool)).toEqual(tool === null ? [] : [tool.name]);
    });
  });
});
