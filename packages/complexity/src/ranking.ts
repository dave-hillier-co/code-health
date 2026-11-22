import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import { metricIds, type MetricId, type Values } from "./metrics.ts";
import type { ChangeWeights } from "./change-weights.ts";
import type { UnitRecord } from "./measure.ts";

/** What `score` is: the complexity percentile itself, or that percentile times the change weight of the unit's file. */
export type RankBy = "complexity" | "change-weighted";

export const rankByValues: readonly RankBy[] = ["complexity", "change-weighted"];

export interface RankedUnit {
  unit: UnitRecord;
  /** The sort key: `complexityScore`, or `changeWeightedScore` when the ranking is by change-weighted. */
  score: number;
  /** The highest percentile of any selected metric, from 0 to 1. */
  complexityScore: number;
  /** `complexityScore` times the change weight, or null when change frequency was not used. */
  changeWeightedScore: number | null;
  /** Logical changes to the unit's file in the window, not the function's own, or null when change frequency was not used. */
  fileRevisions: number | null;
  /** 0 to 1, or null when change frequency was not used. */
  changeWeight: number | null;
  /** The selected metric that gave the score. Ties go to the metric listed first in `metricIds`. */
  dominant: MetricId | null;
  percentiles: Values;
}

/**
 * Ranks units by the percentile of each metric within the units measured the same way, so test code is
 * ranked among tests and a lexical block is never compared with a structural unit. The complexity score is
 * the highest percentile across the selected metrics, and the metric behind it is named as dominant. The
 * change-weighted score is that percentile times the file's change weight. `by` picks which of the two is
 * the score that rows sort on, and every row carries both when change weights are given.
 */
export function rankUnits(units: readonly UnitRecord[], selected: readonly MetricId[], changes?: ChangeWeights, by: RankBy = "complexity"): RankedUnit[] {
  const ranked: RankedUnit[] = units.map((unit) => ({
    unit,
    score: 0,
    complexityScore: 0,
    changeWeightedScore: null,
    fileRevisions: changes === undefined ? null : (changes.revisions.get(unit.path) ?? 0),
    changeWeight: changes === undefined ? null : (changes.weights.get(unit.path) ?? 0),
    dominant: null,
    percentiles: {},
  }));
  const groups = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const key = `${unit.source}|${unit.test}`;
    const members = groups.get(key);
    if (members === undefined) groups.set(key, [index]);
    else members.push(index);
  });

  for (const members of groups.values()) {
    for (const metric of metricIds) {
      if (!selected.includes(metric)) continue;
      const having = members.filter((index) => units[index]!.values[metric] !== undefined);
      const percentiles = midRankPercentiles(having.map((index) => units[index]!.values[metric]!));
      having.forEach((index, position) => {
        const entry = ranked[index]!;
        const percentile = percentiles[position]!;
        entry.percentiles[metric] = percentile;
        if (entry.dominant === null || percentile > entry.complexityScore) {
          entry.complexityScore = percentile;
          entry.dominant = metric;
        }
      });
    }
  }
  // By change-weighted, complexity in code that never changes costs nothing to live with, so it ranks last.
  for (const entry of ranked) {
    entry.changeWeightedScore = entry.changeWeight === null ? null : entry.complexityScore * entry.changeWeight;
    entry.score = by === "change-weighted" && entry.changeWeightedScore !== null ? entry.changeWeightedScore : entry.complexityScore;
  }
  return ranked;
}
