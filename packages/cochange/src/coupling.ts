/**
 * Temporal coupling counts. Every count is over the same population: eligible
 * logical changes, those at or below the maximum changeset size. Oversized
 * changes are left out of the pair counts and of both denominators.
 */

export interface CouplingChange {
  /** Files in the change, as stable identities. Duplicates are counted once. */
  files: readonly string[];
  /** More files than the configured maximum: excluded from coupling. */
  oversized: boolean;
}

export interface PairCount {
  /** The pair in UTF-8 byte order, so `a` sorts before `b`. */
  a: string;
  b: string;
  /** n(A and B): eligible changes touching both. */
  support: number;
  /** n(A) and n(B): eligible changes touching each. */
  changesA: number;
  changesB: number;
}

export interface CouplingCounts {
  eligibleChanges: number;
  oversizedChanges: number;
  pairs: PairCount[];
}

export interface CouplingThresholds {
  minSupport: number;
  /** Percentage, 0 to 100. */
  minDegree: number;
}

export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Symmetric strength as a percentage: n(A and B) / ((n(A) + n(B)) / 2). Unrounded. */
export function degreeOf(pair: PairCount): number {
  return (200 * pair.support) / (pair.changesA + pair.changesB);
}

/** Probability, as a percentage, that a change to a file with `changes` revisions also touches the other. Unrounded. */
export function confidenceOf(support: number, changes: number): number {
  return (100 * support) / changes;
}

/**
 * Counts co-changes over eligible changes and keeps the pairs that reach the
 * minimum support and degree. The degree test is exact integer arithmetic, so
 * a pair at the threshold is never lost to rounding.
 */
export function countCoupling(changes: readonly CouplingChange[], thresholds: CouplingThresholds): CouplingCounts {
  const perFile = new Map<string, number>();
  const together = new Map<string, Map<string, number>>();
  let eligibleChanges = 0;
  let oversizedChanges = 0;

  for (const change of changes) {
    if (change.oversized) {
      oversizedChanges++;
      continue;
    }
    eligibleChanges++;
    const files = [...new Set(change.files)].sort(compareBytes);
    for (const [i, a] of files.entries()) {
      perFile.set(a, (perFile.get(a) ?? 0) + 1);
      let row = together.get(a);
      if (!row) together.set(a, (row = new Map()));
      for (const b of files.slice(i + 1)) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }

  const pairs: PairCount[] = [];
  for (const [a, row] of together) {
    for (const [b, support] of row) {
      const pair = { a, b, support, changesA: perFile.get(a)!, changesB: perFile.get(b)! };
      const reachesDegree = 200 * support >= thresholds.minDegree * (pair.changesA + pair.changesB);
      if (support >= thresholds.minSupport && reachesDegree) pairs.push(pair);
    }
  }
  pairs.sort((p, q) => compareBytes(p.a, q.a) || compareBytes(p.b, q.b));
  return { eligibleChanges, oversizedChanges, pairs };
}
