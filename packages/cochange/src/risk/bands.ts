export type Band = "low" | "moderate" | "high";

export const BAND_RANK: Record<Band, number> = { low: 0, moderate: 1, high: 2 };

export const higherBand = (a: Band, b: Band): Band => (BAND_RANK[a] >= BAND_RANK[b] ? a : b);

export const raiseBand = (band: Band): Band => (band === "low" ? "moderate" : "high");

export interface Cutoffs {
  /** Values strictly above this are at least moderate. */
  moderate: number;
  /** Values strictly above this are high. */
  high: number;
  /** The baseline the cutoffs came from. */
  population: number;
}

/**
 * The nearest-rank percentile: the smallest value that at least `percent` percent of the population is at
 * or below. Integer arithmetic, so the rank never drifts. Null for an empty population.
 *
 * Nearest rank is used, not interpolation, because it keeps the bands' guarantee: with cutoffs taken at
 * the 75th and 90th percentile, a strict comparison leaves at most 25 % of the population above the first
 * and at most 10 % above the second, however many values tie.
 */
export function nearestRank(values: readonly number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.floor((percent * sorted.length + 99) / 100));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/** Cutoffs of a baseline population, or null when it is empty. */
export function cutoffsOf(population: readonly number[], moderatePercentile: number, highPercentile: number): Cutoffs | null {
  const moderate = nearestRank(population, moderatePercentile);
  const high = nearestRank(population, highPercentile);
  return moderate === null || high === null ? null : { moderate, high, population: population.length };
}

/**
 * A value against a population's cutoffs. Strict, and zero is always low: many factors are zero for most
 * changes, and a percentile of zero would otherwise mark every change that is not.
 */
export function bandAgainst(value: number, cutoffs: Cutoffs): Band {
  if (value <= 0) return "low";
  if (value > cutoffs.high) return "high";
  if (value > cutoffs.moderate) return "moderate";
  return "low";
}

/** A count of specific events against fixed thresholds. */
export function bandCount(count: number, thresholds: { moderate: number; high: number }): Band {
  if (count >= thresholds.high) return "high";
  if (count >= thresholds.moderate) return "moderate";
  return "low";
}
