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
  expect(html).toContain("<li><strong>ONE</strong> Owned by one person: 2 tiles</li>");
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
