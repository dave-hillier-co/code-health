import { expect, test } from "vitest";
import { matrixHtml, matrixMd, type MatrixData } from "../src/components/matrix.ts";

const square: MatrixData = {
  title: "Shared changes",
  valueLabel: "coupling degree (percent)",
  rows: ["a.ts", "b.ts", "c.ts"],
  columns: ["a.ts", "b.ts", "c.ts"],
  cells: [[null, 60, 10], [60, null, null], [10, null, null]],
  marks: { expected: { symbol: "e", text: "an expected pair" }, missing: { symbol: "?", text: "a partner the change left out" } },
  cellMarks: [[null, "expected", null], ["expected", null, "missing"], [null, null, null]],
  groups: [{ label: "cluster 1", start: 0, end: 1 }],
  orderText: "Rows are ordered by cluster.",
};

test("a marked cell prints its value and symbol, and the legend counts each mark in words", () => {
  const md = matrixMd(square);
  expect(md).toContain("| 60 e |");
  expect(md).toContain("| ? |");
  expect(md).toContain("e is an expected pair (2 cells); ? is a partner the change left out (1 cell).");
  const html = matrixHtml(square);
  expect(html).toContain('class="cell band-2 mark-expected"');
  expect(html).toContain(">60 e</text>");
  expect(html).toContain("<td class=\"number\">60 e</td>");
});

test("groups draw one box along the diagonal and label their rows in the table", () => {
  const html = matrixHtml(square);
  expect(html.match(/<g class="group">/g)?.length).toBe(1);
  expect(html).toContain("1 box along the diagonal");
  expect(html).toContain("Boxes along the diagonal mark 1 group: cluster 1 (2 rows).");
  expect(html).toContain("a.ts (cluster 1)");
  expect(matrixMd(square)).toContain("| a.ts (cluster 1) |");
  expect(matrixMd(square)).toContain("Rows are ordered by cluster.");
});

test("groups are ignored when rows and columns differ", () => {
  const html = matrixHtml({ ...square, columns: ["x.ts", "y.ts", "z.ts"] });
  expect(html).not.toContain('<g class="group">');
  expect(html).not.toContain("(cluster 1)");
});

test("a matrix without marks or groups prints no extra legend", () => {
  const plain = matrixMd({ title: "M", valueLabel: "v", rows: ["a"], columns: ["b"], cells: [[3]] });
  expect(plain.split("\n").at(-1)).toMatch(/^\|/);
});
