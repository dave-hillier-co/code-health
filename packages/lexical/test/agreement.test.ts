import { expect, test } from "vitest";
import { addAgreement, compareUnits, exactRate, spuriousRate } from "../src/agreement.ts";
import type { UnitShape } from "../src/unit.ts";

const structural = (startLine: number, endLine: number, kind: UnitShape["kind"] = "function"): UnitShape => ({
  qualifiedName: `u${startLine}`,
  kind,
  startLine,
  endLine,
  source: "structural",
});
const block = (startLine: number, endLine: number): UnitShape => ({ startLine, endLine, source: "lexical" });

test("matches by start and end line and excludes structural classes", () => {
  const counts = compareUnits([structural(1, 10, "class"), structural(2, 4), structural(6, 9, "method")], [block(2, 4), block(6, 8)]);
  expect(counts).toEqual({ units: 2, found: 2, exact: 1, blocks: 2, spurious: 0 });
});

test("a block that overlaps no function is spurious, even inside a class", () => {
  const counts = compareUnits([structural(1, 10, "class"), structural(2, 4)], [block(2, 4), block(7, 8)]);
  expect(counts.spurious).toBe(1);
  expect(counts.units).toBe(1);
});

test("rates are fixed to four places and zero for an empty corpus", () => {
  expect(exactRate({ units: 3, found: 3, exact: 1, blocks: 3, spurious: 0 })).toBe(0.3333);
  expect(spuriousRate({ units: 3, found: 3, exact: 1, blocks: 3, spurious: 1 })).toBe(0.3333);
  expect(exactRate({ units: 0, found: 0, exact: 0, blocks: 0, spurious: 0 })).toBe(0);
});

test("counts add across files", () => {
  const one = { units: 1, found: 1, exact: 1, blocks: 1, spurious: 0 };
  expect(addAgreement(one, one)).toEqual({ units: 2, found: 2, exact: 2, blocks: 2, spurious: 0 });
});
