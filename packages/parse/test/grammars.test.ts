import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyGrammars } from "../src/copy-grammars.ts";
import { grammarIdForPath, loadGrammar, runtimeSpec, shippedGrammarSpecs } from "../src/grammars.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("grammarIdForPath", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
  ])("maps %s to %s", (path, id) => {
    expect(grammarIdForPath(path)).toBe(id);
  });

  it("returns undefined for files without a grammar", () => {
    expect(grammarIdForPath("a.py")).toBeUndefined();
    expect(grammarIdForPath("Makefile")).toBeUndefined();
    expect(grammarIdForPath("a.d.ts.map")).toBeUndefined();
  });
});

describe("loadGrammar", () => {
  it("parses source with the TypeScript grammar", async () => {
    const grammar = await loadGrammar("typescript");
    const tree = grammar.parse("export const f = (a: number): number => a;");
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
  });

  it("uses the TSX grammar for JSX syntax", async () => {
    const grammar = await loadGrammar("tsx");
    const tree = grammar.parse("const a = <div>{x}</div>;");
    expect(tree.rootNode.hasError).toBe(false);
    tree.delete();
  });

  it("reports a grammar version derived from the grammar file contents", async () => {
    const a = await loadGrammar("typescript");
    const b = await loadGrammar("javascript");
    expect(a.version).toMatch(/^typescript-[0-9a-f]{12}\+runtime-[0-9a-f]{12}$/);
    expect(a.version).not.toBe(b.version);
    expect((await loadGrammar("typescript")).version).toBe(a.version);
  });

  it("loads grammars from a dist-style directory laid out by copyGrammars", async () => {
    const dist = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(dist);
    const copied = copyGrammars(join(dist, "grammars"));
    // The grammar of every supported adapter and the runtime, sorted by file name.
    expect(copied).toEqual([...shippedGrammarSpecs().map((spec) => spec.file), runtimeSpec.file].sort());
    expect(copied).toContain("tree-sitter-typescript.wasm");
    const grammar = await loadGrammar("typescript", { grammarDir: join(dist, "grammars") });
    const tree = grammar.parse("class A {}");
    expect(tree.rootNode.child(0)?.type).toBe("class_declaration");
    tree.delete();
    expect(grammar.version).toBe((await loadGrammar("typescript")).version);
  });

  it("fails clearly when a grammar file is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(empty);
    await expect(loadGrammar("typescript", { grammarDir: empty })).rejects.toThrow(/tree-sitter-typescript\.wasm/);
  });
});
