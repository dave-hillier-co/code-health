import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import { metricIds, type MetricId, type Values } from "./metrics.ts";
import type { ChangeWeights } from "./change-weights.ts";
import type { UnitRecord } from "./measure.ts";

/**
 * What rows sort on. A metric name sorts by that metric's value, highest first. `max-percentile` sorts by the highest
 * percentile of any selected metric, and `change-weighted` by that percentile times the file's change weight.
 */
export type RankBy = "max-percentile" | "change-weighted" | MetricId;

/** `cognitive` first because it is the default, then the other sorts, then the other metrics. */
export const rankByValues: readonly RankBy[] = ["cognitive", "max-percentile", "change-weighted", ...metricIds.filter((metric) => metric !== "cognitive")];

export const defaultRankBy: RankBy = "cognitive";

/** The metrics that break a tie, in order. After them rows are ordered by path, then by start line. */
const tieBreakers: readonly MetricId[] = ["cognitive", "nesting", "cyclomatic", "length"];

/** The sort keys of a `--by`, in order, as words: the primary key, then each tie breaker not already used, then path. */
export function sortKeys(by: RankBy): string[] {
  const primary = by === "max-percentile" ? "max percentile" : by;
  return [...new Set([primary, ...tieBreakers]), "path"];
}

export interface RankedUnit {
  unit: UnitRecord;
  /** The primary sort key: the value of the metric, `complexityScore`, or `changeWeightedScore`, by `--by`. */
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
export function rankUnits(units: readonly UnitRecord[], selected: readonly MetricId[], changes?: ChangeWeights, by: RankBy = "max-percentile"): RankedUnit[] {
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
    entry.score = scoreOf(entry, by);
  }
  return ranked;
}

function scoreOf(entry: RankedUnit, by: RankBy): number {
  if (by === "max-percentile") return entry.complexityScore;
  if (by === "change-weighted") return entry.changeWeightedScore ?? entry.complexityScore;
  return entry.unit.values[by] ?? 0;
}

const utf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The rows in the order of `--by`: highest first on the primary key, then on each of cognitive, nesting, cyclomatic
 * and length not yet used, then by path and start line, so a tie is always broken the same way and by a key the row shows.
 * A unit that lacks a metric (the lexical layer has no cognitive) counts as 0 on it.
 */
export function sortRanked(ranked: readonly RankedUnit[], by: RankBy): RankedUnit[] {
  const metrics = [...new Set<MetricId>([...(by === "max-percentile" || by === "change-weighted" ? [] : [by]), ...tieBreakers])];
  return [...ranked].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    for (const metric of metrics) {
      const difference = (b.unit.values[metric] ?? 0) - (a.unit.values[metric] ?? 0);
      if (difference !== 0) return difference;
    }
    return utf8(a.unit.path, b.unit.path) || a.unit.startLine - b.unit.startLine || utf8(a.unit.id, b.unit.id);
  });
}
