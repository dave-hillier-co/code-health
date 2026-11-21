/** What one measure shows once the comparison group has been set beside the acted-on files. */
export type Conclusion = "lower" | "higher" | "no-change" | "insufficient-sample" | "not-measured";

export interface Arm {
  /** The figure before and after, and the sample each rests on. */
  before: { mean: number | null; n: number };
  after: { mean: number | null; n: number };
}

export interface Difference {
  actedOn: { change: number | null };
  comparison: { change: number | null };
  /** The acted-on change minus the comparison change. Negative: the acted-on files improved more. */
  difference: number | null;
  /** The smallest samples among the four figures. */
  smallestSample: number;
  conclusion: Conclusion;
}

const change = (arm: Arm): number | null => (arm.before.mean === null || arm.after.mean === null ? null : arm.after.mean - arm.before.mean);

/**
 * The difference between two groups' changes, not the raw before and after, because both drift. Nothing is
 * concluded from fewer than `minSamples` in any of the four figures, nor from a difference within `noisePercent`
 * of the acted-on files' own starting figure.
 */
export function differenceOf(actedOn: Arm, comparison: Arm, minSamples: number, noisePercent: number): Difference {
  const actedChange = change(actedOn);
  const comparisonChange = change(comparison);
  const smallestSample = Math.min(actedOn.before.n, actedOn.after.n, comparison.before.n, comparison.after.n);
  const difference = actedChange === null || comparisonChange === null ? null : actedChange - comparisonChange;
  let conclusion: Conclusion;
  if (difference === null) conclusion = "not-measured";
  else if (smallestSample < minSamples) conclusion = "insufficient-sample";
  else {
    const noise = (Math.abs(actedOn.before.mean ?? 0) * noisePercent) / 100;
    conclusion = Math.abs(difference) <= noise ? "no-change" : difference < 0 ? "lower" : "higher";
  }
  return { actedOn: { change: actedChange }, comparison: { change: comparisonChange }, difference, smallestSample, conclusion };
}
