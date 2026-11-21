import { expect, test } from "vitest";
import { bandAgainst, bandCount, cutoffsOf, nearestRank, type Band } from "../src/risk/bands.ts";
import { baselineScores, impactOf, impactScore, makeBander } from "../src/risk/scoring.ts";
import type { Measurement } from "../src/risk/measure.ts";
import { riskDefaults } from "../src/risk/settings.ts";
import type { RiskSettings } from "../src/risk/settings.ts";

/** A small deterministic generator, so a failing population can be replayed. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function population(seed: number, size: number, distinct: number, zeroShare: number): number[] {
  const next = lcg(seed);
  return Array.from({ length: size }, () => (next() < zeroShare ? 0 : Math.floor(next() * distinct)));
}

const bandsOf = (values: number[], moderate = 75, high = 90): Band[] => {
  const cutoffs = cutoffsOf(values, moderate, high)!;
  return values.map((v) => bandAgainst(v, cutoffs));
};

test("no more than a quarter of a population is moderate or above, and no more than a tenth is high, whatever ties", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const size = 1 + (seed * 7) % 83;
    const values = population(seed, size, 1 + (seed % 9), (seed % 5) / 5);
    const bands = bandsOf(values);
    const atLeastModerate = bands.filter((b) => b !== "low").length;
    const high = bands.filter((b) => b === "high").length;
    expect(atLeastModerate, `seed ${seed}: ${values.join(",")}`).toBeLessThanOrEqual(Math.floor(size / 4));
    expect(high, `seed ${seed}: ${values.join(",")}`).toBeLessThanOrEqual(Math.floor(size / 10));
  }
});

test("a zero value is always low, even when the population is almost all zeros", () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
  const cutoffs = cutoffsOf(values, 75, 90)!;
  expect(bandAgainst(0, cutoffs)).toBe("low");
  // The cutoffs are 0, so without the rule every non-zero value would be marked: only the 5 is above.
  expect(bandsOf(values).filter((b) => b !== "low")).toHaveLength(1);
  const allZero = cutoffsOf([0, 0, 0, 0], 75, 90)!;
  expect(bandAgainst(0, allZero)).toBe("low");
  expect(bandAgainst(1, allZero)).toBe("high");
});

test("the comparison is strict: a value equal to the cutoff is not above it", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const cutoffs = cutoffsOf(values, 75, 90)!;
  expect(cutoffs).toEqual({ moderate: 8, high: 9, population: 10 });
  expect(bandAgainst(8, cutoffs)).toBe("low");
  expect(bandAgainst(9, cutoffs)).toBe("moderate");
  expect(bandAgainst(10, cutoffs)).toBe("high");
});

test("nearest rank takes the smallest value that the percentile of the population is at or below", () => {
  expect(nearestRank([], 75)).toBeNull();
  expect(nearestRank([7], 90)).toBe(7);
  expect(nearestRank([4, 1, 3, 2], 50)).toBe(2);
  expect(nearestRank([4, 1, 3, 2], 75)).toBe(3);
  expect(nearestRank([4, 1, 3, 2], 100)).toBe(4);
});

test("a count is banded on fixed thresholds, not on a distribution", () => {
  const thresholds = { moderate: 1, high: 3 };
  expect([0, 1, 2, 3, 9].map((n) => bandCount(n, thresholds))).toEqual(["low", "moderate", "moderate", "high", "high"]);
});

const settings = { ...riskDefaults, fixPatterns: [], revertPatterns: [], disabled: new Set<string>(), minBaseline: 10 } as unknown as RiskSettings;

function measured(name: string, family: Measurement["family"], value: number): Measurement {
  return { name, family, layer: "history", kind: "percentile", unavailable: null, series: { value }, value: { value }, evidence: [], source: "history" };
}

test("each family counts once, at the band of its highest factor", () => {
  const factors = [
    { name: "size", family: "size-and-diffusion", band: "high" as const },
    { name: "spread", family: "size-and-diffusion", band: "high" as const },
    { name: "entropy", family: "size-and-diffusion", band: "moderate" as const },
    { name: "contention", family: "history", band: "moderate" as const },
    { name: "age", family: "history", band: "low" as const },
  ];
  // Three correlated size and diffusion factors count as one fact: 2 for the family, 1 for history.
  expect(impactScore(factors)).toBe(3);
});

test("an unavailable factor adds nothing, and a disabled one is left out", () => {
  expect(impactScore([{ name: "defect-history", family: "history", band: "unavailable" }])).toBe(0);
  expect(impactScore([{ name: "size", family: "size-and-diffusion", band: "high", disabled: true }])).toBe(0);
});

test("factors that are events do not also count in the score", () => {
  expect(impactScore([{ name: "sensitive-paths", family: "structure-and-content", band: "high" }])).toBe(0);
});

test("a value above zero cannot be placed against a baseline that is too small, and is unavailable rather than low", () => {
  const bander = makeBander([[measured("size", "size-and-diffusion", 3)]], settings);
  expect(bander(measured("size", "size-and-diffusion", 50)).band).toBe("unavailable");
  expect(bander(measured("size", "size-and-diffusion", 0)).band).toBe("low");
});

test("a factor is placed against the population measured the same way", () => {
  const baseline = Array.from({ length: 20 }, (_, i) => [measured("size", "size-and-diffusion", i + 1)]);
  const bander = makeBander(baseline, settings);
  // Nearest rank: the 75th percentile of 1..20 is 15 and the 90th is 18.
  expect(bander(measured("size", "size-and-diffusion", 15)).band).toBe("low");
  expect(bander(measured("size", "size-and-diffusion", 16)).band).toBe("moderate");
  expect(bander(measured("size", "size-and-diffusion", 19)).band).toBe("high");
  expect(bander(measured("size", "size-and-diffusion", 16)).thresholds).toEqual({ value: { moderate: 15, high: 18 } });
});

test("a two-sided factor takes the higher of its sides", () => {
  const two = (stale: number, settling: number): Measurement => ({
    ...measured("age", "history", 0),
    series: { stale, settling },
    value: { stale, settling },
  });
  const baseline = Array.from({ length: 20 }, (_, i) => [two(i / 20, 0)]);
  const bander = makeBander(baseline, settings);
  // Settling is zero everywhere in the baseline, so any settling file is above it. Stale alone is ordinary.
  expect(bander(two(0.1, 0)).band).toBe("low");
  expect(bander(two(0.1, 0.2)).band).toBe("high");
  expect(bander(two(0.99, 0)).band).toBe("high");
});

test("impact is banded against the baseline's own scores, so most changes are not at the top", () => {
  const baseline = Array.from({ length: 40 }, (_, i) => [measured("size", "size-and-diffusion", i)]);
  const scores = baselineScores(baseline, settings);
  expect(scores).toHaveLength(40);
  const bandedScores = scores.map((score) => impactOf([{ name: "size", family: "size-and-diffusion", band: score >= 2 ? "high" : score === 1 ? "moderate" : "low" }], scores, [], settings).scoreBand);
  expect(bandedScores.filter((b) => b === "high").length).toBeLessThanOrEqual(4);
  expect(bandedScores.filter((b) => b !== "low").length).toBeLessThanOrEqual(10);
});

test("events raise the impact band by one step, once, and not beyond high", () => {
  const scores = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4];
  const factors = [{ name: "size", family: "size-and-diffusion", band: "low" as const }];
  const none = impactOf(factors, scores, [], settings);
  expect(none.scoreBand).toBe("low");
  expect(impactOf(factors, scores, ["sensitive-paths"], settings).band).toBe("moderate");
  expect(impactOf(factors, scores, ["sensitive-paths", "missing-co-change", "structure-delta"], settings).band).toBe("moderate");
  const high = [{ name: "size", family: "size-and-diffusion", band: "high" as const }, { name: "age", family: "history", band: "high" as const }];
  expect(impactOf(high, scores, ["structure-delta"], settings).scoreBand).toBe("high");
  expect(impactOf(high, scores, ["structure-delta"], settings).band).toBe("high");
});

test("with too few changes to compare, the impact band is unavailable unless the score is zero", () => {
  const few = [0, 1, 2];
  expect(impactOf([], few, [], settings).band).toBe("low");
  expect(impactOf([{ name: "size", family: "size-and-diffusion", band: "high" }], few, ["sensitive-paths"], settings).band).toBe("unavailable");
});
