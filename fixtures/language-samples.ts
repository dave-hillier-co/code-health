import type { Change } from "./git-fixture.ts";

/**
 * One small file of each language, with a function in it, for the checks that only ask whether a shipped grammar
 * loads and parses: the grammar of each id, and a bundle run per language. The semantics are pinned by the fixtures
 * under `languages/`; these only have to be valid source.
 */
export interface LanguageSample {
  /** The path the file has in a repository, whose extension picks the adapter. */
  path: string;
  source: string;
  /** The qualified name of the function the file declares, as the structural layer names it. */
  unit: string;
}

/** A repository holding one file of every supported language, as the changes of one commit. */
export function polyglotChanges(): Change[] {
  return Object.values(adapterSamples).map((sample) => ({ op: "add", path: sample.path, content: sample.source }));
}

/** A Java class and a Kotlin class that use each other, which the one JVM graph sees as a cycle. */
export function jvmCycleChanges(): Change[] {
  return [
    { op: "add", path: "src/main/java/acme/Order.java", content: "package acme;\n\npublic class Order {\n    public int total() {\n        return new Pricing().price(this);\n    }\n}\n" },
    { op: "add", path: "src/main/kotlin/acme/Pricing.kt", content: "package acme\n\nclass Pricing {\n    fun price(order: Order): Int {\n        return order.total() + 1\n    }\n}\n" },
  ];
}

/** By adapter id. */
export const adapterSamples: Record<string, LanguageSample> = {
  typescript: { path: "src/a.ts", source: "export const add = (a: number, b: number): number => a + b;\n", unit: "add" },
  cpp: { path: "src/a.cpp", source: "int add(int a, int b) { return a + b; }\n", unit: "add" },
  csharp: { path: "src/A.cs", source: "public class A { public int Add(int a, int b) { return a + b; } }\n", unit: "A.Add" },
  go: { path: "a/a.go", source: "package a\n\nfunc Add(a int, b int) int { return a + b }\n", unit: "Add" },
  java: { path: "src/main/java/a/A.java", source: "package a;\n\npublic class A { public int add(int a, int b) { return a + b; } }\n", unit: "A.add" },
  kotlin: { path: "src/main/kotlin/a/A.kt", source: "package a\n\nclass A {\n    fun add(a: Int, b: Int): Int {\n        return a + b\n    }\n}\n", unit: "A.add" },
  python: { path: "a/a.py", source: "def add(a, b):\n    return a + b\n", unit: "add" },
  rust: { path: "src/lib.rs", source: "pub fn add(a: i32, b: i32) -> i32 { a + b }\n", unit: "add" },
};

/** By grammar id: a line that must parse with no error. */
export const grammarSamples: Record<string, string> = {
  typescript: "export const f = (a: number): number => a;",
  tsx: "const a = <div>{x}</div>;",
  javascript: "export const f = (a) => a;",
  cpp: "int add(int a, int b) { return a + b; }",
  csharp: "public class A { public int Add(int a, int b) { return a + b; } }",
  go: "package a\n\nfunc Add(a int, b int) int { return a + b }",
  java: "public class A { public int add(int a, int b) { return a + b; } }",
  kotlin: "class A {\n    fun add(a: Int, b: Int): Int {\n        return a + b\n    }\n}",
  python: "def add(a, b):\n    return a + b",
  rust: "pub fn add(a: i32, b: i32) -> i32 { a + b }",
};
