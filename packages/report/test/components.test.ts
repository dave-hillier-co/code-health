import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import { layoutTreemap, squarify } from "../src/components/treemap.ts";
import { trendOf } from "../src/components/trend-marker.ts";
import { sampleBlocks, sampleBuild, sampleTreemapItems, expectGoldenText, sampleReport, sampleNotes } from "./support.ts";

const context = { slots: sampleBuild.slots, notes: sampleNotes };

for (const [name, block] of Object.entries(sampleBlocks)) {
  test(`${name} renders to the golden html and markdown`, () => {
    expectGoldenText(`components/${name}.html`, `${renderBlock(block, "html", context)}\n`);
    expectGoldenText(`components/${name}.md`, `${renderBlock(block, "md", context)}\n`);
  });
}

test("a judgement block without notes reads not yet written in a draft", () => {
  const md = renderBlock(sampleBlocks.judgement!, "md", { slots: sampleBuild.slots, notes: undefined });
  expect(md).toContain("not yet written");
  expect(md).toContain("Say what to do.");
});

test("the whole page renders to the golden html and markdown, and the compact markdown", () => {
  const report = sampleReport();
  // The same report in each format is the one the kit prints.
  expectGoldenText("page/sample.html", renderPage("html"));
  expectGoldenText("page/sample.md", renderPage("md"));
  expectGoldenText("page/sample.compact.md", renderPage("md", true));
  expectGoldenText("page/sample.draft.md", renderPage("md", false, false));
  expect(report.stamp.kind).toBe("sample");
});

import { renderReport } from "../src/render.ts";
function renderPage(format: "html" | "md", compact = false, withNotes = true): string {
  return renderReport(sampleReport(), format, withNotes ? sampleNotes : undefined, { compact });
}

test("squarify fills the rectangle: areas are proportional to sizes and stay inside it", () => {
  const sizes = [50, 30, 10, 6, 4];
  const rects = squarify(sizes, { x: 0, y: 0, w: 100, h: 60 });
  const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
  expect(area).toBeCloseTo(6000, 3);
  rects.forEach((r, i) => {
    expect(r.w * r.h).toBeCloseTo((sizes[i]! / 100) * 6000, 3);
    expect(r.x).toBeGreaterThanOrEqual(-1e-9);
    expect(r.y).toBeGreaterThanOrEqual(-1e-9);
    expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(60 + 1e-9);
  });
});

test("the treemap nests tiles in their folders and orders each level largest first", () => {
  const { tiles, folders } = layoutTreemap(sampleTreemapItems.filter((i) => i.size > 0));
  expect(folders.map((f) => f.path).sort()).toEqual(["docs", "src", "src/core", "src/ui"]);
  const engine = tiles.find((t) => t.path === "src/core/engine.ts")!;
  const core = folders.find((f) => f.path === "src/core")!;
  expect(engine.x).toBeGreaterThanOrEqual(core.x);
  expect(engine.x + engine.w).toBeLessThanOrEqual(core.x + core.w + 1e-9);
});

test("the treemap counts the tiles it does not draw", () => {
  const html = renderBlock({ type: "treemap", title: "t", sizeLabel: "s", colourLabel: "c", maxTiles: 2, items: [1, 2, 3, 4].map((n) => ({ path: `f${n}`, size: n, colour: n })) }, "html", context);
  expect(html).toContain("2 smaller items not drawn");
});

test("a trend is stable within the tolerance, and from zero any rise is stronger", () => {
  expect(trendOf(10, 11)).toBe("stable");
  expect(trendOf(10, 13)).toBe("stronger");
  expect(trendOf(10, 5)).toBe("weaker");
  expect(trendOf(0, 1)).toBe("stronger");
  expect(trendOf(0, 0)).toBe("stable");
});
