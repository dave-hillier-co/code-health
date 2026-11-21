import { expect, test } from "vitest";
import { renderTable } from "../src/table.ts";

test("renders a header and aligned columns, numbers right aligned", () => {
  const text = renderTable(
    [
      { path: "src/a.ts", score: 12.5 },
      { path: "b.ts", score: 3 },
    ],
    ["path", "score"],
    { limit: 20, total: 2, cut: 0 },
  );
  expect(text).toBe(["path      score", "src/a.ts   12.5", "b.ts          3", ""].join("\n"));
});

test("floats are rounded like the JSON output", () => {
  expect(renderTable([{ x: 1 / 3 }], ["x"], { limit: 20, total: 1, cut: 0 })).toContain("0.333333");
});

test("missing values show a dash and structured values show compact JSON", () => {
  const text = renderTable([{ a: null, b: ["x", "y"] }], ["a", "b", "c"], { limit: 20, total: 1, cut: 0 });
  expect(text).toContain('-  ["x","y"]  -');
});

test("notes how many rows were cut", () => {
  const text = renderTable([{ a: 1 }], ["a"], { limit: 1, total: 5, cut: 4 });
  expect(text.trimEnd().split("\n").at(-1)).toBe("4 more not shown (use --limit N or --limit all)");
});

test("empty results say so", () => {
  expect(renderTable([], ["a"], { limit: 20, total: 0, cut: 0 })).toBe("No results.\n");
});
