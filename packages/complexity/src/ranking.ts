import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import { metricIds, type MetricId, type Values } from "./metrics.ts";
import type { ChangeWeights } from "./change-weights.ts";
import type { UnitRecord } from "./measure.ts";

export interface RankedUnit {
  unit: UnitRecord;
  /** The highest percentile of any selected metric, from 0 to 1, times the change weight when there is one. */
  score: number;
  /** The same percentile before weighting. */
  complexityScore: number;
  /** Logical changes to the unit's file in the window, or null when change frequency was not used. */
  revisions: number | null;
  /** 0 to 1, or null when change frequency was not used. */
  changeWeight: number | null;
  /** The selected metric that gave the score. Ties go to the metric listed first in `metricIds`. */
  dominant: MetricId | null;
  percentiles: Values;
}

/**
 * Ranks units by the percentile of each metric within the units measured the same way, so test code is
 * ranked among tests and a lexical block is never compared with a structural unit. The complexity score is
 * the highest percentile across the selected metrics, and the metric behind it is named as dominant. With
 * change weights the rank score is that percentile times the file's change weight.
 */
export function rankUnits(units: readonly UnitRecord[], selected: readonly MetricId[], changes?: ChangeWeights): RankedUnit[] {
  const ranked: RankedUnit[] = units.map((unit) => ({
    unit,
    score: 0,
    complexityScore: 0,
    revisions: changes === undefined ? null : (changes.revisions.get(unit.path) ?? 0),
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
  // Complexity in code that never changes costs nothing to live with, so it ranks last.
  for (const entry of ranked) entry.score = entry.changeWeight === null ? entry.complexityScore : entry.complexityScore * entry.changeWeight;
  return ranked;
}
