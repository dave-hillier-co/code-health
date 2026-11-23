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
  /** What leaves the result not compiling; absent when the fixture has none. */
  breaks?: string[];
}

describe.each(ids)("%s: the move fixtures", (id) => {
  beforeAll(() => overrideSupportedAdapters([adapterById(id)!]));
  afterAll(() => overrideSupportedAdapters(undefined));

  describe.each(fixtureCases(id, "moves"))("$name", (fixture) => {
    // An empty search path hides every installed tool, so what is checked never depends on the machine: a language
    // server that is slow, or that words its answer differently, cannot change the result. The tools have tests of their own.
    let moved: ReturnType<typeof performMove> | undefined;
    const move = () => {
      const operations: FileOperation[] = readExpected<MovesExpected>(fixture).operations.map((operation) => ({ ...operation, role: "unit" }));
      moved ??= treeFromDirectory(`${fixture.directory}before/`).then((tree) => performMove(tree, operations, { searchPath: "" }));
      return moved;
    };

    it("leaves the rewrites and file texts worked out by hand, and a warning for nothing it did not expect", async () => {
      const expected = readExpected<MovesExpected>(fixture);
      const result = await move();
      expect({
        rewrites: result.rewrites,
        texts: Object.fromEntries([...result.texts].sort(([a], [b]) => (a < b ? -1 : 1))),
        warnings: result.warnings,
        breaks: result.breaks ?? [],
      }).toEqual({ rewrites: expected.rewrites, texts: expected.texts, warnings: expected.warnings, breaks: expected.breaks ?? [] });
    });

    it("declares what confirms references, and with no tool to hand says not confirmed", async () => {
      const result = await move();
      const tool = adapterById(id)!.mover.confirmation;
      expect(result.confirmations.map((entry) => `${entry.tool}: ${entry.status}`)).toEqual(tool === null ? [] : [`${tool.name}: not confirmed`]);
    });
  });
});
