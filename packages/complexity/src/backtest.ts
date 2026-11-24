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

/** What the changes of the period after a sample did to a file. */
export const OUTCOMES = ["changes", "linesChurned", "linesPerChange", "fixShare"] as const;
export type OutcomeId = (typeof OUTCOMES)[number];

export const OUTCOME_SUMMARIES: Record<OutcomeId, string> = {
  changes: "Landed changes that touched the file, over every file",
  linesChurned: "Lines added plus deleted in the file, over every file",
  linesPerChange: "Lines added plus deleted per landed change, over the files that changed",
  fixShare: "Share of the file's landed changes that are fixes, over the files with at least the minimum number of changes",
};

/** One file at one sample, with what followed. */
export interface FileSample extends Record<MeasureId, number> {
  path: string;
  changes: number;
  linesChurned: number;
  fixes: number;
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

export interface Correlation {
  outcome: OutcomeId;
  measure: MeasureId;
  /** Spearman correlation within each period, averaged over the periods by their number of files. Null when no period had variation on both sides. */
  correlation: number | null;
  /** The same with code lines held fixed. Null for code lines itself. */
  partialOnCodeLines: number | null;
  /** How many files, summed over the periods, the figures rest on. */
  fileSamples: number;
  /** How many periods had enough files. */
  periods: number;
}

function population(outcome: OutcomeId, files: readonly FileSample[], minChanges: number): { files: FileSample[]; values: number[] } {
  if (outcome === "linesPerChange") {
    const changed = files.filter((file) => file.changes > 0);
    return { files: changed, values: changed.map((file) => file.linesChurned / file.changes) };
  }
  if (outcome === "fixShare") {
    const busy = files.filter((file) => file.changes >= minChanges);
    return { files: busy, values: busy.map((file) => file.fixes / file.changes) };
  }
  return { files: [...files], values: files.map((file) => file[outcome]) };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Each measure against each outcome. A correlation is taken within a period and never across periods, so that a
 * repository that grew and got busier over the years does not show that as a link between size and change.
 * A period with fewer than `minFiles` files for an outcome is left out of that outcome.
 */
export function correlate(periods: readonly (readonly FileSample[])[], minFiles: number, minChanges: number): Correlation[] {
  const out: Correlation[] = [];
  for (const outcome of OUTCOMES) {
    const sums = new Map<MeasureId, { raw: number; rawN: number; part: number; partN: number; n: number; periods: number }>(MEASURES.map((measure) => [measure, { raw: 0, rawN: 0, part: 0, partN: 0, n: 0, periods: 0 }]));
    for (const period of periods) {
      const { files, values } = population(outcome, period, minChanges);
      if (files.length < minFiles) continue;
      const y = ranks(values);
      const control = ranks(files.map((file) => file.codeLines));
      for (const measure of MEASURES) {
        const x = ranks(files.map((file) => file[measure]));
        const sum = sums.get(measure)!;
        sum.n += files.length;
        sum.periods++;
        const raw = pearson(x, y);
        if (raw !== null) {
          sum.raw += raw * files.length;
          sum.rawN += files.length;
        }
        const held = measure === "codeLines" ? null : partial(x, y, control);
        if (held !== null) {
          sum.part += held * files.length;
          sum.partN += files.length;
        }
      }
    }
    for (const measure of MEASURES) {
      const sum = sums.get(measure)!;
      out.push({
        outcome,
        measure,
        correlation: sum.rawN === 0 ? null : round3(sum.raw / sum.rawN),
        partialOnCodeLines: sum.partN === 0 ? null : round3(sum.part / sum.partN),
        fileSamples: sum.n,
        periods: sum.periods,
      });
    }
  }
  return out;
}
