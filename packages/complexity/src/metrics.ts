import type { UnitMetrics } from "@code-health/parse/facts";

/**
 * The metrics, in tie-break order: when a unit ranks equally on two, the earlier one is named as dominant.
 * The structural layer provides every metric but `keyword`, and the lexical layer `keyword`, `bumps`, `length` and
 * `nesting`, so a unit has the metrics of the layer that measured it.
 */
export const metricIds = ["cognitive", "cyclomatic", "nesting", "parameters", "length", "keyword", "bumps"] as const;
export type MetricId = (typeof metricIds)[number];
export type Values = Partial<Record<MetricId, number>>;

export const metricSummaries: Record<MetricId, string> = {
  cognitive: "Cognitive complexity (SonarSource): how hard the function is to read",
  cyclomatic: "Cyclomatic complexity (McCabe): independent paths, a measure of testability",
  nesting: "Deepest nesting of control structures",
  parameters: "Declared parameters, a destructured options parameter counting once",
  length: "Lines of code, blank and comment lines excluded. Reported and ranked, never gated",
  keyword: "Branch keywords and short-circuit operators, a lexical approximation of cyclomatic complexity",
  bumps: "Separate chunks of nested logic, the count behind the bumpy road label",
};

export interface CyclomaticSwitchMode {
  /** `case` counts every case, `modified` counts one per switch. */
  mode: "case" | "modified";
}

export function isMetricId(value: string): value is MetricId {
  return (metricIds as readonly string[]).includes(value);
}

export function structuralValues(metrics: UnitMetrics, switchMode: CyclomaticSwitchMode["mode"]): Values {
  return {
    cyclomatic: switchMode === "case" ? metrics.cyclomatic : metrics.cyclomaticModified,
    cognitive: metrics.cognitive,
    nesting: metrics.nesting,
    length: metrics.length,
    parameters: metrics.parameters,
    bumps: metrics.bumps,
  };
}

export interface Guidelines {
  cyclomatic: { warn: number; high: number };
  cognitive: { warn: number; high: number };
  nesting: number;
  parameters: number;
  /** A function with this many bumps or more is a bumpy road. */
  bumps: number;
  /** A function with this many bumps or more is a bumpy road when its deepest bump is deeper than `nesting`. */
  deepBumps: number;
}

export const defaultGuidelines: Guidelines = {
  cyclomatic: { warn: 10, high: 20 },
  cognitive: { warn: 15, high: 25 },
  nesting: 4,
  parameters: 5,
  bumps: 3,
  deepBumps: 2,
};

/** Metrics a guideline applies to. Length has none, and the lexical metrics are labelled by the bumpy road rule. */
export const gatedMetrics = ["cyclomatic", "cognitive", "nesting", "parameters"] as const;
export type GatedMetric = (typeof gatedMetrics)[number];

/** The value above which a metric is over its guideline: the warn level, since only labels use `high`. */
export function limitOf(guidelines: Guidelines, metric: GatedMetric): number {
  const guideline = guidelines[metric];
  return typeof guideline === "number" ? guideline : guideline.warn;
}

/** Gated metrics whose value is above the guideline. */
export function exceeded(values: Values, guidelines: Guidelines): GatedMetric[] {
  return gatedMetrics.filter((metric) => {
    const value = values[metric];
    return value !== undefined && value > limitOf(guidelines, metric);
  });
}

/** Labels such as `cognitive-high` or `nesting-warn`, in metric order, plus `bumpy-road` for a unit whose bumps cross the guideline. */
export function labelsFor(values: Values, guidelines: Guidelines, bumpyRoad: boolean): string[] {
  const labels: string[] = [];
  for (const metric of gatedMetrics) {
    const value = values[metric];
    if (value === undefined) continue;
    const guideline = guidelines[metric];
    if (typeof guideline === "number") {
      if (value > guideline) labels.push(`${metric}-warn`);
    } else if (value > guideline.high) labels.push(`${metric}-high`);
    else if (value > guideline.warn) labels.push(`${metric}-warn`);
  }
  if (bumpyRoad) labels.push("bumpy-road");
  return labels;
}

/** The deepest-bump and count limits of the bumpy road rule, as the lexical rule reads them. */
export function bumpyRoadLimits(guidelines: Guidelines): { bumps: number; deepBumps: number; nesting: number } {
  return { bumps: guidelines.bumps, deepBumps: guidelines.deepBumps, nesting: guidelines.nesting };
}
