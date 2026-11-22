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
 * The difference between two groups' changes, not the raw before and after, because both drift. `minSamples`
 * is a floor below which the statistic is meaningless, so nothing is concluded from fewer in any of the four
 * figures. `noisePercent` is a guideline: a difference within it of the acted-on files' own starting figure
 * is called no change.
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

/** A difference with the figures that place it against the guidelines, so a reader can see how near a verdict it sits. */
export interface GuidedDifference extends Difference {
  /** The direction the figures show on their own, whatever the sample size. Null when there is nothing to compare. */
  observed: "lower" | "higher" | "no-change" | null;
  /** The acted-on files' own starting figure, the base the noise guideline is a percentage of. */
  startingMean: number | null;
  /** The size of the difference as a percent of that starting figure. Null when there is no base. */
  percentOfStart: number | null;
  /** The noise guideline, percent. A difference at or inside it is reported as `no-change`. */
  noiseGuidelinePercent: number;
  /** `percentOfStart` divided by the noise guideline: above 1 is past the guideline. Null when either is missing or zero. */
  ratioToNoiseGuideline: number | null;
  /** The sample floor. Below it the conclusion is `insufficient-sample` and `observed` is low confidence. */
  minSamples: number;
  lowConfidence: boolean;
}

/**
 * `differenceOf` with the measured values left in view: the direction the figures show, how far past the noise
 * guideline the difference sits, and whether the sample is below its floor. The conclusion is unchanged.
 */
export function guidedDifferenceOf(actedOn: Arm, comparison: Arm, minSamples: number, noisePercent: number): GuidedDifference {
  const base = differenceOf(actedOn, comparison, minSamples, noisePercent);
  const startingMean = actedOn.before.mean;
  const start = Math.abs(startingMean ?? 0);
  let observed: GuidedDifference["observed"] = null;
  if (base.difference !== null) {
    observed = Math.abs(base.difference) <= (start * noisePercent) / 100 ? "no-change" : base.difference < 0 ? "lower" : "higher";
  }
  const percentOfStart = base.difference === null || start === 0 ? null : (100 * Math.abs(base.difference)) / start;
  return {
    ...base,
    observed,
    startingMean,
    percentOfStart,
    noiseGuidelinePercent: noisePercent,
    ratioToNoiseGuideline: percentOfStart === null || noisePercent === 0 ? null : percentOfStart / noisePercent,
    minSamples,
    lowConfidence: base.smallestSample < minSamples,
  };
}
