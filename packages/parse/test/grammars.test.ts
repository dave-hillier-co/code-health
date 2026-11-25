import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grammarSamples } from "@code-health/fixtures/language-samples";
import { copyGrammars, shippedGrammarFiles } from "../src/copy-grammars.ts";
import { GRAMMAR_PART_BYTES, grammarIdForPath, grammarPartName, loadGrammar, locateGrammarFile, readGrammarFile, shippedGrammarSpecs } from "../src/grammars.ts";

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
    ["a.cs", "csharp"],
    ["a.cpp", "cpp"],
    ["a.h", "cpp"],
    ["a.go", "go"],
    ["A.java", "java"],
    ["A.kt", "kotlin"],
    ["a.py", "python"],
    ["a.rs", "rust"],
  ])("maps %s to %s", (path, id) => {
    expect(grammarIdForPath(path)).toBe(id);
  });

  it("returns undefined for files without a grammar", () => {
    expect(grammarIdForPath("a.rb")).toBeUndefined();
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
    // The grammar of every supported adapter and the runtime, whichever languages are supported.
    expect(copied).toEqual(shippedGrammarFiles());
    expect(copied).toEqual(expect.arrayContaining(["tree-sitter-typescript.wasm", "tree-sitter-java.wasm", "tree-sitter-kotlin.wasm", "web-tree-sitter.wasm"]));
    expect(readdirSync(join(dist, "grammars")).sort()).toEqual(copied);
    const grammar = await loadGrammar("typescript", { grammarDir: join(dist, "grammars") });
    const tree = grammar.parse("class A {}");
    expect(tree.rootNode.child(0)?.type).toBe("class_declaration");
    tree.delete();
    expect(grammar.version).toBe((await loadGrammar("typescript")).version);
  });

  it("loads and parses with every grammar a supported adapter ships, from the copied directory, whatever the language", async () => {
    const dist = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(dist);
    copyGrammars(join(dist, "grammars"));
    const specs = shippedGrammarSpecs();
    expect(specs.map((spec) => spec.id).sort()).toEqual(Object.keys(grammarSamples).sort());
    for (const spec of specs) {
      const grammar = await loadGrammar(spec.id, { grammarDir: join(dist, "grammars") });
      const tree = grammar.parse(grammarSamples[spec.id]!);
      expect(tree.rootNode.hasError, `${spec.id} parses its sample`).toBe(false);
      expect(tree.rootNode.childCount, `${spec.id} reads something`).toBeGreaterThan(0);
      tree.delete();
    }
  });

  it("ships a grammar larger than a part as parts, none over the size, and loads it as the same grammar", async () => {
    const dist = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(dist);
    const grammars = join(dist, "grammars");
    const copied = copyGrammars(grammars);
    for (const name of copied) expect(statSync(join(grammars, name)).size, name).toBeLessThanOrEqual(GRAMMAR_PART_BYTES);

    const large = shippedGrammarSpecs().filter((spec) => statSync(locateGrammarFile(spec)).size > GRAMMAR_PART_BYTES);
    expect(large.map((spec) => spec.id)).toContain("csharp");
    for (const spec of large) {
      expect(copied).not.toContain(spec.file);
      expect(copied).toEqual(expect.arrayContaining([grammarPartName(spec.file, 0), grammarPartName(spec.file, 1)]));
      expect(readGrammarFile(join(grammars, spec.file)).equals(readFileSync(locateGrammarFile(spec)))).toBe(true);
      // The version is a hash of the joined bytes, so facts cached from the whole file are still read.
      expect((await loadGrammar(spec.id, { grammarDir: grammars })).version).toBe((await loadGrammar(spec.id)).version);
    }
  });

  it("copying again removes a file that is no longer shipped, such as the whole file of a grammar now in parts", () => {
    const dist = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(dist);
    const grammars = join(dist, "grammars");
    copyGrammars(grammars);
    writeFileSync(join(grammars, "tree-sitter-c_sharp.wasm"), "stale");
    expect(copyGrammars(grammars)).toEqual(readdirSync(grammars).sort());
  });

  it("fails clearly when a grammar file is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "code-health-grammars-"));
    scratch.push(empty);
    await expect(loadGrammar("typescript", { grammarDir: empty })).rejects.toThrow(/tree-sitter-typescript\.wasm/);
  });
});
