import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { loadComplexity, type FileComplexity } from "./complexity-source.ts";
import type { By } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";
import { midRankPercentiles, shareStrictlyAbove } from "./ranking.ts";
import { SECONDS_PER_DAY, isoDate, loadUnits } from "./units.ts";

export interface HotspotRow {
  path: string;
  score: number | null;
  /** Files in the unit, for component views only. */
  files?: number;
  frequency: number;
  churn: number;
  complexity: number | null;
  ageDays: number;
  lastChanged: string;
  recommendation: "hotspot" | null;
}

export interface HotspotRanking {
  rows: HotspotRow[];
  complexity: FileComplexity;
}

/**
 * Scores every file (or component) that exists at the analysed commit:
 * the rank percentile of change frequency times the rank percentile of complexity.
 * A hotspot has a score in the top configured percentile and changed within the recent window.
 */
export async function rankHotspots(context: CommandContext, history: LoadedHistory, by: By): Promise<HotspotRanking> {
  const { settings } = history;
  const units = await loadUnits(context, history, by);

  const paths = [...new Set(units.flatMap((u) => [...u.members]))].sort();
  const complexity = await loadComplexity(context, history.view.headSha, paths);
  const unitComplexity = units.map((unit) => {
    const known = [...unit.members].map((path) => complexity.values.get(path) ?? null).filter((v) => v !== null);
    return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0);
  });

  const frequencyPercentile = midRankPercentiles(units.map((u) => u.revisions));
  const scoredIndexes = unitComplexity.flatMap((value, index) => (value === null ? [] : [index]));
  const complexityPercentile = new Map(
    midRankPercentiles(scoredIndexes.map((i) => unitComplexity[i]!)).map((p, k) => [scoredIndexes[k]!, p]),
  );
  const scores = units.map((_, i) => (complexityPercentile.has(i) ? frequencyPercentile[i]! * complexityPercentile.get(i)! : null));
  const scored = scores.filter((s) => s !== null);

  const anchor = history.view.headDate;
  const recentSince = monthsBefore(anchor, settings.recentMonths);
  const topShare = (100 - settings.hotspotPercentile) / 100;

  const rows = units.map((unit, i): HotspotRow => {
    const score = scores[i]!;
    const isHotspot = score !== null && shareStrictlyAbove(scored, score) < topShare && unit.lastChanged >= recentSince;
    return {
      path: unit.name,
      score,
      ...(by === "component" ? { files: unit.files } : {}),
      frequency: unit.revisions,
      churn: unit.churn,
      complexity: unitComplexity[i]!,
      ageDays: Math.floor((anchor - unit.lastChanged) / SECONDS_PER_DAY),
      lastChanged: isoDate(unit.lastChanged),
      recommendation: isHotspot ? "hotspot" : null,
    };
  });
  return { rows, complexity };
}
