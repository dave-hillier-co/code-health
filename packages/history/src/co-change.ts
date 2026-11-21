/**
 * The suite's symmetric co-change strength between two files, as a percentage:
 * n(A and B) / ((n(A) + n(B)) / 2), over the same population of logical changes. Unrounded,
 * and zero when neither file changed.
 */
export function coChangeDegree(support: number, changesA: number, changesB: number): number {
  return changesA + changesB === 0 ? 0 : (200 * support) / (changesA + changesB);
}
