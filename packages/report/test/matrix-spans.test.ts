import { expect, test } from "vitest";
import { matrixHtml, matrixMd, type MatrixData } from "../src/components/matrix.ts";
import { themeCss } from "../src/theme.ts";

const names = ["a", "b", "c", "d", "e"];
const square: MatrixData = {
  title: "Co-change",
  valueLabel: "coupling degree (percent)",
  rows: names,
  columns: names,
  cells: names.map((_, i) => names.map((_, j) => (i === j ? null : 10 * (i + j)))),
  spans: [{ label: "src", start: 0, end: 2 }, { label: "test", start: 3, end: 4 }],
};

test("a square matrix draws a bar above the columns and left of the rows for each span, with its own colour class", () => {
  const html = matrixHtml(square);
  expect(html.match(/<g class="span span-1">/g)?.length).toBe(2);
  expect(html.match(/<g class="span span-2">/g)?.length).toBe(2);
  expect(html).toContain(">src</text>");
  expect(html).toContain(">test</text>");
});

test("a line crosses the grid at each span boundary, and none at the edges", () => {
  const html = matrixHtml(square);
  expect(html.match(/class="span-boundary"/g)?.length).toBe(2);
});

test("the span label is printed in the table row header, the legend and the markdown", () => {
  const html = matrixHtml(square);
  expect(html).toContain("<td>src</td><td>src</td>");
  expect(html).toContain("<td>test</td><td>src</td>");
  expect(html).toContain("Bars above the columns and left of the rows mark 2 spans: src (3 rows), test (2 rows).");
  const md = matrixMd(square);
  expect(md).toContain("| a | b | 10 |  | src | src |");
  expect(md).toContain("Bars above the columns and left of the rows mark 2 spans: src (3 rows), test (2 rows).");
});

test("a matrix that is not square gets the bar beside the rows only", () => {
  const html = matrixHtml({ ...square, columns: ["x", "y", "z"], cells: names.map(() => [1, 2, 3]) });
  expect(html.match(/<g class="span span-1">/g)?.length).toBe(1);
  expect(html).toContain("Bars left of the rows mark 2 spans");
});

test("span colours repeat after six and groups still draw with spans", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"];
  const html = matrixHtml({
    title: "M",
    valueLabel: "v",
    rows,
    columns: rows,
    cells: rows.map(() => rows.map(() => 1)),
    spans: rows.map((label, i) => ({ label, start: i, end: i })),
    groups: [{ label: "cluster 1", start: 0, end: 1 }],
  });
  expect(html).toContain('class="span span-6"');
  expect(html.match(/class="span span-1"/g)?.length).toBe(4);
  expect(html).toContain('<g class="group">');
  expect(html).toContain("<td>a, cluster 1</td>");
});

test("a matrix without spans draws no bar and no line", () => {
  const html = matrixHtml({ ...square, spans: undefined });
  expect(html).not.toContain("span-boundary");
  expect(html).not.toContain('class="span ');
});

test("the column labels fit inside the drawing, so the longest label is not clipped at the top", () => {
  const long = "src/Orleans.Connections.Security";
  const html = matrixHtml({ title: "M", valueLabel: "v", rows: [long, "b"], columns: [long, "b"], cells: [[null, 1], [1, null]] });
  const height = Number(/viewBox="0 0 \d+ (\d+)"/.exec(html)![1]);
  const baseline = Number(/<text x="[\d.]+" y="([\d.]+)" transform="rotate\(-35/.exec(html)![1]);
  // The label rises about length x 6.4 px x sin 35 degrees above its baseline.
  expect(baseline - long.length * 6.4 * Math.sin((35 * Math.PI) / 180)).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(baseline);
});

test("a label longer than the limit is cut with an ellipsis in the drawing and kept whole in the table and hover title", () => {
  const long = "x".repeat(50);
  const html = matrixHtml({ title: "M", valueLabel: "v", rows: [long], columns: [long], cells: [[1]] });
  expect(html).toContain(`${"x".repeat(31)}…`);
  expect(html).toContain(`<title>${long}</title>`);
  expect(html).toContain(`<td>${long}</td>`);
});

test("the theme defines six span colours for light and dark", () => {
  for (let i = 1; i <= 6; i++) {
    expect(themeCss.match(new RegExp(`--span-${i}:`, "g"))?.length).toBe(2);
    expect(themeCss).toContain(`svg .span-${i} rect`);
  }
});
