/**
 * Temporal coupling counts. Every count is over the same population: eligible
 * logical changes, those at or below the maximum changeset size. Oversized
 * changes are left out of the pair counts and of both denominators.
 */

import { coChangeDegree } from "@code-health/history/co-change";

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
  /** Evidence floor: pairs with fewer shared eligible changes are not counted. */
  minSupport: number;
  /**
   * Percentage, 0 to 100. A cut that only cluster membership asks for. Left out (0), every pair
   * at the support floor is returned, and the caller labels each against the degree guideline.
   */
  minDegree?: number;
}

export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Symmetric strength as a percentage: n(A and B) / ((n(A) + n(B)) / 2). Unrounded. */
export function degreeOf(pair: PairCount): number {
  return coChangeDegree(pair.support, pair.changesA, pair.changesB);
}

/**
 * Whether a pair's degree reaches `minDegree`, in exact integer arithmetic: the degree rounded for
 * display (19.98 shown as 20.0) must never decide a threshold.
 */
export function reachesDegree(pair: PairCount, minDegree: number): boolean {
  return 200 * pair.support >= minDegree * (pair.changesA + pair.changesB);
}

/** Probability, as a percentage, that a change to a file with `changes` revisions also touches the other. Unrounded. */
export function confidenceOf(support: number, changes: number): number {
  return (100 * support) / changes;
}

/**
 * Counts co-changes over eligible changes and keeps the pairs that reach the
 * support floor and, when given, the degree. The degree test is exact integer arithmetic, so
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
      if (support >= thresholds.minSupport && reachesDegree(pair, thresholds.minDegree ?? 0)) pairs.push(pair);
    }
  }
  pairs.sort((p, q) => compareBytes(p.a, q.a) || compareBytes(p.b, q.b));
  return { eligibleChanges, oversizedChanges, pairs };
}

export interface Partner {
  path: string;
  /** n(focus and path): eligible changes touching both. */
  support: number;
  /** n(focus): eligible changes touching the focused file. */
  changesFocus: number;
  /** n(path): eligible changes touching the partner. */
  changesPartner: number;
}

export interface Partners {
  /** n(focus). Zero when no eligible change touched the file. */
  changesFocus: number;
  /** Every file that shared at least one eligible change with the focus, in UTF-8 byte order of path. */
  partners: Partner[];
}

/**
 * The same counts as `countCoupling`, restricted to the pairs that include one
 * file and without any threshold. It never builds the pair table of the whole
 * repository, which keeps it cheap enough for a hook.
 */
export function partnersOf(changes: readonly CouplingChange[], focus: string): Partners {
  const perFile = new Map<string, number>();
  const together = new Map<string, number>();
  let changesFocus = 0;
  for (const change of changes) {
    if (change.oversized) continue;
    const files = new Set(change.files);
    for (const file of files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    if (!files.has(focus)) continue;
    changesFocus++;
    for (const file of files) if (file !== focus) together.set(file, (together.get(file) ?? 0) + 1);
  }
  const partners = [...together]
    .map(([path, support]) => ({ path, support, changesFocus, changesPartner: perFile.get(path)! }))
    .sort((x, y) => compareBytes(x.path, y.path));
  return { changesFocus, partners };
}
