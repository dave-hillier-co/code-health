import { round4 } from "./current.ts";
import type { Distribution } from "./simulate.ts";

/** One distribution as reported: the loss, its share of the whole, and knowledge at risk at each alpha. */
export interface ReportedDistribution {
  expected: number;
  expectedShare: number;
  atRisk: { alpha: number; kar: number; karShare: number; tailRatio: number | null; expectedTailLoss: number }[];
}

const share = (value: number, whole: number): number => (whole === 0 ? 0 : round4(value / whole));

/**
 * A simulated loss, in lines or in files, shown both ways the spec asks for. The increment is
 * the loss over what is already abandoned, the only part that can still be prevented. The total
 * adds the baseline back, and its tail ratio is over the total.
 */
export interface ReportedLoss {
  /** Abandoned before any scenario. */
  baseline: number;
  /** Everything that holds the measure: all lines held by people, or all files with such lines. */
  population: number;
  increment: ReportedDistribution;
  total: ReportedDistribution;
}

export function reportLoss(distribution: Distribution, baseline: number, population: number): ReportedLoss {
  const shifted = (by: number): ReportedDistribution => {
    const expected = distribution.expected + by;
    return {
      expected: round4(expected),
      expectedShare: share(expected, population),
      atRisk: distribution.atRisk.map((a) => ({
        alpha: a.alpha,
        kar: round4(a.kar + by),
        karShare: share(a.kar + by, population),
        // The tail ratio of the total is over the total expected loss, so a baseline dilutes it.
        tailRatio: expected === 0 ? null : round4((a.kar + by) / expected),
        expectedTailLoss: round4(a.expectedTailLoss + by),
      })),
    };
  };
  return { baseline, population, increment: shifted(0), total: shifted(baseline) };
}
