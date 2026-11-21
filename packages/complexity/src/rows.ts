import { thresholdsFor, type ComplexitySettings } from "./config.ts";
import type { FileRecord, UnitRecord } from "./measure.ts";
import { exceeded, labelsFor, metricIds, type MetricId, type Values } from "./metrics.ts";
import type { RankedUnit } from "./ranking.ts";

export function pick(values: Values, selected: readonly MetricId[]): Values {
  const out: Values = {};
  for (const metric of metricIds) {
    const value = values[metric];
    if (selected.includes(metric) && value !== undefined) out[metric] = value;
  }
  return out;
}

export function unitLabels(unit: UnitRecord, settings: ComplexitySettings): string[] {
  return labelsFor(unit.values, thresholdsFor(settings, unit.path), unit.bumpyRoad === true);
}

export function unitName(unit: UnitRecord): string {
  return unit.name ?? "<anonymous>";
}

/** One function of `analyse`. Metric values sit beside the identity so `--fields` can project them. */
export function unitRow(ranked: RankedUnit, selected: readonly MetricId[], settings: ComplexitySettings) {
  const { unit } = ranked;
  return {
    path: unit.path,
    unit: unitName(unit),
    id: unit.id,
    kind: unit.kind,
    startLine: unit.startLine,
    endLine: unit.endLine,
    source: unit.source,
    test: unit.test,
    score: ranked.score,
    dominant: ranked.dominant,
    ...pick(unit.values, selected),
    ...(unit.optionCount === undefined || !selected.includes("parameters") ? {} : { optionCount: unit.optionCount }),
    percentiles: pick(ranked.percentiles, selected),
    labels: unitLabels(unit, settings),
  };
}

/**
 * The units that are not inside another measured function. A nested function already adds to its parent's
 * score, so summing it again would count it twice. Classes carry no metrics, so a method is top level.
 */
export function topLevelUnits(units: readonly UnitRecord[]): UnitRecord[] {
  const ids = new Set(units.map((unit) => unit.id));
  return units.filter((unit) => {
    if (unit.source === "structural") return unit.parent === undefined || !ids.has(`${unit.path}#${unit.parent}`);
    return !units.some(
      (other) =>
        other !== unit &&
        other.startLine <= unit.startLine &&
        unit.endLine <= other.endLine &&
        (other.startLine < unit.startLine || unit.endLine < other.endLine),
    );
  });
}

type Aggregate = { sum: number; max: number };

/** One file of `files`: file-level metrics for every text file, and function aggregates where functions were measured. */
export function fileRow(file: FileRecord, settings: ComplexitySettings) {
  const top = topLevelUnits(file.units);
  const aggregates: Partial<Record<MetricId, Aggregate>> = {};
  for (const metric of metricIds) {
    const values = top.flatMap((unit) => (unit.values[metric] === undefined ? [] : [unit.values[metric]!]));
    if (values.length > 0) aggregates[metric] = { sum: values.reduce((a, b) => a + b, 0), max: Math.max(...values) };
  }
  const thresholds = thresholdsFor(settings, file.path);
  return {
    path: file.path,
    score: file.indentationComplexity,
    complexity: file.indentationComplexity,
    source: file.source,
    profile: file.profile,
    test: file.test,
    unverified: file.unverified,
    lineCount: file.lines.lineCount,
    codeLines: file.lines.codeLines,
    keywordComplexity: file.keywordComplexity ?? null,
    functions: file.units.length,
    aggregates: file.units.length === 0 ? null : aggregates,
    overThreshold: file.units.filter((unit) => exceeded(unit.values, thresholds).length > 0).length,
  };
}
