import { coChangeDegree } from "@code-health/history/co-change";
import type { PairCount } from "./coupling.ts";

/** How a pair's degree moved from the previous window to the current one. */
export type CouplingTrend = "stronger" | "stable" | "weaker";

/** What `coupling --trend` adds to a pair. All null when the previous window holds no eligible change to compare with. */
export interface PairTrend {
  previousDegree: number | null;
  previousSupport: number | null;
  /** Current degree minus previous degree, in percentage points, both rounded to one decimal first so the label agrees with what is printed. */
  degreeChange: number | null;
  trend: CouplingTrend | null;
}

const tenths = (value: number) => Math.round(value * 10);

const keyOf = (a: string, b: string) => `${a}\0${b}`;

/** The pairs of a window by their two files, for the lookup of the earlier window. */
export function pairIndex(pairs: readonly PairCount[]): Map<string, PairCount> {
  return new Map(pairs.map((pair) => [keyOf(pair.a, pair.b), pair]));
}

/**
 * Compares a pair's degree with the same pair's degree in the previous window of the same length. A pair that shared
 * no change before has degree 0 and support 0 there. A change within `tolerance` percentage points either way is
 * stable. The tolerance is a judgement call (`cochange.couplingTrendTolerance`), and the degrees are always printed beside the label.
 * `previous` is undefined when the previous window holds no eligible change.
 */
export function pairTrend(current: PairCount, previous: ReadonlyMap<string, PairCount> | undefined, tolerance: number): PairTrend {
  if (previous === undefined) return { previousDegree: null, previousSupport: null, degreeChange: null, trend: null };
  const before = previous.get(keyOf(current.a, current.b));
  const previousDegree = before === undefined ? 0 : coChangeDegree(before.support, before.changesA, before.changesB);
  const degree = coChangeDegree(current.support, current.changesA, current.changesB);
  const change = tenths(degree) - tenths(previousDegree);
  return {
    previousDegree: tenths(previousDegree) / 10,
    previousSupport: before?.support ?? 0,
    degreeChange: change / 10,
    trend: Math.abs(change) <= tolerance * 10 ? "stable" : change > 0 ? "stronger" : "weaker",
  };
}
