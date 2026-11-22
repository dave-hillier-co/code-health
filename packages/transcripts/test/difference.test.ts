import { describe, expect, it } from "vitest";
import { guidedDifferenceOf, type Arm } from "../src/difference.ts";

const arm = (before: number, after: number, n: number): Arm => ({ before: { mean: before, n }, after: { mean: after, n } });

describe("guidedDifferenceOf", () => {
  it("reports how far past the noise guideline a difference sits", () => {
    const result = guidedDifferenceOf(arm(10, 5, 20), arm(10, 10, 20), 10, 10);
    expect(result.conclusion).toBe("lower");
    expect(result.observed).toBe("lower");
    expect(result.percentOfStart).toBe(50);
    expect(result.ratioToNoiseGuideline).toBe(5);
    expect(result.lowConfidence).toBe(false);
  });

  it("keeps the observed direction visible when the sample is below its floor", () => {
    const result = guidedDifferenceOf(arm(10, 5, 3), arm(10, 10, 3), 10, 10);
    expect(result.conclusion).toBe("insufficient-sample");
    expect(result.observed).toBe("lower");
    expect(result.lowConfidence).toBe(true);
    expect(result.smallestSample).toBe(3);
  });

  it("calls a difference inside the guideline no change and gives its ratio", () => {
    const result = guidedDifferenceOf(arm(10, 10.5, 20), arm(10, 10, 20), 10, 10);
    expect(result.conclusion).toBe("no-change");
    expect(result.ratioToNoiseGuideline).toBe(0.5);
  });

  it("has no direction or ratio when a figure is missing", () => {
    const result = guidedDifferenceOf({ before: { mean: null, n: 0 }, after: { mean: null, n: 0 } }, arm(1, 1, 20), 10, 10);
    expect(result.observed).toBeNull();
    expect(result.ratioToNoiseGuideline).toBeNull();
  });
});
