import { describe, expect, test } from "vitest";
import { MAX_TREE_DEPTH, nestsDeeperThan, parseWith } from "../src/file-facts.ts";
import { GrammarSet } from "../src/grammars.ts";

/** A string built from `terms` literals joined by `+`: a binary expression that nests as deep as it is long. */
const chain = (terms: number) => Array.from({ length: terms }, (_, i) => `"part${i}"`).join(" + ");

const sources: [string, (terms: number) => string][] = [
  ["Table.java", (terms) => `class Table {\n  int size() { return 1; }\n  static final String TEXT = ${chain(terms)};\n}\n`],
  ["table.ts", (terms) => `export function size(): number { return 1; }\nexport const TEXT = ${chain(terms)};\n`],
  ["table.py", (terms) => `def size():\n    return 1\n\nTEXT = ${chain(terms)}\n`],
  ["table.rs", (terms) => `pub fn size() -> usize { 1 }\npub fn total() -> usize { ${Array.from({ length: terms }, (_, i) => String(i)).join(" + ")} }\n`],
];

describe("a syntax tree that nests thousands of levels deep", () => {
  const grammars = new GrammarSet();

  test.each(sources)("%s is read as empty and marked, where recursion would exhaust the call stack", async (path, source) => {
    const language = (await grammars.forPath(path))!;
    const facts = parseWith(language.adapter, language.grammar, source(20_000));
    expect(facts.tooDeep).toBe(true);
    expect(facts.units).toEqual([]);
    expect(facts.imports).toEqual([]);
  });

  test.each(sources)("%s is read in full at a depth near the limit", async (path, source) => {
    const language = (await grammars.forPath(path))!;
    const facts = parseWith(language.adapter, language.grammar, source(MAX_TREE_DEPTH - 100));
    expect(facts.tooDeep).toBeUndefined();
    expect(facts.units.map((unit) => unit.qualifiedName)).toContain(path.endsWith(".java") ? "Table.size" : "size");
  });

  test("the depth is measured without recursion", async () => {
    const { grammar } = (await grammars.forPath("table.ts"))!;
    const tree = grammar.parse(`export const TEXT = ${chain(50_000)};\n`);
    try {
      expect(nestsDeeperThan(tree.rootNode, MAX_TREE_DEPTH)).toBe(true);
      expect(nestsDeeperThan(tree.rootNode, 100_000)).toBe(false);
    } finally {
      tree.delete();
    }
  });
});
