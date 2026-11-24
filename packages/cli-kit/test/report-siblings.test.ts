import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readSiblings } from "../src/report-siblings.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const page = (title: string, commit: string) => `<html><head><title>${title}</title></head><body><footer><p>Report <code>x</code> for commit <code>${commit.slice(0, 12)}</code>.</p></footer></body></html>`;

test("the siblings are the suite's pages in the folder of --out that were written for the same commit", () => {
  const folder = mkdtempSync(join(tmpdir(), "siblings-"));
  writeFileSync(join(folder, "hotspots.html"), page("Hotspots", COMMIT));
  writeFileSync(join(folder, "xray.html"), page("X-Ray of src/a&amp;b.ts", COMMIT));
  writeFileSync(join(folder, "coupling.html"), page("Coupling report", "ffffffffffff0000"));
  writeFileSync(join(folder, "notes.html"), page("Other", COMMIT));
  writeFileSync(join(folder, "overview.html"), page("Overview", COMMIT));
  const found = readSiblings(join(folder, "overview.html"), "overview", COMMIT);
  expect([...found]).toEqual([["hotspots", "Hotspots"], ["xray", "X-Ray of src/a&b.ts"]]);
});

test("a page printed to the terminal has no siblings", () => {
  expect(readSiblings(undefined, "overview", COMMIT).size).toBe(0);
});
