import { expect, test } from "vitest";
import { analyseSource } from "../src/analyse-source.ts";
import { indentationComplexity } from "../src/indentation-complexity.ts";

test("an empty or blank-only file has no complexity", () => {
  expect(indentationComplexity("")).toBe(0);
  expect(indentationComplexity("\n   \n\t\n")).toBe(0);
});

test("sums the logical indentation levels of non-blank lines", () => {
  const text = ["function f() {", "  if (x) {", "    y();", "  }", "}", ""].join("\n");
  expect(indentationComplexity(text)).toBe(4);
});

test("the indent unit is the file's own, so two and four space files agree", () => {
  expect(indentationComplexity("a\n  b\n    c\n")).toBe(3);
  expect(indentationComplexity("a\n    b\n        c\n")).toBe(3);
});

test("a tab is one level", () => {
  expect(indentationComplexity("a\n\tb\n\t\tc\n")).toBe(3);
});

test("blank lines and CRLF line endings do not count", () => {
  expect(indentationComplexity("a\r\n\r\n  b\r\n")).toBe(1);
});

test("is the one definition analyseSource reports, with and without a path", () => {
  const text = ["function f() {", "  // commented out", "      deep();", "  const s = `", "        body", "  `;", "}", ""].join("\n");
  for (const path of ["a.ts", "a.txt"]) {
    expect(indentationComplexity(text, path)).toBe(analyseSource(path, text).file.indentationComplexity);
  }
});

test("leaves out comment lines and multi-line string bodies when the path has a profile", () => {
  const text = "function f() {\n      // deep comment\n  g();\n}\n";
  expect(indentationComplexity(text, "a.ts")).toBe(1);
  expect(indentationComplexity(text)).toBe(analyseSource("a.unknown", text).file.indentationComplexity);
});
