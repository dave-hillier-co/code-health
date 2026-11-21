/**
 * Rank percentile of each value within its population, as a mid-rank:
 * `(values below + half the values equal) / n`. Ties share a percentile, the
 * result stays strictly between 0 and 1, and one outlier cannot stretch the
 * others. Returned in the order of the input.
 */
export function midRankPercentiles(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const first = new Map<number, number>();
  const count = new Map<number, number>();
  sorted.forEach((value, index) => {
    if (!first.has(value)) first.set(value, index);
    count.set(value, (count.get(value) ?? 0) + 1);
  });
  return values.map((value) => (first.get(value)! + count.get(value)! / 2) / values.length);
}

/** The share of `values` that are strictly greater than `value`. */
export function shareStrictlyAbove(values: readonly number[], value: number): number {
  return values.filter((other) => other > value).length / values.length;
}
