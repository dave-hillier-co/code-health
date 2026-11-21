import { expect, test } from "vitest";
import { detectIndentUnit, indentationMetrics, lengthMetrics, levelOf } from "../src/indentation.ts";
import { profiles } from "../src/profile.ts";
import { stripSource } from "../src/strip.ts";

test("the indent unit is the most common increase in space indentation", () => {
  const two = stripSource("a\n  b\n    c\n  d\ne\n  f\n");
  expect(detectIndentUnit(two)).toBe(2);
  const four = stripSource("a\n    b\n        c\n    d\n");
  expect(detectIndentUnit(four)).toBe(4);
});

test("a file with no indentation evidence falls back to four", () => {
  expect(detectIndentUnit(stripSource("a\nb\n"))).toBe(4);
});

test("levels count tabs singly and divide spaces by the unit", () => {
  expect(levelOf("\t\tx", 4)).toBe(2);
  expect(levelOf("        x", 4)).toBe(2);
  expect(levelOf("      x", 4)).toBe(1);
  expect(levelOf("x", 2)).toBe(0);
});

test("indentation complexity sums levels over non-blank lines when there is no profile", () => {
  const lines = stripSource("a\n  b\n\n    c\n  d\n");
  expect(indentationMetrics(lines)).toEqual({ indentUnit: 2, indentationComplexity: 0 + 1 + 2 + 1, maxIndent: 2 });
});

test("two-space and tab indentation of the same shape give the same value", () => {
  const spaces = stripSource("a\n  b\n    c\n");
  const tabs = stripSource("a\n\tb\n\t\tc\n");
  expect(indentationMetrics(spaces).indentationComplexity).toBe(3);
  expect(indentationMetrics(tabs).indentationComplexity).toBe(3);
});

test("a profile leaves out comment lines and the body of multi-line strings", () => {
  const source = "f() {\n    // note\n        /* deep\n              comment */\n    x = `\n                  text\n  `;\n}\n";
  const lines = stripSource(source, profiles.typescript);
  // f() {: 0; x = `: 1; closing backtick line holds code ";": level 0 (2 spaces / 4); }: 0
  expect(indentationMetrics(lines).indentationComplexity).toBe(1);
  expect(indentationMetrics(stripSource(source)).indentationComplexity).toBeGreaterThan(1);
});

test("length counts non-blank lines and, with a profile, code lines", () => {
  const lines = stripSource("a\n\n// c\nb\n", profiles.java);
  expect(lengthMetrics(lines)).toEqual({ lineCount: 4, nonBlankLines: 3, codeLines: 2 });
});
