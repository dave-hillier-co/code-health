import { expect, test } from "vitest";
import { detectIndentUnit, indentationComplexity } from "../src/indentation-complexity.ts";

test("an empty or blank-only file has no complexity", () => {
  expect(indentationComplexity("")).toBe(0);
  expect(indentationComplexity("\n   \n\t\n")).toBe(0);
});

test("sums the logical indentation levels of non-blank lines", () => {
  const text = ["function f() {", "  if (x) {", "    y();", "  }", "}", ""].join("\n");
  // levels 0, 1, 2, 1, 0
  expect(indentationComplexity(text)).toBe(4);
});

test("the indent unit is the file's own, so two and four space files agree", () => {
  const two = "a\n  b\n    c\n";
  const four = "a\n    b\n        c\n";
  expect(indentationComplexity(two)).toBe(3);
  expect(indentationComplexity(four)).toBe(3);
});

test("a tab is one level", () => {
  expect(indentationComplexity("a\n\tb\n\t\tc\n")).toBe(3);
});

test("blank lines and CRLF line endings do not count", () => {
  expect(indentationComplexity("a\r\n\r\n  b\r\n")).toBe(1);
});

test("the unit is the most common positive step between lines, the smaller on a tie", () => {
  expect(detectIndentUnit(["a", "  b", "    c", "      d", "e", "    f"])).toBe(2);
  expect(detectIndentUnit(["a", "  b", "e", "    f"])).toBe(2);
  expect(detectIndentUnit(["a", "b"])).toBe(4);
});
