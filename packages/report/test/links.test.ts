import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import type { Block } from "../src/block.ts";
import { pageHref, reportHref, resolveLinks } from "../src/links.ts";
import { renderReport } from "../src/render.ts";
import type { Report } from "../src/report-model.ts";
import { targetId } from "../src/text.ts";
import { sampleBlocks, sampleBuild, sampleNotes, sampleReport } from "./support.ts";

const hrefs = (html: string) => [...html.matchAll(/ href="([^"]+)"/g)].map((m) => m[1]!);
const ids = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));

/** The sample blocks that draw named things, each with links on its items. */
const linkedBlocks: Record<string, Block> = {
  "ranked-table": { ...(sampleBlocks["ranked-table"] as Extract<Block, { type: "ranked-table" }>), rowIds: ["row-a", null, "row-d"], cellHrefs: [{ path: "#row-d" }, {}, { path: "report:hotspots#friction" }], seeAlso: [{ href: reportHref("structure"), text: "The structure report." }] },
  treemap: { type: "treemap", title: "Files", sizeLabel: "lines", colourLabel: "revisions", items: [{ path: "src/a.ts", size: 100, colour: 3, mark: "1", href: "#row-a" }, { path: "src/b.ts", size: 50, colour: 1 }] },
  "category-treemap": { type: "category-treemap", title: "Kinds", sizeLabel: "lines", categoryLabel: "Pattern", categories: [{ id: "x", label: "Single owner", mark: "S", band: 1 }], items: [{ path: "src/a.ts", size: 100, category: "x", href: "#row-a" }, { path: "src/b.ts", size: 30, category: null }] },
  matrix: { type: "matrix", title: "Pairs", valueLabel: "degree", rows: ["a.ts", "b.ts"], columns: ["a.ts", "b.ts"], cells: [[null, 5], [5, null]], rowHrefs: ["#row-a", null], columnHrefs: ["#row-a", null], groups: [{ label: "cluster 1", start: 0, end: 1, href: "#row-a" }] },
  scatter: { ...(sampleBlocks.scatter as Extract<Block, { type: "scatter" }>), points: [{ label: "src/core/engine.ts", short: "engine.ts", x: 40, y: 300, highlight: true, href: "#row-a" }, { label: "src/ui/page.ts", x: 12, y: 90, highlight: true }] },
  "function-bars": { ...(sampleBlocks["function-bars"] as Extract<Block, { type: "function-bars" }>), bars: [{ label: "parse", value: 30, revisions: 12, fixes: 4, href: "#row-a" }, { label: "format", value: 10, revisions: 3, fixes: 0 }] },
  "move-map": { ...(sampleBlocks["move-map"] as Extract<Block, { type: "move-map" }>), edges: [{ label: "1", from: "src/a/util", to: "src/a", kind: "move", value: 12, href: "#row-a" }, { label: "B1", from: "src/b/web", to: "src/b/core", kind: "blocked", value: 6, href: "report:locality" }], marks: [{ folder: "docs", label: "R1", kind: "review", href: "#row-a" }] },
  "evidence-list": { type: "evidence-list", title: "Commits", items: [{ id: "abc1234", text: "Fix the parser", href: "#row-a" }, { id: "def5678", text: "Fix again" }] },
};

const context = { slots: sampleBuild.slots, notes: sampleNotes };

for (const [name, block] of Object.entries(linkedBlocks)) {
  test(`${name} links its named items in html and prints markdown plain`, () => {
    const html = renderBlock(block, "html", context);
    expect(hrefs(html).filter((h) => h.startsWith("#row-")).length).toBeGreaterThan(0);
    const md = renderBlock(block, "md", context);
    expect(md).not.toContain("href");
    expect(md).not.toContain("](#");
  });
}

test("a link to another report page is kept only when that page is a sibling", () => {
  const block = linkedBlocks["ranked-table"]!;
  const alone = renderBlock(block, "html", context);
  expect(alone).not.toContain("hotspots.html");
  expect(alone).not.toContain("structure.html");
  expect(alone).not.toContain("The structure report.");
  const beside = renderBlock(block, "html", { ...context, siblings: new Map([["hotspots", "Hotspots"], ["structure", "Structure report"]]) });
  expect(beside).toContain('href="hotspots.html#friction"');
  expect(beside).toContain('<a href="structure.html">The structure report.</a>');
});

test("a link that names the page title is kept only when the sibling has that title", () => {
  const ref = reportHref("xray", { title: "X-Ray of src/a.ts" });
  expect(resolveLinks({ href: ref }, new Map([["xray", "X-Ray of src/a.ts"]]))).toEqual({ href: "xray.html" });
  expect(resolveLinks({ href: ref }, new Map([["xray", "X-Ray of src/b.ts"]]))).toEqual({});
  expect(resolveLinks({ href: ref }, undefined)).toEqual({});
});

test("a list of links keeps its positions when a link is dropped", () => {
  const resolved = resolveLinks({ rowHrefs: ["#a", "report:coupling", null, "report:hotspots#x"] }, new Map([["hotspots", "Hotspots"]]));
  expect(resolved).toEqual({ rowHrefs: ["#a", null, null, "hotspots.html#x"] });
});

test("the text of a block is never read as a link", () => {
  expect(resolveLinks({ title: "report:coupling", label: "#x" }, undefined)).toEqual({ title: "report:coupling", label: "#x" });
});

test("a target id is stable, and differs for subjects that share a name or a slug", () => {
  expect(targetId("friction", "src/a/util.ts")).toBe(targetId("friction", "src/a/util.ts"));
  expect(targetId("friction", "src/a/util.ts")).not.toBe(targetId("friction", "src/b/util.ts"));
  expect(targetId("friction", "a-b.ts")).not.toBe(targetId("friction", "a/b.ts"));
  expect(targetId("friction", "src/a.ts")).not.toBe(targetId("history", "src/a.ts"));
});

test("every link on a page that points at the page has a target, and every id is unique", () => {
  const report: Report = { ...sampleReport(), sections: [{ id: "linked", heading: "Linked", blocks: Object.values(linkedBlocks) }, ...sampleBuild.sections.slice(0, 1)] };
  const html = renderReport(report, "html", sampleNotes);
  const found = ids(html);
  const own = hrefs(html).filter((h) => h.startsWith("#"));
  expect(own.length).toBeGreaterThan(0);
  for (const href of own) expect(found.has(href.slice(1)), href).toBe(true);
  const all = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
  expect(new Set(all).size).toBe(all.length);
  expect(hrefs(html).some((h) => h.endsWith(".html"))).toBe(false);
});

test("a judgement section has an id a link can point at", () => {
  const html = renderBlock(sampleBlocks.judgement!, "html", context);
  expect(html).toMatch(/<section class="judgement" id="judgement-look-[0-9a-f]{6}">/);
  expect(pageHref("x")).toBe("#x");
});
