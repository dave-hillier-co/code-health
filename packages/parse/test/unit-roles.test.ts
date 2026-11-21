import { describe, expect, it } from "vitest";
import { parseWith } from "../src/file-facts.ts";
import { GrammarSet } from "../src/grammars.ts";

/**
 * Units that are not free-standing helpers: a function that calls itself, and a method that overrides or
 * implements a method its type inherits. Locality reads these facts to keep such units out of inline and move.
 */
const grammars = new GrammarSet();

async function roles(path: string, source: string): Promise<Record<string, string[]>> {
  const language = (await grammars.forPath(path))!;
  const facts = parseWith(language.adapter, language.grammar, source);
  const result: Record<string, string[]> = {};
  for (const unit of facts.units) {
    const found = [unit.recursive === true ? "recursive" : "", unit.override === true ? "override" : ""].filter((role) => role !== "");
    if (found.length > 0) result[unit.qualifiedName] = found;
  }
  return result;
}

describe("recursion", () => {
  const cases: [string, string, string][] = [
    ["typescript", "a.ts", "export function walk(n: number): number { return n === 0 ? 0 : walk(n - 1); }\nexport function flat(n: number) { return n; }\n"],
    ["python", "a.py", "def walk(n):\n    return 0 if n == 0 else walk(n - 1)\n\ndef flat(n):\n    return n\n"],
    ["go", "a.go", "package a\n\nfunc Walk(n int) int {\n\tif n == 0 {\n\t\treturn 0\n\t}\n\treturn Walk(n - 1)\n}\n\nfunc Flat(n int) int { return n }\n"],
    ["rust", "a.rs", "pub fn walk(n: u32) -> u32 { if n == 0 { 0 } else { walk(n - 1) } }\npub fn flat(n: u32) -> u32 { n }\n"],
    ["java", "A.java", "class A {\n  int walk(int n) { return n == 0 ? 0 : walk(n - 1); }\n  int flat(int n) { return n; }\n}\n"],
    ["kotlin", "A.kt", "class A {\n  fun walk(n: Int): Int = if (n == 0) 0 else walk(n - 1)\n  fun flat(n: Int): Int = n\n}\n"],
    ["csharp", "A.cs", "class A {\n  int Walk(int n) { return n == 0 ? 0 : Walk(n - 1); }\n  int Flat(int n) { return n; }\n}\n"],
    ["cpp", "a.cpp", "int walk(int n) { return n == 0 ? 0 : walk(n - 1); }\nint flat(int n) { return n; }\n"],
  ];
  it.each(cases)("%s marks only the function that calls itself", async (_language, path, source) => {
    const found = await roles(path, source);
    expect(Object.values(found)).toEqual([["recursive"]]);
    expect(Object.keys(found)[0]!.toLowerCase()).toMatch(/walk$/);
  });
});

describe("overrides", () => {
  const cases: [string, string, string, string[]][] = [
    ["typescript", "a.ts", "class B extends A {\n  override run(): number { return 1; }\n  plain(): number { return 2; }\n}\n", ["B.run"]],
    ["java", "B.java", "class B extends A {\n  @Override public int run() { return 1; }\n  public int plain() { return 2; }\n}\n", ["B.run"]],
    ["kotlin", "B.kt", "class B : A() {\n  override fun run(): Int { return 1 }\n  fun plain(): Int { return 2 }\n}\n", ["B.run"]],
    ["csharp", "B.cs", "class B : A {\n  public override int Run() { return 1; }\n  public int Plain() { return 2; }\n}\n", ["B.Run"]],
    ["cpp", "b.cpp", "class B : public A {\n  int run() override { return 1; }\n  int plain() { return 2; }\n};\n", ["B.run"]],
    ["rust", "b.rs", "pub struct B;\nimpl Runner for B {\n    fn run(&self) -> u32 { 1 }\n}\nimpl B {\n    pub fn plain(&self) -> u32 { 2 }\n}\n", ["B.run"]],
    ["python", "b.py", "from typing import override\nclass B(A):\n    @override\n    def run(self):\n        return 1\n    def plain(self):\n        return 2\n", ["B.run"]],
  ];
  it.each(cases)("%s marks only the method that overrides or implements", async (_language, path, source, expected) => {
    expect(Object.keys(await roles(path, source))).toEqual(expected);
  });
});
