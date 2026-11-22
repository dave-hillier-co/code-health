import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/** The constructs the C++ grammar rejects and the adapter repairs before reading a file, in the shapes a test suite and a header use. */
const cpp = adapterById("cpp")!;

beforeAll(() => overrideSupportedAdapters([cpp]));
afterAll(() => overrideSupportedAdapters(undefined));

const analyse = (source: string, path = "a.cpp") => analyseTree(treeFromTexts({ [path]: source }));
const names = async (source: string, path?: string) => (await analyse(source, path)).units.map((unit) => unit.qualifiedName);

describe("test-framework macros that take a block", () => {
  const doctest = [
    '#include "doctest.h"',
    "namespace solent {",
    'TEST_SUITE("terrain") {',
    'TEST_CASE("ridge: height") {',
    "  int total = 0;",
    "  for (int i = 0; i < 3; ++i) { if (i > 1) total += i; }",
    '  SUBCASE("flat") { if (total > 0) total = 0; }',
    "  CHECK(total == 0);",
    "}",
    "}",
    "}",
    "",
  ].join("\n");

  it("parse without syntax errors", async () => {
    expect((await analyse(doctest)).filesWithSyntaxErrors).toEqual([]);
  });

  it("make a unit of each test case, named after its invocation, inside a namespace for the suite", async () => {
    const unitNames = await names(doctest);
    expect(unitNames).toHaveLength(1);
    expect(unitNames[0]).toBe("solent::__terrain__::CASE__ridge__height");
  });

  it("count a sub case's decisions in the test case that holds it, and keep every line where it was", async () => {
    const { units } = await analyse(doctest);
    expect(units[0]!.startLine).toBe(4);
    expect(units[0]!.endLine).toBe(9);
    expect(units[0]!.metrics?.cyclomatic).toBe(1 + 1 + 1 + 1);
  });

  it("read a multi-line invocation as one function and keep the lines", async () => {
    const { units, filesWithSyntaxErrors } = await analyse('TEST_CASE("name",\n  "[tag]") {\n  int x = 1;\n}\nint after() { return 1; }\n');
    expect(filesWithSyntaxErrors).toEqual([]);
    expect(units.map((unit) => [unit.startLine, unit.endLine])).toEqual([
      [1, 4],
      [5, 5],
    ]);
  });
});

describe("default arguments with braces and no type", () => {
  it("parse in a declaration and a definition", async () => {
    const source = ["struct Options {};", "void run(const Options& options = {}, int n = {});", "struct K { explicit K(const Options& o = {}) {} [[nodiscard]] int get(Options o = {}) const; };", ""].join("\n");
    const analysis = await analyse(source, "k.h");
    expect(analysis.filesWithSyntaxErrors).toEqual([]);
  });
});

describe("pointers to members", () => {
  it("parse in a use through an object or a pointer, and in a class body", async () => {
    const source = [
      "struct S { int a; };",
      "struct Entry { int S::* member; const char* key; };",
      "int read(S& s, S* p, Entry e) { return s.*(e.member) + p->*(e.member); }",
      "",
    ].join("\n");
    const analysis = await analyse(source);
    expect(analysis.filesWithSyntaxErrors).toEqual([]);
    expect(analysis.units.map((unit) => unit.qualifiedName)).toContain("read");
  });
});

describe("a file with an error the repairs do not cover", () => {
  it("is still reported", async () => {
    const analysis = await analyse("enum : unsigned { A };\nint f() { return 1; }\n");
    expect(analysis.filesWithSyntaxErrors).toEqual(["a.cpp"]);
  });
});
