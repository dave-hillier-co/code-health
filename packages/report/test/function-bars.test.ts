import { expect, test } from "vitest";
import { functionBarsHtml, functionBarsMd, type FunctionBarsData } from "../src/components/function-bars.ts";
import { sharedChanges, xrayFigures, XRAY_BARS, type XrayData, type XrayFunction } from "../src/xray.ts";

const data: FunctionBarsData = {
  title: "Functions by cognitive complexity",
  unit: "cognitive complexity",
  guideline: 15,
  bars: [{ label: "parse", value: 30, revisions: 12, fixes: 4 }, { label: "format", value: 15, revisions: 3, fixes: 0 }, { label: "plain", value: 5, revisions: null, fixes: null }],
  omitted: { count: 7, reason: "the least complex" },
};

test("a bar above the guideline carries a triangle and the words, and an unmeasured figure prints none", () => {
  const html = functionBarsHtml(data);
  expect(html).toContain("▲ 30");
  expect(html).not.toContain("▲ 15");
  expect(html).toContain("above guideline");
  expect(html).toContain("at guideline");
  expect(html).toContain("below guideline");
  expect(html).toContain("The chart omits 7 functions: the least complex.");
  const md = functionBarsMd(data);
  expect(md).toContain("| parse | 30 | 15 | above guideline | 12 | 4 |");
  expect(md).toContain("| plain | 5 | 15 | below guideline | none | none |");
});

const fn = (name: string, cognitive: number, revisions: number | null): XrayFunction => ({ id: `a.ts#${name}`, name, startLine: 1, endLine: 2, length: 2, cognitive, nesting: 1, cyclomatic: 1, labels: [], revisions, fixes: revisions === null ? null : 0 });

test("shared changes count the changes two functions have in common, for the functions with the most revisions", () => {
  const functions = [fn("a", 5, 3), fn("b", 9, 2), fn("c", 1, 1), fn("d", 2, 4)];
  const changes: Record<string, string[]> = { "a.ts#a": ["x", "y", "z"], "a.ts#b": ["x", "y"], "a.ts#c": ["x"], "a.ts#d": ["x", "q", "r", "s"] };
  const shared = sharedChanges(functions, (id) => new Set(changes[id]));
  expect(shared?.ids).toEqual(["a.ts#d", "a.ts#a", "a.ts#b"]);
  expect(shared?.cells).toEqual([[null, 1, 1], [1, null, 2], [1, 2, null]]);
  expect(sharedChanges([fn("a", 5, 1), fn("b", 5, null)], () => undefined)).toBeUndefined();
});

test("the figures draw the most complex functions and name the omitted ones, and add the matrix only with shared changes", () => {
  const functions = Array.from({ length: XRAY_BARS + 3 }, (_, i) => fn(`f${i}`, 100 - i, 1));
  const guidelines = { cognitive: 15, cyclomatic: 10, nesting: 4, note: "complexity.guidelines" };
  const bare: XrayData = { file: "a.ts", functions, guidelines };
  const figures = xrayFigures(bare);
  expect(figures.map((b) => b.type)).toEqual(["function-bars"]);
  const bars = figures[0];
  if (bars?.type !== "function-bars") throw new Error("not bars");
  expect(bars.bars).toHaveLength(XRAY_BARS);
  expect(bars.omitted?.count).toBe(3);
  const withShared = xrayFigures({ ...bare, shared: { ids: ["a.ts#f0", "a.ts#f1"], cells: [[null, 1], [1, null]] } });
  expect(withShared.map((b) => b.type)).toEqual(["function-bars", "matrix"]);
});

test("matrix labels drop a shared class prefix and the start of long nested names, and keep the names when that would merge two", async () => {
  const { matrixLabels } = await import("../src/xray.ts");
  expect(matrixLabels(["A.run", "A.stop"])).toEqual(["run", "stop"]);
  expect(matrixLabels(["Activation.RunMessageLoop.ProcessPendingRequests", "Activation.Deactivate"])).toEqual(["…PendingRequests", "Deactivate"]);
  expect(matrixLabels(["A.x", "B.x"])).toEqual(["A.x", "B.x"]);
});
