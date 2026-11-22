import { changeSpread, percentile } from "@code-health/cochange/spread-measure";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import { summariseShell, type ShellSummary } from "@code-health/transcripts/measure-repo";

/** The cost figures tested against distance. `foldersVisited` is left out: it is distance by another name. */
export const PREMISE_FIGURES = ["filesRead", "reReads", "tokens"] as const;
export type PremiseFigure = (typeof PREMISE_FIGURES)[number];

export type FigureConclusion = "costlier-when-distant" | "cheaper-when-distant" | "no-relationship-shown" | "insufficient-sample" | "not-measured";
export type PremiseVerdict = "supported" | "partly-supported" | "contradicted" | "mixed" | "not-shown" | "not-measured" | "insufficient-sample";

export interface Group {
  tasks: number;
  mean: number | null;
}

export interface FigureResult {
  /** Tasks the figure rests on. */
  n: number;
  /** Rank correlation of the task's distance with the cost. */
  spearman: number | null;
  /** The same with the number of files edited held constant, since bigger tasks both spread further and read more. */
  partialSpearman: number | null;
  /** Fisher z of the partial correlation: beyond 1.96 either way, chance is an unlikely explanation. */
  z: number | null;
  /** Tasks at or below the median distance. */
  near: Group;
  /** Tasks above the median distance. */
  far: Group;
  conclusion: FigureConclusion;
}

export interface PremiseResult {
  tasks: { inWindow: number; measured: number; singleFile: number };
  distance: { mean: number | null; median: number | null; max: number | null };
  figures: Record<PremiseFigure, FigureResult>;
  /** Bash calls over the tasks in window, and the share parsed. Reported whatever the effort mode, so a reader sees how much of the shell the figures could see. */
  shell: ShellSummary;
  verdict: PremiseVerdict;
}

const Z_CRITICAL = 1.96;

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length);

/** Ranks from 1, tied values sharing the mean of their positions. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const result = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end++;
    const rank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) result[order[i]!.index] = rank;
    start = end + 1;
  }
  return result;
}

/** Pearson correlation, or null when either side does not vary. */
function pearson(x: readonly number[], y: readonly number[]): number | null {
  const mx = mean(x);
  const my = mean(y);
  if (mx === null || my === null) return null;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** Spearman correlation: Pearson on the ranks. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  return pearson(ranks(x), ranks(y));
}

/** Spearman correlation of x and y with z held constant, from the three pairwise correlations. */
export function partialSpearman(x: readonly number[], y: readonly number[], z: readonly number[]): number | null {
  const xy = spearman(x, y);
  if (xy === null) return null;
  const xz = spearman(x, z);
  const yz = spearman(y, z);
  // A control that does not vary controls nothing.
  if (xz === null || yz === null) return xy;
  const denominator = Math.sqrt((1 - xz * xz) * (1 - yz * yz));
  if (denominator === 0) return null;
  return (xy - xz * yz) / denominator;
}

/** Fisher z for a correlation holding one variable constant. Null when too few tasks to say. */
function fisherZ(r: number, n: number): number | null {
  if (n < 5) return null;
  const clamped = Math.max(-0.999999, Math.min(0.999999, r));
  return Math.atanh(clamped) * Math.sqrt(n - 4);
}

const costOf = (task: TaskEffort, figure: PremiseFigure): number => (figure === "tokens" ? task.tokens.total : task[figure]);

function conclude(n: number, minSamples: number, partial: number | null, z: number | null): FigureConclusion {
  if (n < minSamples) return "insufficient-sample";
  if (partial === null || z === null) return "not-measured";
  if (Math.abs(z) < Z_CRITICAL) return "no-relationship-shown";
  return partial > 0 ? "costlier-when-distant" : "cheaper-when-distant";
}

function verdictOf(conclusions: readonly FigureConclusion[]): PremiseVerdict {
  if (conclusions.every((c) => c === "insufficient-sample")) return "insufficient-sample";
  // No figure could be tested, because distance or cost never varied: that is not a test that found nothing.
  if (conclusions.every((c) => c === "insufficient-sample" || c === "not-measured")) return "not-measured";
  const costlier = conclusions.filter((c) => c === "costlier-when-distant").length;
  const cheaper = conclusions.filter((c) => c === "cheaper-when-distant").length;
  if (costlier > 0 && cheaper > 0) return "mixed";
  if (cheaper > 0) return "contradicted";
  if (costlier >= 2) return "supported";
  if (costlier === 1) return "partly-supported";
  return "not-shown";
}

/**
 * Tests whether tasks whose edited files lie further apart cost more. A task's distance is the change spread of the
 * files it edited (mean pairwise tree distance), so a task with fewer than two edited files has none and is left out.
 * Everything rests on observed tasks, so the result is an association, not a cause.
 */
export function testPremise(tasks: readonly TaskEffort[], minSamples: number): PremiseResult {
  const measured = tasks.filter((task) => task.editedPaths.length >= 2);
  const distances = measured.map((task) => changeSpread(task.editedPaths));
  const median = percentile(distances, 0.5);
  const sizes = measured.map((task) => task.filesEdited);

  const figures = {} as Record<PremiseFigure, FigureResult>;
  for (const figure of PREMISE_FIGURES) {
    const costs = measured.map((task) => costOf(task, figure));
    const partial = partialSpearman(distances, costs, sizes);
    const z = partial === null ? null : fisherZ(partial, measured.length);
    const near = costs.filter((_, i) => distances[i]! <= (median as number));
    const far = costs.filter((_, i) => distances[i]! > (median as number));
    figures[figure] = {
      n: measured.length,
      spearman: spearman(distances, costs),
      partialSpearman: partial,
      z,
      near: { tasks: near.length, mean: mean(near) },
      far: { tasks: far.length, mean: mean(far) },
      conclusion: conclude(measured.length, minSamples, partial, z),
    };
  }

  return {
    tasks: { inWindow: tasks.length, measured: measured.length, singleFile: tasks.length - measured.length },
    distance: { mean: mean(distances), median, max: distances.length === 0 ? null : Math.max(...distances) },
    figures,
    shell: summariseShell(tasks),
    verdict: verdictOf(PREMISE_FIGURES.map((figure) => figures[figure].conclusion)),
  };
}
