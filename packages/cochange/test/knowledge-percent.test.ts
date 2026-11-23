import { expect, test } from "vitest";
import { percentOfCounts } from "../src/reports/knowledge.ts";

test("a percentage is computed from the two counts printed beside it, not from a share already rounded to four places", () => {
  // 19589 / 412761 is 4.746%; the share 0.0475 rounded first would print 4.8.
  expect(percentOfCounts(19589, 412761)).toBe(4.7);
  expect(percentOfCounts(106, 1576)).toBe(6.7);
  expect(percentOfCounts(0, 0)).toBe(0);
});
