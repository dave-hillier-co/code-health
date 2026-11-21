import { expect, test } from "vitest";
import { profiles } from "../src/profile.ts";
import { stripSource } from "../src/strip.ts";

const code = (source: string, profile: keyof typeof profiles) =>
  stripSource(source, profiles[profile]).map((line) => line.code);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const kinds = (source: string, profile: keyof typeof profiles) =>
  stripSource(source, profiles[profile]).map((line) => line.kind);

test("line and block comments are blanked and classified", () => {
  const source = "int a; // trailing\n// whole\n/* block\n  more */ int b;\n\n";
  expect(code(source, "java").map(squash)).toEqual(["int a;", "", "", "int b;", ""]);
  expect(kinds(source, "java")).toEqual(["code", "comment", "comment", "code", "blank"]);
});

test("comment markers inside strings do not start comments", () => {
  const [line] = code('const a = "// not"; // real', "typescript");
  expect(squash(line!)).toBe("const a = ;");
});

test("template literals keep interpolated code and blank the text", () => {
  const [line] = code("const s = `a ${ x && y } // b ${ `n${z}` }`;", "typescript");
  expect(line).toContain("x && y");
  expect(line).toContain("z");
  expect(line).not.toContain("//");
  expect(line!.endsWith(";")).toBe(true);
});

test("multi-line template literals mark continuation lines as literal", () => {
  const source = "const s = `\n    if (a) {\n`;\nnext();\n";
  expect(kinds(source, "typescript")).toEqual(["code", "literal", "code", "code"]);
  expect(code(source, "typescript")[1]!.trim()).toBe("");
});

test("escaped quotes do not end a string", () => {
  const [line] = code('x = "a\\"b" + y;', "java");
  expect(squash(line!)).toBe("x = + y;");
});

test("an unterminated single-line string ends at the newline", () => {
  expect(code("a = 'oops\nb;", "typescript").map(squash)).toEqual(["a =", "b;"]);
});

test("C# verbatim strings span lines and use doubled quotes", () => {
  const source = 'var s = @"a ""quoted"" \n  line // x"; int n;\n';
  const stripped = stripSource(source, profiles.csharp!);
  expect(stripped[0]!.code.trim()).toBe("var s =");
  expect(stripped[1]!.kind).toBe("code");
  expect(stripped[1]!.code.trim()).toBe("; int n;");
});

test("C# raw string literals end at the matching quote run", () => {
  const source = 'var s = """\n  has "quotes" inside\n  """;\nint x;\n';
  expect(code(source, "csharp")[1]!.trim()).toBe("");
  expect(code(source, "csharp")[2]!.trim()).toBe(";");
  expect(code(source, "csharp")[3]).toBe("int x;");
});

test("C# interpolated strings are blanked", () => {
  expect(squash(code('var s = $"a {b}"; // c', "csharp")[0]!)).toBe("var s = ;");
});

test("C++ raw strings use their delimiter and character literals are blanked", () => {
  const source = "auto s = R\"x(a )\" // not a comment\n)x\"; char c = '\"'; int n = 1'000;\n";
  const result = code(source, "cpp");
  expect(result[0]!.trim()).toBe("auto s =");
  expect(result[1]!.replace(/\s+/g, " ").trim()).toBe("; char c = ; int n = 1'000;");
});

test("Java text blocks are blanked", () => {
  const source = 'String t = """\n  if (x) {\n  """;\nint y;\n';
  expect(code(source, "java")[1]!.trim()).toBe("");
  expect(kinds(source, "java")[1]).toBe("literal");
});

test("Rust raw strings, lifetimes, char literals and nested block comments", () => {
  const source = [
    "fn f<'a>(x: &'a str) -> char { /* a /* nested */ still comment */ let r = r#\"say \"hi\"\"#; '{' }",
    "",
  ].join("\n");
  const [line] = code(source, "rust");
  expect(line).toContain("fn f<'a>(x: &'a str) -> char {");
  expect(line).not.toContain("nested");
  expect(line).not.toContain("hi");
  expect(line!.match(/\{/g)).toHaveLength(1);
  expect(line!.trimEnd().endsWith("}")).toBe(true);
});

test("Python comments, triple-quoted strings and prefixed strings", () => {
  const source = 'def f():\n    """doc\n    if x:\n    """\n    s = f"a#b"  # c\n    return s\n';
  expect(kinds(source, "python")).toEqual(["code", "code", "literal", "literal", "code", "code"]);
  expect(code(source, "python")[4]!.trim()).toBe("s = f");
});

test("without a profile only blank and code are distinguished", () => {
  expect(stripSource("a\n\n  # b\n").map((l) => l.kind)).toEqual(["code", "blank", "code"]);
});

test("CRLF line endings and a BOM are normalised", () => {
  const lines = stripSource("\uFEFFa\r\n  b\r\n", profiles.java);
  expect(lines.map((l) => l.text)).toEqual(["a", "  b"]);
});

test("regex literals are masked so quotes and comment markers inside them start nothing", () => {
  const backtick = stripSource("const r = /`/g;\nif (a) { b(); }\n", profiles.typescript);
  expect(backtick.map((line) => line.kind)).toEqual(["code", "code"]);
  expect(squash(backtick[1]!.code)).toBe("if (a) { b(); }");

  const star = code("const r = /[/*]/;\n// real\nx();\n", "typescript");
  expect(kinds("const r = /[/*]/;\n// real\nx();\n", "typescript")).toEqual(["code", "comment", "code"]);
  expect(squash(star[0]!)).toBe("const r = ;");

  const slashes = code("const r = /https?:\\/\\//; const t = 1;", "typescript");
  expect(squash(slashes[0]!)).toBe("const r = ; const t = 1;");
});

test("a slash after a name, number or closer is division, not a regex", () => {
  expect(squash(code("const x = a / b / c; y = (a) / 2 / 3;", "typescript")[0]!)).toBe("const x = a / b / c; y = (a) / 2 / 3;");
  expect(squash(code("const x = a / 2; // c", "typescript")[0]!)).toBe("const x = a / 2;");
});

test("regex literals after return and in call arguments are masked", () => {
  expect(squash(code("return /'/.test(s) && f();", "typescript")[0]!)).toBe("return .test(s) && f();");
  expect(squash(code("s.replace(/\"/g, '');", "typescript")[0]!)).toBe("s.replace( , );");
});
