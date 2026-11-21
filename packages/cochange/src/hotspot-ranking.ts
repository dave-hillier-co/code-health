import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { monthsBefore } from "@code-health/history/evidence";
import { listTree } from "@code-health/history/tree";
import { loadComplexity, type FileComplexity } from "./complexity-source.ts";
import type { By, Unit } from "./file-statistics.ts";
import type { LoadedHistory } from "./history-access.ts";
import { siblingTestOf } from "./sibling-test.ts";
import { midRankPercentiles, shareStrictlyAbove } from "@code-health/cli-kit/ranking";
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
  /** File views only: the sibling test, and the findings raised on the file. */
  siblingTest?: string | null;
  findings?: string[];
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

  const drifting = by === "file" ? await testDrift(context.repo.root, history, units.map((u) => u.name)) : new Map<string, SiblingEvidence>();

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
      ...(by === "file" ? fileFindings(unit, isHotspot, drifting.get(unit.name) ?? null, settings.minSupport) : {}),
    };
  });
  return { rows, complexity };
}

interface SiblingEvidence {
  test: string;
  /** Eligible logical changes touching both the file and its test. */
  together: number;
}

/** The sibling test of each file that has one, and how often the two changed together. */
async function testDrift(root: string, history: LoadedHistory, paths: readonly string[]): Promise<Map<string, SiblingEvidence>> {
  const tree = new Set(await listTree(root, history.view.headSha));
  const siblings = new Map(paths.flatMap((path) => {
    const test = siblingTestOf(path, tree);
    return test === null ? [] : [[path, test] as const];
  }));
  const together = new Map<string, number>();
  for (const change of history.filtered.changes) {
    if (change.oversized) continue;
    const touched = new Map(change.files.map((file) => [file.fileId, file.status] as const));
    for (const [path, test] of siblings) {
      // The change that created the test is not evidence that later changes update it.
      if (touched.has(path) && touched.has(test) && touched.get(test) !== "A") together.set(path, (together.get(path) ?? 0) + 1);
    }
  }
  return new Map([...siblings].map(([path, test]) => [path, { test, together: together.get(path) ?? 0 }]));
}

function fileFindings(unit: Unit, isHotspot: boolean, sibling: SiblingEvidence | null, minSupport: number) {
  const drift = sibling !== null && sibling.together === 0 && unit.revisions >= minSupport;
  return { siblingTest: sibling?.test ?? null, findings: [...(isHotspot ? ["hotspot"] : []), ...(drift ? ["test-drift"] : [])] };
}
