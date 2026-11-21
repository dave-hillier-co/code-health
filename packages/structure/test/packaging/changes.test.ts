import { expect, test } from "vitest";
import { independenceTail, measurePackages, type PackageChange } from "../../src/packaging/changes.ts";

test("the exact tail matches the hypergeometric probabilities worked out by hand", () => {
  // 10 changes, each package in 5 of them: all 5 shared has probability 1 / C(10,5)
  expect(independenceTail(5, 5, 5, 10)).toBeCloseTo(1 / 252, 10);
  // at least 4 shared: (C(5,4)*C(5,1) + C(5,5)*C(5,0)) / C(10,5) = 26 / 252
  expect(independenceTail(4, 5, 5, 10)).toBeCloseTo(26 / 252, 10);
  expect(independenceTail(0, 5, 5, 10)).toBe(1);
  expect(independenceTail(6, 5, 5, 10)).toBe(0);
});

test("counts frequency, eligible changes, sole changes and shared changes", () => {
  const change = (id: string, touched: string[], oversized = false): PackageChange => ({ id, date: 0, oversized, authors: [], touched, files: [] });
  const activity = measurePackages([
    change("1", ["a"]),
    change("2", ["a", "b"]),
    change("3", ["a", "b", "c"]),
    change("4", ["a", "b", "c"], true),
  ]);
  expect(activity.eligibleChanges).toBe(3);
  expect(activity.revisions("a")).toBe(4);
  expect(activity.eligible("a")).toBe(3);
  expect(activity.alone("a")).toBe(1);
  expect(activity.crossing("a")).toBe(2);
  expect(activity.shared("b", "a")).toBe(2);
  expect(activity.touchingAtLeast(3)).toBe(1);
  expect([...activity.partners("c")]).toEqual([["a", 1], ["b", 1]]);
});
