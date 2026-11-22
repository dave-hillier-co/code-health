import { expect, test } from "vitest";
import { parseDiffs, touchedUnits } from "../src/fix-ranges.ts";
import type { UnitRecord } from "../src/measure.ts";

const unit = (name: string, startLine: number, endLine: number): UnitRecord => ({
  path: "a.ts",
  id: `a.ts#${name}`,
  name,
  kind: "function",
  startLine,
  endLine,
  test: false,
  source: "structural",
  values: {},
});

// inner is nested in outer, and other is a separate function after it.
const units = [unit("outer", 1, 20), unit("inner", 5, 9), unit("other", 22, 30)];

test("a changed line in a nested function counts for it and not for the function around it", () => {
  const touched = touchedUnits(units, [{ start: 6, count: 1 }]);
  expect([...touched.units]).toEqual(["a.ts#inner"]);
  expect(touched.outsideUnits).toBe(false);
});

test("a changed line in the outer function outside the nested one counts for the outer function only", () => {
  expect([...touchedUnits(units, [{ start: 12, count: 2 }]).units]).toEqual(["a.ts#outer"]);
});

test("a range across two functions counts for both, and the lines between them count against the file", () => {
  const touched = touchedUnits(units, [{ start: 19, count: 5 }]);
  expect([...touched.units].sort()).toEqual(["a.ts#other", "a.ts#outer"]);
  expect(touched.outsideUnits).toBe(true);
});

test("a changed line outside every function counts against the file", () => {
  const touched = touchedUnits(units, [{ start: 21, count: 1 }]);
  expect(touched.units.size).toBe(0);
  expect(touched.outsideUnits).toBe(true);
});

test("a deletion counts for the function that holds the lines either side of it", () => {
  const touched = touchedUnits(units, [{ start: 25, count: 0 }]);
  expect([...touched.units]).toEqual(["a.ts#other"]);
  expect(touched.outsideUnits).toBe(false);
});

test("a deletion between two functions, or before the first line, counts against the file and for no function", () => {
  for (const start of [20, 21, 0]) {
    const touched = touchedUnits(units, [{ start, count: 0 }]);
    expect(touched.outsideUnits, `at ${start}`).toBe(true);
    expect(touched.units.size, `at ${start}`).toBe(0);
  }
});

test("reads the new line ranges of each file of each commit, and whether the file was created", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const diff = [
    sha,
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@ function f() {",
    "-  old",
    "+  new",
    "@@ -10,2 +10,0 @@",
    "-x",
    "-y",
    "@@ -20,0 +19,3 @@",
    "+a",
    "+b",
    "+c",
    "diff --git a/src/new file.ts b/src/new file.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new file.ts\t",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    other,
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "",
  ].join("\n");
  const parsed = parseDiffs(diff);
  expect(parsed.get(sha)!.get("src/a.ts")).toEqual({
    added: false,
    ranges: [
      { start: 3, count: 1 },
      { start: 10, count: 0 },
      { start: 19, count: 3 },
    ],
  });
  expect(parsed.get(sha)!.get("src/new file.ts")).toEqual({ added: true, ranges: [{ start: 1, count: 2 }] });
  expect(parsed.get(other)!.size).toBe(0);
});
