import { withAncestors } from "@code-health/graph/folders";
import { folderOf } from "@code-health/graph/tree-distance";
import { isCodePath } from "@code-health/parse/code-files";
import { guidelinesFor, type ComplexitySettings } from "./config.ts";
import { meanDepth } from "./interface-depth.ts";
import type { FileRecord } from "./measure.ts";
import { topLevelUnits } from "./rows.ts";

/**
 * Size and cyclomatic complexity of the production code under one folder, the folder's subfolders included. The
 * repository is the folder `""`. The function figures cover the functions a grammar measured: a file read by the
 * lexical layer alone adds its code lines and no function.
 */
export interface FolderMeasures {
  /** Production code files under the folder. */
  files: number;
  /** Lines of code in those files, blank and comment lines excluded. */
  codeLines: number;
  /** Functions with a cyclomatic complexity, a nested function counted in the function that holds it. */
  functions: number;
  /** Sum of their cyclomatic complexity. */
  cyclomatic: number;
  /** The largest cyclomatic complexity of one of them, or null with no function. */
  maxCyclomatic: number | null;
  /** How many are above the `warn` guideline for cyclomatic complexity that applies to their path. */
  aboveGuideline: number;
  /** Sum of weight over the functions, where a function's weight is its cyclomatic complexity times the square root of its code lines. */
  weight: number;
  /** The part of `weight` that belongs to the functions above the guideline. */
  weightAbove: number;
  /** `cyclomatic` divided by `functions`, or null with no function. */
  meanCyclomatic: number | null;
  /** `weightAbove` divided by `weight`, from 0 to 1, or null with no function. */
  shareAbove: number | null;
}

/** A function's weight in the share: complexity counts in full and size by its square root, so a long simple function weighs little. */
export function weightOf(cyclomatic: number, codeLines: number): number {
  return cyclomatic * Math.sqrt(Math.max(codeLines, 1));
}

function empty(): FolderMeasures {
  return { files: 0, codeLines: 0, functions: 0, cyclomatic: 0, maxCyclomatic: null, aboveGuideline: 0, weight: 0, weightAbove: 0, meanCyclomatic: null, shareAbove: null };
}

/** The production code files of a measurement: tests and files no language claims are left out. */
export function productionCode(files: readonly FileRecord[], settings: ComplexitySettings): FileRecord[] {
  return files.filter((file) => !file.test && isCodePath(file.path, settings.languageProfiles));
}

/**
 * The measures of every folder of one revision. A file belongs to its folder and to every folder above it, so
 * each folder's counts and sums are those of its subfolders and its own files, up to the repository.
 */
export function folderMeasures(files: readonly FileRecord[], settings: ComplexitySettings): Map<string, FolderMeasures> {
  const measures = new Map<string, FolderMeasures>();
  const at = (folder: string): FolderMeasures => {
    let found = measures.get(folder);
    if (found === undefined) {
      found = empty();
      measures.set(folder, found);
    }
    return found;
  };
  at("");
  for (const file of productionCode(files, settings)) {
    const limit = guidelinesFor(settings, file.path).cyclomatic.warn;
    const functions = topLevelUnits(file.units).flatMap((unit) => (unit.test || unit.values.cyclomatic === undefined ? [] : [{ cyclomatic: unit.values.cyclomatic, weight: weightOf(unit.values.cyclomatic, unit.values.length ?? 1) }]));
    for (const folder of withAncestors(folderOf(file.path))) {
      const measure = at(folder);
      measure.files++;
      measure.codeLines += file.lines.codeLines;
      for (const fn of functions) {
        measure.functions++;
        measure.cyclomatic += fn.cyclomatic;
        measure.maxCyclomatic = Math.max(measure.maxCyclomatic ?? 0, fn.cyclomatic);
        measure.weight += fn.weight;
        if (fn.cyclomatic > limit) {
          measure.aboveGuideline++;
          measure.weightAbove += fn.weight;
        }
      }
    }
  }
  for (const measure of measures.values()) {
    measure.meanCyclomatic = measure.functions === 0 ? null : measure.cyclomatic / measure.functions;
    measure.shareAbove = measure.weight === 0 ? null : measure.weightAbove / measure.weight;
  }
  return measures;
}

/** Mean interface depth of the exported functions and classes, per file, then over the production files that have any. Null with none. */
export function meanInterfaceDepth(files: readonly FileRecord[], settings: ComplexitySettings): number | null {
  const depths = productionCode(files, settings).flatMap((file) => {
    const depth = meanDepth(file);
    return depth === null ? [] : [depth];
  });
  return depths.length === 0 ? null : depths.reduce((sum, depth) => sum + depth, 0) / depths.length;
}

export interface SplitCheck {
  flagged: boolean;
  reasons: string[];
}

/**
 * Whether a fall in mean cyclomatic complexity was bought by splitting functions into shallow helpers: the mean
 * fell while there are more functions and the exported ones do less per element of their interface.
 */
export function splitCheck(before: { measures: FolderMeasures; depth: number | null }, after: { measures: FolderMeasures; depth: number | null }): SplitCheck {
  const [was, now] = [before.measures.meanCyclomatic, after.measures.meanCyclomatic];
  if (was === null || now === null || now >= was) return { flagged: false, reasons: [] };
  if (after.measures.functions <= before.measures.functions || before.depth === null || after.depth === null || after.depth >= before.depth) return { flagged: false, reasons: [] };
  return {
    flagged: true,
    reasons: [`the number of functions rose from ${before.measures.functions} to ${after.measures.functions} and mean interface depth fell from ${before.depth.toFixed(2)} to ${after.depth.toFixed(2)} while mean cyclomatic complexity fell`],
  };
}
