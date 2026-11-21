import { expect, test } from "vitest";
import { midRankPercentiles, shareStrictlyAbove } from "../src/ranking.ts";

test("percentiles are mid-ranks within the population, so ties share a value", () => {
  expect(midRankPercentiles([10, 20, 30, 40])).toEqual([0.125, 0.375, 0.625, 0.875]);
  expect(midRankPercentiles([5, 5, 9])).toEqual([1 / 3, 1 / 3, 5 / 6]);
});

test("a lone value sits in the middle and an outlier does not stretch the others", () => {
  expect(midRankPercentiles([7])).toEqual([0.5]);
  expect(midRankPercentiles([1, 2, 1_000_000])).toEqual([1 / 6, 0.5, 5 / 6]);
});

test("an empty population has no percentiles", () => {
  expect(midRankPercentiles([])).toEqual([]);
});

test("the share strictly above counts how many values beat one", () => {
  expect(shareStrictlyAbove([3, 1, 2, 3], 3)).toBe(0);
  expect(shareStrictlyAbove([3, 1, 2, 3], 2)).toBe(0.5);
  expect(shareStrictlyAbove([3, 1, 2, 3], 1)).toBe(0.75);
});
