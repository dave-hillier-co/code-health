import { expect, test } from "vitest";
import { evidenceListHtml, evidenceListMd } from "../src/components/evidence-list.ts";

test("an empty evidence list prints its own emptyText, and None. when it has none", () => {
  const data = { title: "Evidence for a finding", items: [] };
  expect(evidenceListMd(data)).toContain("None.");
  expect(evidenceListHtml(data)).toContain("None.");
  const worded = { ...data, emptyText: "The finding has no evidence item to list." };
  expect(evidenceListMd(worded)).toContain("The finding has no evidence item to list.");
  expect(evidenceListMd(worded)).not.toContain("None.");
  expect(evidenceListHtml(worded)).toContain("The finding has no evidence item to list.");
});
