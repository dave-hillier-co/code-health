import { expect, test } from "vitest";
import { renderBlock } from "../src/block.ts";
import { renderReport } from "../src/render.ts";
import { sampleBlocks, sampleBuild, sampleNotes, sampleReport } from "./support.ts";

const context = { slots: sampleBuild.slots, notes: sampleNotes };

/** The problems a fragment or page has against the report's accessibility rules. */
function problems(html: string): string[] {
  const out: string[] = [];
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    if (!/role="img"/.test(svg)) out.push("an svg has no role=img");
    const labelled = /aria-labelledby="([^"]+)"/.exec(svg)?.[1];
    if (labelled === undefined) out.push("an svg has no aria-labelledby");
    else for (const id of labelled.split(" ")) if (!svg.includes(`id="${id}"`)) out.push(`an svg names ${id}, which it does not hold`);
    if (!/<title id="[^"]+">[^<]+<\/title>/.test(svg)) out.push("an svg has no title");
  }
  for (const figure of html.match(/<figure[\s\S]*?<\/figure>/g) ?? []) {
    if (/<svg/.test(figure) && !/<table/.test(figure)) out.push("a chart has no table of its data");
    if (!/<figcaption>/.test(figure)) out.push("a figure has no figcaption");
  }
  if ((html.match(/<svg/g) ?? []).length !== (html.match(/<figure/g) ?? []).length) out.push("an svg is not inside its own figure");
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    if (!/<caption>[^<]+<\/caption>/.test(table)) out.push("a table has no caption");
    if (/<td/.test(table) && !/<th scope="col"/.test(table)) out.push("a table has no th scope=col");
    for (const th of table.match(/<th(?![a-z])[^>]*>/g) ?? []) if (!/scope="(col|row)"/.test(th)) out.push(`a th has no scope: ${th}`);
  }
  return out;
}

for (const [name, block] of Object.entries(sampleBlocks)) {
  test(`${name} follows the accessibility rules`, () => {
    expect(problems(renderBlock(block, "html", context))).toEqual([]);
  });
}

test("the page is semantic, self-contained and themed", () => {
  const html = renderReport(sampleReport(), "html", sampleNotes);
  expect(problems(html)).toEqual([]);
  for (const tag of ["<header>", "<nav aria-label=", "<main", "<footer>", '<html lang="en">', "<title>"]) expect(html).toContain(tag);
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("@media print");
  expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|src=|href="https?:|xmlns/);
  expect(html).not.toContain("http://");
  // Every section is in the nav, and the limits come last.
  for (const id of ["overview", "charts", "limits"]) expect(html).toContain(`href="#${id}"`);
});

test("ids on a page are unique", () => {
  const html = renderReport(sampleReport(), "html", sampleNotes);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every link to a place on the page has a target on the page", () => {
  const html = renderReport(sampleReport(), "html", sampleNotes);
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of html.matchAll(/ href="#([^"]+)"/g)) expect(ids.has(target!), target).toBe(true);
});

test("a marked value carries words as well as the triangle", () => {
  const html = renderBlock(sampleBlocks["ranked-table"]!, "html", context);
  expect(html).toContain("above guideline");
  expect(html).toContain("below guideline");
});
