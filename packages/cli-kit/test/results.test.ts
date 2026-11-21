import { expect, test } from "vitest";
import { CliError, ExitCode } from "../src/errors.ts";
import { shapeResults } from "../src/results.ts";

const rows = [
  { path: "b.ts", score: 1, churn: 3 },
  { path: "a.ts", score: 1, churn: 2 },
  { path: "c.ts", score: 9, churn: 1 },
  { path: "d.ts", score: 0.5, churn: 5 },
];

test("sorts by score descending then path ascending", () => {
  const { results } = shapeResults(rows, { limit: Infinity });
  expect((results as typeof rows).map((row) => row.path)).toEqual(["c.ts", "a.ts", "b.ts", "d.ts"]);
});

test("rows without a score sort by path", () => {
  const { results } = shapeResults([{ path: "z" }, { path: "a" }], { limit: Infinity });
  expect(results).toEqual([{ path: "a" }, { path: "z" }]);
});

test("does not mutate its input", () => {
  const copy = structuredClone(rows);
  shapeResults(rows, { limit: 1 });
  expect(rows).toEqual(copy);
});

test("limit cuts after sorting and reports what was cut", () => {
  const { results, truncated } = shapeResults(rows, { limit: 2 });
  expect((results as typeof rows).map((row) => row.path)).toEqual(["c.ts", "a.ts"]);
  expect(truncated).toEqual({ limit: 2, total: 4, cut: 2 });
});

test("no cut when everything fits, and an unlimited run has a null limit", () => {
  expect(shapeResults(rows, { limit: 10 }).truncated).toEqual({ limit: 10, total: 4, cut: 0 });
  expect(shapeResults(rows, { limit: Infinity }).truncated).toEqual({ limit: null, total: 4, cut: 0 });
});

test("fields project each row after sorting, so unprojected fields can still order results", () => {
  const { results } = shapeResults(rows, { limit: 2, fields: ["path"] });
  expect(results).toEqual([{ path: "c.ts" }, { path: "a.ts" }]);
});

test("unknown fields are a usage error that lists the valid ones", () => {
  try {
    shapeResults(rows, { limit: 5, fields: ["path", "nope"], columns: ["path", "score", "churn"] });
    expect.unreachable();
  } catch (error) {
    expect((error as CliError).exitCode).toBe(ExitCode.Usage);
    expect((error as CliError).message).toMatch(/nope.*path, score, churn/s);
  }
});

test("results that are not a list pass through untouched", () => {
  const value = { verdict: "ok" };
  const shaped = shapeResults(value, { limit: 1, fields: ["x"] });
  expect(shaped.results).toBe(value);
  expect(shaped.truncated).toEqual({ limit: null, total: null, cut: 0 });
});

test("an empty result list accepts any fields, since no columns are known", () => {
  const { results } = shapeResults([], { limit: 5, fields: ["path"], columns: [] });
  expect(results).toEqual([]);
});

test("equal scores tie-break on path by byte order, as git sorts paths", () => {
  // U+FFFF is above U+10000 in UTF-16 code units (surrogates) but below it in UTF-8 bytes
  const { results } = shapeResults(
    [
      { path: "\u{10000}", score: 1 },
      { path: "\uffff", score: 1 },
    ],
    { limit: 5 },
  );
  expect(results).toEqual([{ path: "\uffff", score: 1 }, { path: "\u{10000}", score: 1 }]);
});
