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
  expect(md).toContain("| a.ts | b.ts | 60 | an expected pair |");
  expect(md).toContain("| b.ts | c.ts |  | a partner the change left out |");
  expect(md).toContain("e is an expected pair (2 cells); ? is a partner the change left out (1 cell).");
  const html = matrixHtml(square);
  expect(html).toContain('class="cell band-2 mark-expected"');
  expect(html).toContain(">60 e</text>");

});

test("groups draw one box along the diagonal and label their rows in the table", () => {
  const html = matrixHtml(square);
  expect(html.match(/<g class="group">/g)?.length).toBe(1);
  expect(html).toContain("1 box along the diagonal");
  expect(html).toContain("Boxes along the diagonal mark 1 group: cluster 1 (2 rows).");
  expect(matrixMd(square)).toContain("| cluster 1 | cluster 1 |");
  expect(matrixMd(square)).toContain("Rows are ordered by cluster.");
});

test("cells are square, empty cells print no text, and the table lists only cells with a value or a mark", () => {
  const html = matrixHtml(square);
  expect(html).not.toContain(">none</text>");
  expect(html).not.toContain(">none</td>");
  const sizes = [...html.matchAll(/<g class="cell[^"]*"><rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"/g)];
  expect(sizes.length).toBe(9);
  for (const [, w, h] of sizes) expect(w).toBe(h);
  // 5 cells hold a value or a mark: 60 e, 10, 60 e, ?, 10.
  expect(html.match(/<tr><td>/g)?.length).toBe(5);
  expect(html).toContain("<td>a.ts</td><td>b.ts</td><td class=\"number\">60</td><td>an expected pair</td>");
  expect(html).toContain("Grey blank cells have no value (4 cells of 9 cells).");
  const md = matrixMd(square);
  expect(md).toContain("| Row | Column | Value | Mark | Row group | Column group |");
  expect(md).toContain("| a.ts | b.ts | 60 | an expected pair | cluster 1 | cluster 1 |");
  expect(md).toContain("Blank cells have no value (4 cells of 9 cells).");
});

test("groups are ignored when rows and columns differ", () => {
  const html = matrixHtml({ ...square, columns: ["x.ts", "y.ts", "z.ts"] });
  expect(html).not.toContain('<g class="group">');
  expect(html).not.toContain("(cluster 1)");
});

test("a matrix without marks or groups prints only the blank-cell line after its list", () => {
  const plain = matrixMd({ title: "M", valueLabel: "v", rows: ["a"], columns: ["b"], cells: [[3]] });
  expect(plain.split("\n").at(-1)).toBe("The table lists the cells that have a value or a mark, in row order then column order. Blank cells have no value (0 cells of 1 cell).");
});
