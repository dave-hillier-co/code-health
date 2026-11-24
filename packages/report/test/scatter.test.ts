import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import { quadrantCounts, type ScatterData } from "../src/components/scatter.ts";
import { sampleBlocks } from "./support.ts";

const context = { slots: [], notes: undefined };
const { type: _type, ...sample } = sampleBlocks.scatter as { type: "scatter" } & ScatterData;
const block = (data: ScatterData) => ({ type: "scatter" as const, ...data });

test("the quadrants count every point once, with a point on a guideline on the upper or right side", () => {
  expect(quadrantCounts(sample)).toEqual({ upperRight: 3, upperLeft: 1, lowerRight: 1, lowerLeft: 2 });
});

test("the table lists the named points up to the cap and the legend counts the rest", () => {
  const html = renderBlock(block(sample), "html", context);
  expect(html).toContain("src/core/engine.ts");
  expect(html).not.toContain("<td>src/ui/form.ts</td>");
  expect(html).toContain("The table lists 2 of 3 highlighted files");
  expect(html).toContain("Log scale on Revisions (horizontal) and Complexity (vertical)");
  expect(html).toContain("1 files have a value below 1 on a log axis");
  const md = renderBlock(block(sample), "md", context);
  expect(md).toContain("3 look first");
  expect(md).toContain("| 1 | src/core/engine.ts | 40 | 300 | look first |");
});

test("a scatter with no point prints one notice line", () => {
  expect(renderBlock(block({ ...sample, points: [] }), "md", context)).toContain("no files to draw");
});

test("a name with no free room prints its table number", () => {
  const crowded = { ...sample, maxLabels: 30, points: Array.from({ length: 30 }, (_, i) => ({ label: `src/file-number-${i}.ts`, x: 10 + (i % 3), y: 100 + (i % 2), highlight: true })) };
  expect(renderBlock(block(crowded), "html", context)).toContain("print their table number instead");
});
