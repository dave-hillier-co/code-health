import type { Commit } from "@code-health/history/trend-samples";
import type { GrammarSet } from "@code-health/parse/grammars";
import type { ParseCache } from "@code-health/parse/parse-cache";
import { treeFromRef } from "@code-health/parse/source-tree";
import type { FunctionMeasureId, Sample } from "./backtest.ts";
import type { ComplexitySettings } from "./config.ts";
import { productionCode } from "./folder-measures.ts";
import { FunctionFollower, followedUnits } from "./function-history.ts";
import { measureTree } from "./measure.ts";

/** One function at one sample, with what followed. */
export type FunctionSample = Sample<FunctionMeasureId> & { path: string; id: string };

export interface FunctionPeriod {
  /** Production code files with a followed function at the sample. */
  files: number;
  /** Functions at the sample that the figures count. */
  functions: number;
  /** Functions at the sample that a later revision of the period had no counterpart for: deleted, or changed or moved past recognition. Their changes up to then are counted. */
  ended: number;
  /** Functions at the sample the follower had lost track of before it, which are left out. */
  notFollowed: number;
}

export interface FunctionSamples {
  samples: FunctionSample[][];
  periods: FunctionPeriod[];
  stats: { parsed: number; cached: number };
}

/**
 * The production functions at each sample but the last, with the landed changes that changed their lines in the period
 * before the sample and the one after it. The periods are cut on the first-parent line at the sampled revisions, and the
 * period before a sample starts at the last commit of the line at or before `priorStarts[i]`. A landed change counts when
 * `counted` has it; a fix is never a fix of a function it created.
 */
export async function functionSamples(
  root: string,
  settings: ComplexitySettings,
  line: readonly Commit[],
  commits: readonly Commit[],
  priorStarts: readonly number[],
  counted: ReadonlyMap<string, { fix: boolean }>,
  measure: { cache: ParseCache; grammars: GrammarSet },
): Promise<FunctionSamples> {
  const index = new Map(line.map((commit, i) => [commit.sha, i] as const));
  const at = commits.map((commit) => index.get(commit.sha)!);
  const startOf = priorStarts.map((time, i) => Math.min(at[i]!, line.findLastIndex((commit) => commit.date <= time)));
  const follower = new FunctionFollower(root, settings, line, Math.min(...startOf), measure);
  const stats = { parsed: 0, cached: 0 };

  const atSample: { sample: FunctionSample; lineage: string }[][] = [];
  const periods: FunctionPeriod[] = [];
  for (let i = 0; i + 1 < commits.length; i++) {
    await follower.advanceTo(at[i]!);
    const { files, stats: own } = await measureTree(await treeFromRef(root, commits[i]!.sha), { settings, layer: "structural", ...measure });
    stats.parsed += own.parsed;
    stats.cached += own.cached;
    const rows: { sample: FunctionSample; lineage: string }[] = [];
    let notFollowed = 0;
    let withFunctions = 0;
    for (const file of productionCode(files, settings)) {
      const units = followedUnits(file);
      if (units.length > 0) withFunctions++;
      for (const unit of units) {
        const lineage = follower.lineageOf(file.path, unit.id);
        if (lineage === undefined) {
          notFollowed++;
          continue;
        }
        rows.push({
          lineage,
          sample: {
            path: file.path,
            id: unit.id,
            codeLines: unit.values.length ?? unit.endLine - unit.startLine + 1,
            cyclomatic: unit.values.cyclomatic ?? 0,
            cognitive: unit.values.cognitive ?? 0,
            nesting: unit.values.nesting ?? 0,
            parameters: unit.values.parameters ?? 0,
            priorChanges: 0,
            changes: 0,
            linesChurned: 0,
            fixes: 0,
          },
        });
      }
    }
    atSample.push(rows);
    periods.push({ files: withFunctions, functions: rows.length, ended: 0, notFollowed });
  }
  await follower.advanceTo(at.at(-1)!);
  stats.parsed += follower.stats.parsed;
  stats.cached += follower.stats.cached;

  for (let i = 0; i < atSample.length; i++) {
    const from = at[i]!;
    const to = at[i + 1]!;
    for (const { sample, lineage } of atSample[i]!) {
      for (const touch of follower.touches.get(lineage) ?? []) {
        const landing = counted.get(line[touch.at]!.sha);
        if (landing === undefined) continue;
        if (touch.at > startOf[i]! && touch.at <= from) sample.priorChanges++;
        else if (touch.at > from && touch.at <= to) {
          sample.changes++;
          sample.linesChurned += touch.churn;
          if (landing.fix && !touch.created) sample.fixes++;
        }
      }
      const ended = follower.ended.get(lineage);
      if (ended !== undefined && ended > from && ended <= to) periods[i]!.ended++;
    }
  }
  return { samples: atSample.map((rows) => rows.map((row) => row.sample)), periods, stats };
}
