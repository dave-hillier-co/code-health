import { analyseSource } from "@code-health/lexical/analyse-source";
import type { FileMeasurement } from "@code-health/history/session-state";
import { bumpyRoadLimits, type Thresholds } from "./metrics.ts";

/**
 * The metrics the hook compares, all lexical, in tie-break order. A unit's `bumpy` value is 1 when the
 * lexical layer calls it a bumpy road, and `bumps` is its count of bumps.
 */
const hookMetrics = ["nesting", "keyword", "bumps"] as const;
type HookMetric = (typeof hookMetrics)[number];

export type Measured = { measurement: FileMeasurement } | { unmeasured: string };

/**
 * The units of a file as the lexical layer measures them, by unit name, or why the file has none: no lexer
 * profile, or a profile whose agreement with the structural layer is below the bar, so its per-function
 * values may not be reported. Blocks with no name are left out, because nothing identifies them from one
 * edit to the next. A name used twice in one file gets `~2`, `~3` in order.
 */
export function measureFile(
  path: string,
  text: string,
  options: { agreementBar: number; languageProfiles: Record<string, string>; thresholds: Thresholds },
): Measured {
  const analysis = analyseSource(path, text, {
    agreementBar: options.agreementBar,
    mappings: options.languageProfiles,
    bumpyRoad: bumpyRoadLimits(options.thresholds),
  });
  if (analysis.functions.gated) return { unmeasured: analysis.functions.reason };
  // The hook states a threshold as fact, so it stays silent where nothing measures how accurate the values are.
  if (analysis.unverified) return { unmeasured: "the profile was mapped by config, so its per-function values are unverified" };
  const measurement: FileMeasurement = {};
  const seen = new Map<string, number>();
  for (const block of analysis.functions.blocks) {
    if (block.qualifiedName === undefined) continue;
    const count = (seen.get(block.qualifiedName) ?? 0) + 1;
    seen.set(block.qualifiedName, count);
    const name = count === 1 ? block.qualifiedName : `${block.qualifiedName}~${count}`;
    measurement[name] = {
      keyword: block.metrics.keywordComplexity,
      nesting: block.metrics.maxNesting,
      bumps: block.metrics.bumps,
      bumpy: block.bumpyRoad ? 1 : 0,
    };
  }
  return { measurement };
}

export interface HookFinding {
  unit: string;
  metric: HookMetric;
  /** The value in the last measurement, or null when the unit is new. */
  before: number | null;
  after: number;
  /** How far over its threshold, for choosing the worst finding. */
  overshoot: number;
  /** The threshold as the sentence states it. */
  threshold: string;
}

/**
 * The limit a metric must stay at or under, or undefined for `bumps`, which is over its limit when the
 * unit is a bumpy road. Keyword complexity counts decision points, so cyclomatic complexity is one more
 * than it, and the cyclomatic threshold is applied as that.
 */
function limitOf(metric: HookMetric, thresholds: Thresholds): number | undefined {
  if (metric === "nesting") return thresholds.nesting;
  if (metric === "keyword") return thresholds.cyclomatic.warn - 1;
  return undefined;
}

const isOver = (metric: HookMetric, values: Record<string, number>, thresholds: Thresholds): boolean => {
  const limit = limitOf(metric, thresholds);
  return limit === undefined ? values.bumpy === 1 : values[metric]! > limit;
};

/**
 * What the edit did to the units of a file: a unit that is over a threshold now and was not before (or is
 * new), or was over and rose by more than `delta`. A unit that stays under, or is over and did not get
 * worse, is not a finding, and neither is a removed one. Worst first.
 */
export function findingsFor(before: FileMeasurement, after: FileMeasurement, thresholds: Thresholds, delta: number): HookFinding[] {
  const findings: HookFinding[] = [];
  for (const [unit, values] of Object.entries(after)) {
    const earlier = before[unit];
    for (const metric of hookMetrics) {
      if (!isOver(metric, values, thresholds)) continue;
      const was = earlier?.[metric];
      if (earlier !== undefined && isOver(metric, earlier, thresholds) && values[metric]! - (was ?? 0) <= delta) continue;
      const limit = limitOf(metric, thresholds);
      findings.push({
        unit,
        metric,
        before: was ?? null,
        after: values[metric]!,
        overshoot: values[metric]! - (limit ?? 0),
        threshold: limit === undefined ? "a bumpy road" : `threshold ${limit}`,
      });
    }
  }
  return findings.sort(
    (a, b) => b.overshoot - a.overshoot || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0) || hookMetrics.indexOf(a.metric) - hookMetrics.indexOf(b.metric),
  );
}

const labels: Record<HookMetric, string> = { nesting: "nesting depth", keyword: "keyword complexity", bumps: "bumps" };

/** The one sentence: the worst finding, how many others there are, and the command that breaks the unit down when there is one. */
export function describeFindings(file: string, findings: readonly HookFinding[], explainCommand: string | undefined): string {
  const [worst, ...others] = findings as [HookFinding, ...HookFinding[]];
  const change = worst.before === null ? `is ${worst.after} in a new unit` : `rose from ${worst.before} to ${worst.after}`;
  const more = others.length === 0 ? "" : `, and ${others.length} more ${others.length === 1 ? "finding" : "findings"} in this file`;
  const pointer = explainCommand === undefined ? "" : ` Run \`${explainCommand} ${file}#${worst.unit}\` for the breakdown.`;
  return `${file}: \`${worst.unit}\` ${labels[worst.metric]} ${change} (${worst.threshold})${more}.${pointer}`;
}
