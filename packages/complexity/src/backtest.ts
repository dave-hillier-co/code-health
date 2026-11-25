import type { FileRecord } from "./measure.ts";
import { guidelinesFor, type ComplexitySettings } from "./config.ts";
import { productionCode, weightOf } from "./folder-measures.ts";
import { topLevelUnits } from "./rows.ts";

/** The measures of one file at a sample, in the order they are reported. `codeLines` is first: it is the control of every partial correlation. */
export const MEASURES = ["codeLines", "functions", "cyclomaticSum", "cyclomaticMean", "cyclomaticMax", "shareAbove", "cognitiveSum", "cognitiveMax", "indentation", "priorChanges", "hotspot"] as const;
export type MeasureId = (typeof MEASURES)[number];

export const MEASURE_SUMMARIES: Record<MeasureId, string> = {
  codeLines: "Lines of code, blank and comment lines excluded",
  functions: "Functions measured, a nested function counted in the function that holds it",
  cyclomaticSum: "Sum of the functions' cyclomatic complexity",
  cyclomaticMean: "Mean cyclomatic complexity per function",
  cyclomaticMax: "Largest cyclomatic complexity of one function",
  shareAbove: "Share of weighted complexity in functions above the cyclomatic guideline, where a function's weight is its cyclomatic complexity times the square root of its code lines",
  cognitiveSum: "Sum of the functions' cognitive complexity",
  cognitiveMax: "Largest cognitive complexity of one function",
  indentation: "Indentation complexity of the file, the complexity half of a hotspot",
  priorChanges: "Landed changes that touched the file in the period before the sample, as long as the period after it",
  hotspot: "Indentation complexity times prior changes",
};

/** The measures of one function at a sample. `codeLines` is first, as in the file measures. */
export const FUNCTION_MEASURES = ["codeLines", "cyclomatic", "cognitive", "nesting", "parameters", "priorChanges"] as const;
export type FunctionMeasureId = (typeof FUNCTION_MEASURES)[number];

export const FUNCTION_MEASURE_SUMMARIES: Record<FunctionMeasureId, string> = {
  codeLines: "Lines of code of the function, blank and comment lines excluded, a nested function's lines included",
  cyclomatic: "Cyclomatic complexity of the function",
  cognitive: "Cognitive complexity of the function",
  nesting: "Deepest nesting of control structures in the function",
  parameters: "Declared parameters of the function",
  priorChanges: "Landed changes that changed lines of the function in the period before the sample, as long as the period after it, the change that created it included",
};

/** What the changes of the period after a sample did to a file or a function. */
export const OUTCOMES = ["changes", "linesChurned", "linesPerChange", "fixShare", "fixesPerLine"] as const;
export type OutcomeId = (typeof OUTCOMES)[number];

export const OUTCOME_SUMMARIES: Record<OutcomeId, string> = {
  changes: "Landed changes that touched the file, over every file",
  linesChurned: "Lines added plus deleted in the file, over every file",
  linesPerChange: "Lines added plus deleted per landed change, over the files that changed",
  fixShare: "Share of the file's landed changes that are fixes, over the files with at least the minimum number of changes",
  fixesPerLine: "Landed changes that are fixes and touched the file, per code line at the sample, over every file",
};

export const FUNCTION_OUTCOME_SUMMARIES: Record<OutcomeId, string> = {
  changes: "Landed changes that changed lines of the function, over every function",
  linesChurned: "Lines added inside the function plus the deleted lines of the hunks that touched it, over every function. A hunk that touched several functions shares its deleted lines between them equally",
  linesPerChange: "Lines churned per landed change, over the functions that changed",
  fixShare: "Share of the function's landed changes that are fixes, over the functions with at least the minimum number of changes",
  fixesPerLine: "Landed changes that are fixes and changed lines of the function, per code line of the function at the sample, over every function",
};

/** What followed a sample, for one file or one function. */
export interface Followed {
  changes: number;
  linesChurned: number;
  fixes: number;
}

/** One unit at one sample: its measures, with code lines among them, and what followed. */
export type Sample<M extends string> = Record<M | "codeLines", number> & Followed;

/** One file at one sample, with what followed. */
export interface FileSample extends Record<MeasureId, number>, Followed {
  path: string;
}

/** The measures of the production code files that have a function with a cyclomatic complexity. History figures start at 0. */
export function fileSamples(files: readonly FileRecord[], settings: ComplexitySettings): FileSample[] {
  const samples: FileSample[] = [];
  for (const file of productionCode(files, settings)) {
    const limit = guidelinesFor(settings, file.path).cyclomatic.warn;
    const functions = topLevelUnits(file.units).filter((unit) => !unit.test && unit.values.cyclomatic !== undefined);
    if (functions.length === 0) continue;
    let cyclomaticSum = 0;
    let cyclomaticMax = 0;
    let cognitiveSum = 0;
    let cognitiveMax = 0;
    let weight = 0;
    let weightAbove = 0;
    for (const unit of functions) {
      const cyclomatic = unit.values.cyclomatic!;
      const cognitive = unit.values.cognitive ?? 0;
      const own = weightOf(cyclomatic, unit.values.length ?? 1);
      cyclomaticSum += cyclomatic;
      cyclomaticMax = Math.max(cyclomaticMax, cyclomatic);
      cognitiveSum += cognitive;
      cognitiveMax = Math.max(cognitiveMax, cognitive);
      weight += own;
      if (cyclomatic > limit) weightAbove += own;
    }
    samples.push({
      path: file.path,
      codeLines: file.lines.codeLines,
      functions: functions.length,
      cyclomaticSum,
      cyclomaticMean: cyclomaticSum / functions.length,
      cyclomaticMax,
      shareAbove: weight === 0 ? 0 : weightAbove / weight,
      cognitiveSum,
      cognitiveMax,
      indentation: file.indentationComplexity,
      priorChanges: 0,
      hotspot: 0,
      changes: 0,
      linesChurned: 0,
      fixes: 0,
    });
  }
  return samples;
}

/** Ranks from 1, with tied values sharing the mean of the ranks they span. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!] === values[order[i]!]) j++;
    for (let k = i; k <= j; k++) out[order[k]!] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Pearson correlation, or null when either side has no variation. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n === 0) return null;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let cross = 0;
  let squareA = 0;
  let squareB = 0;
  for (let i = 0; i < n; i++) {
    cross += (a[i]! - meanA) * (b[i]! - meanB);
    squareA += (a[i]! - meanA) ** 2;
    squareB += (b[i]! - meanB) ** 2;
  }
  return squareA === 0 || squareB === 0 ? null : cross / Math.sqrt(squareA * squareB);
}

/** Spearman rank correlation: the Pearson correlation of the ranks. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  return pearson(ranks(a), ranks(b));
}

/** The correlation of two sets of ranks with a third held fixed, or null when either is the third in another order. */
export function partial(x: readonly number[], y: readonly number[], control: readonly number[]): number | null {
  const xy = pearson(x, y);
  const xz = pearson(x, control);
  const yz = pearson(y, control);
  if (xy === null || xz === null || yz === null || Math.abs(xz) > 0.9999 || Math.abs(yz) > 0.9999) return null;
  return (xy - xz * yz) / Math.sqrt((1 - xz ** 2) * (1 - yz ** 2));
}

export interface Correlation<M extends string = MeasureId> {
  outcome: OutcomeId;
  measure: M;
  /** Spearman correlation within each period, averaged over the periods by their number of samples. Null when no period had variation on both sides. */
  correlation: number | null;
  /** The same with code lines held fixed. Null for code lines itself. */
  partialOnCodeLines: number | null;
  /** How many samples, summed over the periods, the figures rest on. */
  samples: number;
  /** How many periods had enough samples. */
  periods: number;
  /** One correlation over the samples of every period, each value ranked within its own period. Null when the pool is below the minimum or has no variation on a side. */
  pooledCorrelation: number | null;
  /** The same with code lines held fixed. Null for code lines itself. */
  pooledPartialOnCodeLines: number | null;
  /** How many samples, from every period, the pooled figures rest on. */
  pooledSamples: number;
  /** How many periods gave samples to the pool. */
  pooledPeriods: number;
}

function population<S extends Followed & { codeLines: number }>(outcome: OutcomeId, samples: readonly S[], minChanges: number): { samples: S[]; values: number[] } {
  if (outcome === "linesPerChange") {
    const changed = samples.filter((sample) => sample.changes > 0);
    return { samples: changed, values: changed.map((sample) => sample.linesChurned / sample.changes) };
  }
  if (outcome === "fixShare") {
    const busy = samples.filter((sample) => sample.changes >= minChanges);
    return { samples: busy, values: busy.map((sample) => sample.fixes / sample.changes) };
  }
  if (outcome === "fixesPerLine") return { samples: [...samples], values: samples.map((sample) => sample.fixes / Math.max(sample.codeLines, 1)) };
  return { samples: [...samples], values: samples.map((sample) => sample[outcome]) };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Ranks scaled to the period's size, from 0 to 1, so that samples ranked within periods of different sizes can be pooled. */
const scaledRanks = (values: readonly number[]): number[] => ranks(values).map((rank) => (rank - 0.5) / values.length);

/**
 * Each measure against each outcome. A correlation is taken within a period and never across periods, so that a
 * repository that grew and got busier over the years does not show that as a link between size and change.
 * A period with fewer than `minSamples` samples for an outcome, or fewer than `minSamples` of them changed, is left out of
 * that outcome. The pooled figures take every period, each sample ranked within its own period, and need the minimum
 * over the pool instead of in each period.
 */
export function correlate<M extends string>(periods: readonly (readonly Sample<M>[])[], measures: readonly M[], minSamples: number, minChanges: number): Correlation<M>[] {
  const out: Correlation<M>[] = [];
  for (const outcome of OUTCOMES) {
    const sums = new Map<M, { raw: number; rawN: number; part: number; partN: number; n: number; periods: number }>(measures.map((measure) => [measure, { raw: 0, rawN: 0, part: 0, partN: 0, n: 0, periods: 0 }]));
    const pool = { x: new Map<M, number[]>(measures.map((measure) => [measure, []])), y: [] as number[], control: [] as number[], changed: 0, periods: 0 };
    for (const period of periods) {
      const { samples, values } = population(outcome, period, minChanges);
      if (samples.length > 0) {
        pool.periods++;
        pool.changed += samples.filter((sample) => sample.changes > 0).length;
        pool.y.push(...scaledRanks(values));
        pool.control.push(...scaledRanks(samples.map((sample) => sample.codeLines)));
        for (const measure of measures) pool.x.get(measure)!.push(...scaledRanks(samples.map((sample) => sample[measure])));
      }
      // A period in which almost nothing changed orders the samples by nothing, and would count for as much as a busy one.
      if (samples.length < minSamples || samples.filter((sample) => sample.changes > 0).length < minSamples) continue;
      const y = ranks(values);
      const control = ranks(samples.map((sample) => sample.codeLines));
      for (const measure of measures) {
        const x = ranks(samples.map((sample) => sample[measure]));
        const sum = sums.get(measure)!;
        sum.n += samples.length;
        sum.periods++;
        const raw = pearson(x, y);
        if (raw !== null) {
          sum.raw += raw * samples.length;
          sum.rawN += samples.length;
        }
        const held = measure === "codeLines" ? null : partial(x, y, control);
        if (held !== null) {
          sum.part += held * samples.length;
          sum.partN += samples.length;
        }
      }
    }
    const enough = pool.y.length >= minSamples && pool.changed >= minSamples;
    for (const measure of measures) {
      const sum = sums.get(measure)!;
      const x = pool.x.get(measure)!;
      const pooled = enough ? pearson(x, pool.y) : null;
      const pooledHeld = enough && measure !== "codeLines" ? partial(x, pool.y, pool.control) : null;
      out.push({
        outcome,
        measure,
        correlation: sum.rawN === 0 ? null : round3(sum.raw / sum.rawN),
        partialOnCodeLines: sum.partN === 0 ? null : round3(sum.part / sum.partN),
        samples: sum.n,
        periods: sum.periods,
        pooledCorrelation: pooled === null ? null : round3(pooled),
        pooledPartialOnCodeLines: pooledHeld === null ? null : round3(pooledHeld),
        pooledSamples: pool.y.length,
        pooledPeriods: pool.periods,
      });
    }
  }
  return out;
}
