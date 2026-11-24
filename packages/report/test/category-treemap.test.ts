import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import type { Block } from "../src/block.ts";
import { expectGoldenText } from "./support.ts";

const block: Block = {
  type: "category-treemap",
  title: "Files by lines, marked by kind",
  sizeLabel: "lines",
  categoryLabel: "Kind",
  categories: [
    { id: "owned", label: "Owned by one person", mark: "ONE", band: 5 },
    { id: "shared", label: "Shared", mark: "MANY", band: 2 },
    { id: "unknown", label: "Unknown", mark: "UNK", band: 1 },
  ],
  items: [
    { path: "src/core/engine.ts", size: 400, category: "owned" },
    { path: "src/core/util.ts", size: 120, category: "shared" },
    { path: "src/ui/page.ts", size: 200, category: "owned" },
    { path: "src/ui/form.ts", size: 90, category: null },
    { path: "docs/a|b.md", size: 60, category: "unknown" },
    { path: "empty.txt", size: 0, category: "shared" },
  ],
  maxTiles: 5,
};
const context = { slots: [], notes: undefined };

test("a category treemap renders to the golden html and markdown", () => {
  expectGoldenText("components/category-treemap.html", `${renderBlock(block, "html", context)}\n`);
  expectGoldenText("components/category-treemap.md", `${renderBlock(block, "md", context)}\n`);
});

test("every tile names its kind in words and in a mark, and an item with no kind is hatched and says none", () => {
  const html = renderBlock(block, "html", context);
  expect(html).toContain("<title>src/core/engine.ts: 400 lines, Kind Owned by one person</title>");
  expect(html).toContain("ONE");
  expect(html).toContain("<title>src/ui/form.ts: 90 lines, no Kind</title>");
  expect(html).toContain('class="tile band-none"');
  expect(html).toContain("<li><strong>ONE</strong> Owned by one person: 2 tiles, 600 lines</li>");
});

test("the table lists the same items, and the items it does not draw are counted", () => {
  const html = renderBlock(block, "html", context);
  expect(html).toContain("<caption>Files by lines, marked by kind: the items drawn, largest first</caption>");
  expect(html).toContain('<th scope="col">Kind</th>');
  expect(html).toContain("1 item of no size not drawn.");
  const md = renderBlock(block, "md", context);
  expect(md).toContain("| docs/a\\|b.md | 60 | Unknown |");
  expect(md).toContain("1 item of no size not drawn.");
});

test("the chart is an accessible figure: role, title, description and a table", () => {
  const html = renderBlock(block, "html", context);
  expect(html).toMatch(/<svg role="img" aria-labelledby="([^"]+)-title \1-desc"/);
  expect(html).toContain("<figcaption>Files by lines, marked by kind</figcaption>");
  expect(html).toContain("<table");
  expect(html).not.toMatch(/<script|<image|href=|url\(/);
});

test("tiles beyond the limit are counted and not drawn", () => {
  const many: Block = { ...block, maxTiles: 2 } as Block;
  const html = renderBlock(many, "html", context);
  expect(html).toContain("3 smaller items not drawn");
  expect((html.match(/<g class="tile/g) ?? []).length).toBe(2);
});

test("a treemap and a category treemap of one item set put every tile in the same place", () => {
  const paths = Array.from({ length: 60 }, (_, i) => `src/m${i % 7}/f${i}.ts`);
  const tree = { type: "treemap" as const, title: "t", sizeLabel: "lines", colourLabel: "revisions", items: paths.map((path, i) => ({ path, size: 10 + ((i * 37) % 90), colour: i % 5 })) };
  const cat = { type: "category-treemap" as const, title: "t", sizeLabel: "lines", categoryLabel: "Kind", categories: [{ id: "a", label: "A", mark: "A", band: 2 }], items: tree.items.map((i) => ({ path: i.path, size: i.size, category: "a" })) };
  const geometry = (html: string) => [...html.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)].map((m) => m.slice(1).join(","));
  const a = geometry(renderBlock(tree, "html", context));
  expect(a.length).toBeGreaterThan(60);
  expect(a).toEqual(geometry(renderBlock(cat, "html", context)));
});

test("a large map draws every item, bare when small, and says how many bare tiles it holds and how many table rows it omits", () => {
  const items = Array.from({ length: 3000 }, (_, i) => ({ path: `d${i % 40}/e${i % 9}/f${i}.ts`, size: 1 + (i % 17), colour: i % 4 }));
  const html = renderBlock({ type: "treemap", title: "t", sizeLabel: "lines", colourLabel: "revisions", items, tableRows: 10 }, "html", context);
  expect(html).toContain('class="tile bare band-');
  expect(html).toMatch(/\d+ tiles holding [\d,]+ lines too small for a name or tooltip are drawn as bare rectangles/);
  expect(html).toContain("the table lists 10 of the 3000 items drawn");
  expect((html.match(/<tr>/g) ?? []).length).toBe(11);
});

test("a marked tile is outlined and prints its mark, and its row comes first in the table", () => {
  const html = renderBlock({ type: "treemap", title: "t", sizeLabel: "lines", colourLabel: "revisions", items: [{ path: "a/big.ts", size: 500, colour: 1 }, { path: "a/small.ts", size: 3, colour: 9, mark: "1" }], markLabel: "the friction list" }, "html", context);
  expect(html).toContain(" marked");
  expect(html).toContain("Outlined tiles are the friction list (1)");
  expect(html.indexOf("1 a/small.ts")).toBeLessThan(html.indexOf("a/big.ts</th>"));
});
