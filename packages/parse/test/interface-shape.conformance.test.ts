import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFacts } from "../src/file-facts.ts";
import { grammarIdForPath, loadGrammar } from "../src/grammars.ts";

/**
 * Interface shape conformance. Each directory under fixtures/ts-depth is a small project with an
 * expected.json whose values were counted by hand from the syntax tree: the named nodes of a unit
 * (comments left out), the size of its interface and the call it forwards to, if its whole body is
 * one forwarded call. A file lists every unit it has, so an unlisted unit is a failure too.
 */
const root = fileURLToPath(new URL("../../../fixtures/ts-depth/", import.meta.url));

interface Expected {
  columns: string[];
  files: Record<string, [string, number, number, string | null][]>;
  /** Named nodes of the whole file, not counting import statements. */
  modules: Record<string, number>;
}

const expected = JSON.parse(readFileSync(`${root}expected.json`, "utf8")) as Expected;
const files = readdirSync(root).filter((name) => name !== "expected.json").sort();

describe("interface shape fixtures", () => {
  it("list every file of the fixture", () => {
    expect(Object.keys(expected.files)).toEqual(files);
    expect(Object.keys(expected.modules)).toEqual(files);
  });

  it.each(files)("%s matches the hand-counted shape of every unit and of the module", async (file) => {
    const facts = parseFacts(await loadGrammar(grammarIdForPath(file)!), readFileSync(`${root}${file}`, "utf8"));
    const actual = facts.units.map((unit) => [unit.qualifiedName, unit.shape?.nodes, unit.shape?.interfaceSize, unit.passThrough ?? null]);
    expect(actual).toEqual(expected.files[file]);
    expect(facts.nodes).toBe(expected.modules[file]);
  });
});
