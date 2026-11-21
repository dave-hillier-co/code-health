import { describe, expect, test } from "vitest";
import { coChangePValue } from "../src/significance.ts";

describe("coChangePValue", () => {
  test("is the chance, by the hypergeometric tail, of at least that many shared changes if the two sides changed independently", () => {
    // 10 changes, each side in 3 of them: all three coinciding is 1 way in C(10,3) = 120
    expect(coChangePValue({ shared: 3, a: 3, b: 3, total: 10 })).toBeCloseTo(1 / 120, 12);
    // two or more: P(2) + P(3) = C(3,2)C(7,1)/120 + 1/120 = 22/120
    expect(coChangePValue({ shared: 2, a: 3, b: 3, total: 10 })).toBeCloseTo(22 / 120, 12);
  });

  test("a single shared change is not unusual when the sides are busy, and is when they are rare", () => {
    // 4 and 4 of 8: sharing none is 1 way in C(8,4) = 70, so sharing at least one is 69 in 70
    expect(coChangePValue({ shared: 1, a: 4, b: 4, total: 8 })).toBeCloseTo(69 / 70, 12);
    // 5 and 5 of 8: the sides must overlap in at least two, so one shared change is certain
    expect(coChangePValue({ shared: 2, a: 5, b: 5, total: 8 })).toBeCloseTo(1, 12);
    // 1 and 1 of 1000: one shared change is one way in a thousand
    expect(coChangePValue({ shared: 1, a: 1, b: 1, total: 1000 })).toBeCloseTo(0.001, 12);
  });

  test("no shared change is certain, and more than the sides allow is impossible", () => {
    expect(coChangePValue({ shared: 0, a: 2, b: 5, total: 20 })).toBe(1);
    expect(coChangePValue({ shared: 4, a: 3, b: 9, total: 20 })).toBe(0);
  });

  test("holds up on a long history", () => {
    const p = coChangePValue({ shared: 40, a: 50, b: 60, total: 100_000 });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-50);
  });
});
