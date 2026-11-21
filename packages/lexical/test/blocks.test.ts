import { expect, test } from "vitest";
import { findFunctionBlocks } from "../src/blocks.ts";
import { profiles } from "../src/profile.ts";
import { stripSource } from "../src/strip.ts";

function blocks(source: string, profile: keyof typeof profiles) {
  const p = profiles[profile]!;
  return findFunctionBlocks(stripSource(source, p), p).map((b) => [b.qualifiedName, b.startLine, b.endLine]);
}

test("TypeScript functions, methods and arrow functions", () => {
  const source = [
    "export function plain(a: number): number {", // 1
    "  if (a) {", // 2
    "    return 1;", // 3
    "  }", // 4
    "  return 2;", // 5
    "}", // 6
    "class Box {", // 7
    "  @dec()", // 8
    "  public async load(id: string): Promise<void> {", // 9
    "    const f = (x) => {", // 10
    "      return x;", // 11
    "    };", // 12
    "  }", // 13
    "}", // 14
    "export const arrow = async (a: number) => {", // 15
    "  return a;", // 16
    "};", // 17
    "items.forEach((i) => {", // 18
    "  log(i);", // 19
    "});", // 20
  ].join("\n");
  expect(blocks(source, "typescript")).toEqual([
    ["plain", 1, 6],
    ["Box.load", 9, 13],
    ["Box.load.f", 10, 12],
    ["arrow", 15, 17],
    [undefined, 18, 20],
  ]);
});

test("control flow and object literals are not functions", () => {
  const source = "function a() {\n  for (let i = 0; i < 3; i++) {\n    if (i) { x(); } else { y(); }\n  }\n  const o = { k: 1 };\n}\n";
  expect(blocks(source, "typescript")).toEqual([["a", 1, 6]]);
});

test("braces inside strings and comments do not unbalance blocks", () => {
  const source = 'function a() {\n  const s = "}"; // }\n  /* { */\n  return `${"{"}`;\n}\nfunction b() {\n}\n';
  expect(blocks(source, "typescript")).toEqual([
    ["a", 1, 5],
    ["b", 6, 7],
  ]);
});

test("a multi-line signature starts at its first line", () => {
  const source = "function wide(\n  a: number,\n  b: number,\n): number {\n  return a + b;\n}\n";
  expect(blocks(source, "typescript")).toEqual([["wide", 1, 6]]);
});

test("C# methods with attributes, constructors and lambdas", () => {
  const source = [
    "namespace App {", // 1
    "  public class Svc {", // 2
    "    [Fact]", // 3
    "    public int Run(int a, int b) {", // 4
    "      foreach (var x in xs) { Do(x); }", // 5
    "      items.ForEach(i => {", // 6
    "        Log(i);", // 7
    "      });", // 8
    "      return a;", // 9
    "    }", // 10
    "    public Svc() : base() {", // 11
    "    }", // 12
    "    public int Prop { get { return 1; } }", // 13
    "  }", // 14
    "}", // 15
  ].join("\n");
  expect(blocks(source, "csharp")).toEqual([
    ["App.Svc.Run", 4, 10],
    [undefined, 6, 8],
    ["App.Svc.Svc", 11, 12],
  ]);
});

test("C++ functions, qualified definitions, templates and lambdas", () => {
  const source = [
    "#include <vector>", // 1
    "namespace n {", // 2
    "template <typename T>", // 3
    "T add(T a, T b) {", // 4
    "  return a + b;", // 5
    "}", // 6
    "int Widget::size() const noexcept {", // 7
    "  auto f = [&](int x) { return x; };", // 8
    "  while (x) { y(); }", // 9
    "  return 0;", // 10
    "}", // 11
    "}", // 12
  ].join("\n");
  expect(blocks(source, "cpp")).toEqual([
    ["n.add", 3, 6],
    ["n.Widget::size", 7, 11],
    [undefined, 8, 8],
  ]);
});

test("Java methods, annotations and anonymous lambdas", () => {
  const source = [
    "public class A {", // 1
    "  @Override", // 2
    "  public String toString() throws IOException {", // 3
    "    list.forEach(x -> {", // 4
    "      use(x);", // 5
    "    });", // 6
    "    try {", // 7
    "      return \"a\";", // 8
    "    } catch (Exception e) {", // 9
    "      return \"b\";", // 10
    "    }", // 11
    "  }", // 12
    "}", // 13
  ].join("\n");
  expect(blocks(source, "java")).toEqual([
    ["A.toString", 3, 12],
    [undefined, 4, 6],
  ]);
});

test("Rust functions, impl methods and closures", () => {
  const source = [
    "pub fn free<T>(a: T) -> T where T: Copy {", // 1
    "    a",
    "}", // 3
    "impl<T> Stack<T> {", // 4
    "    pub fn push(&mut self, v: T) {", // 5
    "        let c = |x| {", // 6
    "            x", // 7
    "        };", // 8
    "        match v {", // 9
    "            _ => {}", // 10
    "        }", // 11
    "    }", // 12
    "}", // 13
  ].join("\n");
  expect(blocks(source, "rust")).toEqual([
    ["free", 1, 3],
    ["Stack.push", 5, 12],
    [undefined, 6, 8],
  ]);
});

test("Python functions end where indentation returns, with nesting and decorators", () => {
  const source = [
    "class Repo:", // 1
    "    @staticmethod", // 2
    "    def load(", // 3
    "        path,", // 4
    "    ):", // 5
    '        """doc', // 6
    "        text", // 7
    '        """', // 8
    "        def inner():", // 9
    "            return 1", // 10
    "", // 11
    "        # trailing comment", // 12
    "        return inner()", // 13
    "", // 14
    "    def save(self): return 1", // 15
    "", // 16
    "def free():", // 17
    "    pass", // 18
    "", // 19
  ].join("\n");
  expect(blocks(source, "python")).toEqual([
    ["Repo.load", 3, 13],
    ["Repo.load.inner", 9, 10],
    ["Repo.save", 15, 15],
    ["free", 17, 18],
  ]);
});

test("an unclosed brace block is dropped rather than guessed", () => {
  expect(blocks("function a() {\n  x();\n", "typescript")).toEqual([]);
});
