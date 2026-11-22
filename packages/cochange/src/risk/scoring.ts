import { BAND_RANK, bandAgainst, bandCount, cutoffsOf, higherBand, raiseBand, type Band, type Cutoffs } from "./bands.ts";
import type { Measurement } from "./measure.ts";
import type { RiskSettings } from "./settings.ts";

/**
 * Factors that count towards the impact score: the history layer's factors in each family, each family
 * counting once at its highest band. The factors that are events or need the content (`sensitive-paths`,
 * `structure-delta`, `complexity-delta`) are reported and raise the band as events, and do not also
 * count in the score, so one fact is never counted twice.
 */
export const SCORED_FACTORS: ReadonlySet<string> = new Set([
  "size",
  "spread",
  "entropy",
  "mixed-purpose",
  "hotspots-touched",
  "defect-history",
  "contention",
  "age",
  "missing-co-change",
  "novel-coupling",
  "test-evidence",
  "blast-radius",
]);

export type FactorBand = Band | "unavailable";

export interface BandResult {
  band: FactorBand;
  reason: string | null;
  /** For each series, the values above which the factor is moderate and high. Null when no baseline could set them. */
  guidelines: Record<string, { moderate: number; high: number } | null>;
}

/** Places measurements against a baseline population of measurements made the same way, as of their own time. */
export function makeBander(baseline: readonly (readonly Measurement[])[], settings: RiskSettings): (measurement: Measurement) => BandResult {
  const cache = new Map<string, Cutoffs | null>();
  const cutoffs = (name: string, series: string): Cutoffs | null => {
    const key = `${name}\0${series}`;
    if (!cache.has(key)) {
      const population = baseline.flatMap((measures) => {
        const found = measures.find((m) => m.name === name);
        return found && found.unavailable === null && found.series[series] !== undefined ? [found.series[series]!] : [];
      });
      cache.set(key, population.length < settings.minBaseline ? null : cutoffsOf(population, settings.moderatePercentile, settings.highPercentile));
    }
    return cache.get(key)!;
  };

  return (measurement) => {
    if (measurement.unavailable !== null) return { band: "unavailable", reason: measurement.unavailable, guidelines: {} };
    if (measurement.kind === "count") {
      const guidelines = { moderate: settings.countModerate, high: settings.countHigh };
      const count = Object.values(measurement.series)[0] ?? 0;
      return { band: bandCount(count, guidelines), reason: null, guidelines: { count: guidelines } };
    }
    let band: Band = "low";
    let reason: string | null = null;
    const guidelines: BandResult["guidelines"] = {};
    for (const [series, value] of Object.entries(measurement.series)) {
      const found = cutoffs(measurement.name, series);
      guidelines[series] = found === null ? null : { moderate: found.moderate, high: found.high };
      if (found === null) {
        if (value > 0) reason = `fewer than ${settings.minBaseline} merged changes in the baseline, so a value of ${value} cannot be placed`;
        continue;
      }
      band = higherBand(band, bandAgainst(value, found));
    }
    // A value above zero that could not be placed is unknown, not low. Zero is low whatever the baseline.
    if (reason !== null && band === "low") return { band: "unavailable", reason, guidelines };
    return { band, reason: null, guidelines };
  };
}

const FAMILY_POINTS: Record<Band, number> = { low: 0, moderate: 1, high: 2 };

/** The sum over families of the band of each family's highest scored factor. Unavailable factors add nothing. */
export function impactScore(factors: readonly { name: string; family: string; band: FactorBand; disabled?: boolean }[]): number {
  const best = new Map<string, Band>();
  for (const factor of factors) {
    if (!SCORED_FACTORS.has(factor.name) || factor.disabled || factor.band === "unavailable") continue;
    best.set(factor.family, higherBand(best.get(factor.family) ?? "low", factor.band));
  }
  return [...best.values()].reduce((sum, band) => sum + FAMILY_POINTS[band], 0);
}

/** The score of each change of the baseline, banded against the baseline itself. */
export function baselineScores(baseline: readonly (readonly Measurement[])[], settings: RiskSettings): number[] {
  const bander = makeBander(baseline, settings);
  return baseline.map((measures) =>
    impactScore(measures.map((m) => ({ name: m.name, family: m.family, band: bander(m).band, disabled: settings.disabled.has(m.name) }))),
  );
}

export interface ImpactResult {
  score: number;
  /** The band the score earns against the baseline, before events. */
  scoreBand: FactorBand;
  /** After events raised it, once. */
  band: FactorBand;
  events: string[];
  /** Scored factors that could not be computed or placed. They add nothing, and the reader should know. */
  unavailable: string[];
  baseline: { population: number; moderate: number | null; high: number | null };
}

/** The impact of a change from its banded factors, the baseline's scores and the events that raise it. */
export function impactOf(
  factors: readonly { name: string; family: string; band: FactorBand; disabled?: boolean }[],
  scores: readonly number[],
  events: readonly string[],
  settings: RiskSettings,
): ImpactResult {
  const score = impactScore(factors);
  const cutoffs = scores.length < settings.minBaseline ? null : cutoffsOf(scores, settings.moderatePercentile, settings.highPercentile);
  // With too few changes to compare, even a score of zero cannot be called low: nothing says what ordinary is.
  const scoreBand: FactorBand = cutoffs === null ? "unavailable" : bandAgainst(score, cutoffs);
  // Events raise a band that exists. With no baseline to place the score in, they are listed and nothing is invented.
  const band: FactorBand = scoreBand !== "unavailable" && events.length > 0 ? raiseBand(scoreBand) : scoreBand;
  return {
    score,
    scoreBand,
    band,
    events: [...events],
    unavailable: factors.filter((f) => SCORED_FACTORS.has(f.name) && !f.disabled && f.band === "unavailable").map((f) => f.name).sort(),
    baseline: { population: scores.length, moderate: cutoffs?.moderate ?? null, high: cutoffs?.high ?? null },
  };
}

export { BAND_RANK };
