import { expect, test } from "vitest";
import { changeBarsHtml, changeBarsMd } from "../src/components/change-bars.ts";
import { niceCeiling, spreadLabels, tickIndexes, trendChartHtml, trendChartMd, MAX_SERIES } from "../src/components/trend-chart.ts";
import { readTrend, trendGridHtml, trendGridMd } from "../src/components/trend-grid.ts";

const labels = ["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01"];

test("the axis of a trend chart ends at a round number at or above the greatest value", () => {
  expect([0, 0.7, 1.92, 2.5, 222, 1000].map(niceCeiling)).toEqual([1, 0.8, 2, 2.5, 250, 1000]);
});

test("the samples named under the axis are the first, the last and those evenly between", () => {
  expect(tickIndexes(4)).toEqual([0, 1, 2, 3]);
  expect(tickIndexes(11, 4)).toEqual([0, 3, 7, 10]);
  expect(tickIndexes(11, 1)).toEqual([0, 10]);
});

test("end labels that would overlap are moved apart and keep their order", () => {
  const ys = spreadLabels([100, 102, 50], 13, 10, 300);
  expect(ys[2]).toBe(50);
  expect(ys[0]).toBe(100);
  expect(ys[1]).toBe(113);
  // Against the bottom edge, the labels are pushed up.
  expect(spreadLabels([298, 299], 13, 10, 300)).toEqual([287, 300]);
});

test("a trend chart draws a line per series, breaks it where a value is missing, and keeps its table in the page", () => {
  const html = trendChartHtml({ title: "Mean", unit: "mean distance per use", labels, series: [{ name: "a", values: [1, 2, 3, 4] }, { name: "b", values: [1, null, 3, 4] }] });
  expect(html.match(/<g class="series cat-\d">/g)).toEqual(['<g class="series cat-1">', '<g class="series cat-2">']);
  // Series b has one point before the gap, which draws a dot and no line, and one line after it.
  expect(html.match(/<polyline/g)).toHaveLength(2);
  expect(html).toContain("<details>");
  expect(html).toContain("<summary>Table of the 4 samples</summary>");
  expect(html).toMatch(/<th scope="row">2025-02-01<\/th><td class="number">2<\/td><td class="number">none<\/td>/);
  expect(html).toContain("b goes from 1 (2025-01-01) to 4 (2025-04-01)");
});

test("a trend chart draws the first six series and says how many it left to the table", () => {
  const series = Array.from({ length: MAX_SERIES + 2 }, (_, i) => ({ name: `s${i}`, values: [i, i, i, i] }));
  const html = trendChartHtml({ title: "Many", unit: "u", labels, series });
  expect(html.match(/<g class="series/g)).toHaveLength(MAX_SERIES);
  expect(html).toContain("2 more series are in the table and are not drawn");
  expect(trendChartMd({ title: "Many", unit: "u", labels, series })).toContain("| s7 |");
});

test("a trend chart with fewer than two samples prints one line in its place", () => {
  const data = { title: "Mean", unit: "u", labels: ["2025-01-01"], series: [{ name: "a", values: [1] }] };
  expect(trendChartHtml(data)).toContain("fewer than two samples");
  expect(trendChartHtml(data)).not.toContain("<svg");
  expect(trendChartMd({ ...data, emptyText: "Nothing to draw." })).toBe("> **Notice:** Nothing to draw.");
});

test("a trend is read from the first value an item has to its last", () => {
  expect(readTrend(labels, [1, 1.2, 1.5, 2], 0.05)).toEqual({ first: { label: "2025-01-01", value: 1 }, last: { label: "2025-04-01", value: 2 }, ended: false, trend: "stronger" });
  expect(readTrend(labels, [2, 2, 2, 2.05], 0.05).trend).toBe("stable");
  expect(readTrend(labels, [null, 2, 1, 1], 0.05)).toMatchObject({ first: { label: "2025-02-01" }, trend: "weaker" });
  // A single value has no trend, and a series that stops before the last sample has ended.
  expect(readTrend(labels, [null, null, null, 3])).toMatchObject({ trend: null, ended: false });
  expect(readTrend(labels, [1, 2, null, null])).toMatchObject({ ended: true, last: { label: "2025-02-01", value: 2 } });
  expect(readTrend(labels, [null, null, null, null])).toEqual({ first: null, last: null, ended: true, trend: null });
});

test("a trend grid has a panel per item and prints the trend in words", () => {
  const data = {
    title: "Folders",
    unit: "mean distance per use",
    labels,
    tolerance: 0.05,
    wording: { stronger: "further apart", weaker: "closer", stable: "no clear change" },
    items: [
      { name: "src/app", values: [1, 1.2, 1.5, 2] },
      { name: "src/core", values: [2, 1.8, 1.2, 1] },
      { name: "src/new", values: [null, null, null, 3] },
      { name: "src/gone", values: [1, 1, null, null] },
    ],
  };
  const html = trendGridHtml(data);
  expect(html.match(/<g class="panel/g)).toHaveLength(4);
  for (const words of ["src/app: 1 to 2, further apart", "src/core: 2 to 1, closer", "src/new: 3 to 3, first seen 2025-04-01", "src/gone: 1 to 1, no value after 2025-02-01"]) expect(html).toContain(words);
  expect(html).toContain("1 further apart, 1 closer, 1 first seen 2025-04-01, 1 no value after 2025-02-01");
  expect(html).toContain("a change within 5 percent of the first value is no clear change");
  expect(trendGridMd(data)).toContain("| src/core | 2025-01-01 | 2 | 1 | -1 | closer |");
});

test("change bars share one scale, with the zero line placed so the longest bar each way fits", () => {
  const data = { title: "Change", unit: "import distance", samples: ["2025-01-01", "2025-04-01"] as [string, string], bars: [{ label: "a", from: 0, to: 300 }, { label: "b", from: 100, to: 0 }, { label: "c", from: 5, to: 5 }] };
  const html = changeBarsHtml(data);
  const widths = [...html.matchAll(/<g class="change (rise|fall|level)">.*?<rect x="([\d.]+)" y="\d+" width="([\d.]+)"/g)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
  const zero = Number(/<line class="zero" x1="([\d.]+)"/.exec(html)![1]);
  expect(widths.map((w) => w[0])).toEqual(["rise", "fall", "level"]);
  // The rise is three times the fall, starts at the zero line, and the fall ends at it.
  expect(widths[0]![1]).toBe(zero);
  expect(widths[0]![2]).toBeCloseTo((widths[1]![2] as number) * 3, 0);
  expect((widths[1]![1] as number) + (widths[1]![2] as number)).toBeCloseTo(zero, 0);
  expect(html).toContain("a: 0 to 300, rose by 300");
  expect(changeBarsMd(data)).toContain("| b | 100 | 0 | -100 | fell |");
  expect(changeBarsHtml({ ...data, bars: [] })).toContain("nothing changed");
});
