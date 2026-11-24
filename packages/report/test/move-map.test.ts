import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import { treeRows } from "../src/components/move-map.ts";
import { sampleBlocks, sampleBuild } from "./support.ts";

const context = { slots: sampleBuild.slots, notes: undefined };

test("a folder with nothing of its own and one child joins its child's row", () => {
  const rows = treeRows(["src/a/util", "src/a/web", "src/b/deep/er"], "root");
  expect(rows.map((r) => [r.depth, r.label])).toEqual([
    [0, "src"],
    [1, "a"],
    [2, "util"],
    [2, "web"],
    [1, "b/deep/er"],
  ]);
});

test("the root folder is a row when it is listed, and the others sit under it", () => {
  const rows = treeRows(["", "docs"], "the repository root (/)");
  expect(rows.map((r) => [r.depth, r.label, r.path])).toEqual([
    [0, "the repository root (/)", ""],
    [1, "docs", "docs"],
  ]);
});

test("the figure names every kind in words, marks the dashed kind and lists each arrow in the table", () => {
  const html = renderBlock(sampleBlocks["move-map"]!, "html", context);
  expect(html).toContain('class="edge move solid"');
  expect(html).toContain('class="edge blocked dashed"');
  expect(html).toContain("blocked move (dashed line)");
  expect(html).toContain("blocked move B1 out: gain if unblocked 6, blocked by src/b/web/x.ts");
  expect(html).toContain("<td>src/b/web/y.ts</td>");
  expect(html).toContain("3 more moves are not drawn");
  expect(html).not.toContain("<script");
});

test("the folders of an arrow get rows even when the folder list does not name them", () => {
  const block = sampleBlocks["move-map"]!;
  const data = { ...block, edges: [{ label: "9", from: "nowhere", to: "src/a", kind: "move", value: 1 }] };
  const html = renderBlock(data, "html", context);
  expect(html).toContain('class="edge move solid"');
  expect(html).toContain(">nowhere</text>");
});

test("markdown prints the table and the legend lines", () => {
  const md = renderBlock(sampleBlocks["move-map"]!, "md", context);
  expect(md).toContain("| 1 | src/a/util/x.ts |");
  expect(md).toContain("- blocked move (dashed line):");
});
