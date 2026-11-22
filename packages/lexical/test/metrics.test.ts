import { expect, test } from "vitest";
import { findFunctionBlocks } from "../src/blocks.ts";
import { blockMetrics, isBumpyRoad, keywordComplexity } from "../src/metrics.ts";
import { profiles } from "../src/profile.ts";
import { stripSource } from "../src/strip.ts";

function only(source: string, profile: keyof typeof profiles) {
  const p = profiles[profile]!;
  const lines = stripSource(source, p);
  const found = findFunctionBlocks(lines, p);
  expect(found).toHaveLength(1);
  return blockMetrics(lines, found[0]!, p);
}

const threeBumps = [
  "function f(a, b) {", // 1
  "    if (a && b) {", // 2
  "        for (x of y) {", // 3
  "            use(x);", // 4
  "        }", // 5
  "    } else {", // 6
  "        a = 1;", // 7
  "    }", // 8
  "    while (c || d) {", // 9
  "        if (e) {", // 10
  "            g();", // 11
  "        }", // 12
  "    }", // 13
  "    return a ?? b;", // 14
  "}", // 15
].join("\n");

test("brace-style function metrics, checked by hand", () => {
  expect(only(threeBumps, "typescript")).toEqual({
    length: 15,
    // Levels below the base: 0 1 2 3 2 1 2 1 1 2 3 2 1 1 0
    indentationComplexity: 22,
    maxNesting: 2,
    // if, &&, for, while, ||, if, ??
    keywordComplexity: 7,
    // Runs at depth 2 or more: lines 3-5 (after if), 7 (after else), 10-12 (after while)
    bumps: 3,
    bumpDepth: 3,
    bumpSize: 3,
  });
});

test("Python function metrics, checked by hand", () => {
  const source = [
    "def g(x):", // 1
    "    if x:", // 2
    "        for i in x:", // 3
    "            pass", // 4
    "    elif y:", // 5
    "        return 1", // 6
    "    return 0", // 7
  ].join("\n");
  expect(only(source, "python")).toEqual({
    length: 7,
    indentationComplexity: 10,
    maxNesting: 2,
    keywordComplexity: 3,
    bumps: 2,
    bumpDepth: 3,
    bumpSize: 2,
  });
});

test("keywords and operators in strings and comments are not counted", () => {
  const source = 'function f() {\n  const s = "if (a && b)"; // while (x || y)\n  /* for case catch */\n  return s;\n}\n';
  const lines = stripSource(source, profiles.typescript!);
  expect(keywordComplexity(lines, profiles.typescript!)).toBe(0);
});

test("keyword complexity counts a range of lines", () => {
  const lines = stripSource(threeBumps, profiles.typescript!);
  expect(keywordComplexity(lines, profiles.typescript!)).toBe(7);
  expect(keywordComplexity(lines, profiles.typescript!, 9, 13)).toBe(3);
});

test("else if counts once and Rust closures and references are not short circuits", () => {
  const source = [
    "fn f(a: &&str, b: bool) {",
    "    let c = move || 1;",
    "    if b && true {",
    "    } else if a.len() > 1 {",
    "    }",
    "}",
  ].join("\n");
  expect(only(source, "rust").keywordComplexity).toBe(3);
});

test("an opening brace on its own line still opens a bump", () => {
  const source = [
    "void M()", // 1
    "{", // 2
    "    if (a)", // 3
    "    {", // 4
    "        if (b)", // 5
    "        {", // 6
    "            x();", // 7
    "        }", // 8
    "    }", // 9
    "}", // 10
  ].join("\n");
  const m = only(source, "csharp");
  expect(m.bumps).toBe(1);
  expect(m.bumpSize).toBe(4);
  expect(m.bumpDepth).toBe(3);
});

test("deep nesting is not a bump unless a branch keyword opens it", () => {
  const source = "function f() {\n  const o = {\n    a: {\n      b: 1,\n    },\n  };\n}\n";
  expect(only(source, "typescript").bumps).toBe(0);
});

test("a single-line function has no nesting and one line", () => {
  const m = only("function f() { return 1; }\n", "typescript");
  expect(m).toMatchObject({ length: 1, indentationComplexity: 0, maxNesting: 0, bumps: 0 });
});

test("bumpy road guidelines: three bumps, or two when one is deeper than the nesting guideline", () => {
  expect(isBumpyRoad({ bumps: 3, bumpDepth: 2 })).toBe(true);
  expect(isBumpyRoad({ bumps: 2, bumpDepth: 4 })).toBe(false);
  expect(isBumpyRoad({ bumps: 2, bumpDepth: 5 })).toBe(true);
  expect(isBumpyRoad({ bumps: 1, bumpDepth: 9 })).toBe(false);
  expect(isBumpyRoad({ bumps: 2, bumpDepth: 3 }, { bumps: 2 })).toBe(true);
});
