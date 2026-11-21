import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { compileGlobs } from "@code-health/history/glob";
import { defaultThresholds, isMetricId, metricIds, type MetricId, type Thresholds } from "./metrics.ts";
import { TOOL } from "./tool.ts";

/**
 * The `complexity` section of code-health.json. These defaults define its shape: unknown keys are
 * rejected and values keep the type of their default.
 */
export const complexityConfig: PluginConfigSpec = {
  plugin: TOOL,
  section: {
    /** Metrics reported and ranked. `--metrics` narrows them for one run. */
    metrics: [...metricIds],
    /** A metric is over its threshold when its value is above it. Only `warn` gates `check`; `high` only labels. */
    thresholds: {
      cyclomatic: { ...defaultThresholds.cyclomatic },
      cognitive: { ...defaultThresholds.cognitive },
      nesting: defaultThresholds.nesting,
      parameters: defaultThresholds.parameters,
    },
    /** `case` counts every case of a switch toward cyclomatic complexity, `modified` counts one per switch. */
    cyclomaticSwitch: "case",
    /** Base revision of `check`. null is the merge base with `mainBranch`. */
    base: null,
    /** The branch `check` forks from. null tries origin/main, main, origin/master and master. */
    mainBranch: null,
    /** `check` fails an over-threshold unit that worsened by more than this on a metric over its threshold. */
    delta: 0,
    /** Exact-boundary agreement a lexer profile must reach for its per-function metrics to be reported. */
    agreementBar: 0.9,
    /** Body similarity, 0 to 1, at which a unit that disappeared and one that appeared are the same unit moved or renamed. */
    moveSimilarity: 0.8,
    /** Analyse test files. They are ranked among themselves. */
    analyseTests: true,
    /** Weight the ranking by how often each file changed in the window, so code that never changes ranks last. */
    changeWeighting: true,
    /** The window for change frequency, back from HEAD's commit date. */
    windowMonths: 12,
    /** `{ "paths": [globs], "thresholds": { ...partial thresholds } }`, the last matching entry winning per metric. */
    overrides: [],
    /** The post-edit hook, off unless a repository turns it on. It uses `thresholds`, `delta`, `analyseTests` and `agreementBar`. */
    hook: { enabled: false },
  },
};

export interface ThresholdOverride {
  matches: (path: string) => boolean;
  thresholds: unknown;
}

export interface ComplexitySettings {
  metrics: MetricId[];
  thresholds: Thresholds;
  overrides: ThresholdOverride[];
  cyclomaticSwitch: "case" | "modified";
  base: string | null;
  mainBranch: string | null;
  delta: number;
  agreementBar: number;
  moveSimilarity: number;
  analyseTests: boolean;
  changeWeighting: boolean;
  windowMonths: number;
  /** The opt-in post-edit hook. */
  hook: { enabled: boolean };
  /** The suite's shared `exclude` globs. */
  isExcluded: (path: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the effective complexity section and returns it typed. Throws a config error (exit 2). */
export function readSettings(config: LoadedConfig): ComplexitySettings {
  const section = config.effective[TOOL] as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.${key}`;

  const number: NumberReader = (value, where, min, max = Infinity) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw configError(`code-health.json: ${where} must be a number from ${min}${max === Infinity ? "" : ` to ${max}`}`);
    }
    return value;
  };
  const optionalString = (key: string): string | null => {
    const value = section[key];
    if (value !== null && (typeof value !== "string" || value === "")) {
      throw configError(`code-health.json: ${at(key)} must be a revision name or null`);
    }
    return value;
  };

  const requested = section.metrics;
  if (!Array.isArray(requested) || requested.some((metric) => typeof metric !== "string" || !isMetricId(metric))) {
    throw configError(`code-health.json: ${at("metrics")} must list metrics from ${metricIds.join(", ")}`);
  }
  const metrics = metricIds.filter((metric) => (requested as string[]).includes(metric));

  if (section.cyclomaticSwitch !== "case" && section.cyclomaticSwitch !== "modified") {
    throw configError(`code-health.json: ${at("cyclomaticSwitch")} must be "case" or "modified"`);
  }

  const thresholds = readThresholds(section.thresholds, at("thresholds"), number);
  const overrides = readOverrides(section.overrides, at("overrides"), number, thresholds);

  return {
    metrics,
    thresholds,
    overrides,
    cyclomaticSwitch: section.cyclomaticSwitch,
    base: optionalString("base"),
    mainBranch: optionalString("mainBranch"),
    delta: number(section.delta, at("delta"), 0),
    agreementBar: number(section.agreementBar, at("agreementBar"), 0, 1),
    moveSimilarity: number(section.moveSimilarity, at("moveSimilarity"), 0, 1),
    analyseTests: section.analyseTests === true,
    changeWeighting: section.changeWeighting === true,
    windowMonths: number(section.windowMonths, at("windowMonths"), 1),
    hook: { enabled: (section.hook as { enabled: boolean }).enabled === true },
    isExcluded: compileGlobs(config.effective.exclude),
  };
}

type NumberReader = (value: unknown, key: string, min: number, max?: number) => number;

function readThresholds(value: unknown, where: string, number: NumberReader): Thresholds {
  const source = value as Thresholds;
  const level = (name: "cyclomatic" | "cognitive") => {
    const { warn, high } = source[name];
    const checked = { warn: number(warn, `${where}.${name}.warn`, 0), high: number(high, `${where}.${name}.high`, 0) };
    if (checked.high < checked.warn) throw configError(`code-health.json: ${where}.${name}.high must not be below warn`);
    return checked;
  };
  return {
    cyclomatic: level("cyclomatic"),
    cognitive: level("cognitive"),
    nesting: number(source.nesting, `${where}.nesting`, 0),
    parameters: number(source.parameters, `${where}.parameters`, 0),
  };
}

function readOverrides(value: unknown, where: string, number: NumberReader, global: Thresholds): ThresholdOverride[] {
  if (!Array.isArray(value)) throw configError(`code-health.json: ${where} must be an array`);
  return value.map((entry, index) => {
    const here = `${where}[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.paths) || entry.paths.some((glob) => typeof glob !== "string")) {
      throw configError(`code-health.json: ${here} needs "paths", an array of globs, and "thresholds"`);
    }
    if (!isRecord(entry.thresholds)) throw configError(`code-health.json: ${here}.thresholds must be an object`);
    // Validate the shape now by merging over the global thresholds, so a typo or a high below warn fails at load time and not mid-run.
    const merged = mergeThresholds(global, entry.thresholds, `${here}.thresholds`, number);
    for (const name of ["cyclomatic", "cognitive"] as const) {
      if (merged[name].high < merged[name].warn) {
        throw configError(`code-health.json: ${here}.thresholds.${name}.high must not be below warn (${merged[name].warn}); set both when raising warn`);
      }
    }
    return { matches: compileGlobs(entry.paths as string[]), thresholds: entry.thresholds };
  });
}

function mergeThresholds(base: Thresholds, patch: unknown, where: string, number: NumberReader): Thresholds {
  if (!isRecord(patch)) throw configError(`code-health.json: ${where} must be an object`);
  const merged: Thresholds = { cyclomatic: { ...base.cyclomatic }, cognitive: { ...base.cognitive }, nesting: base.nesting, parameters: base.parameters };
  for (const [key, entry] of Object.entries(patch)) {
    if (key === "cyclomatic" || key === "cognitive") {
      if (!isRecord(entry)) throw configError(`code-health.json: ${where}.${key} must be an object with warn and high`);
      for (const [level, limit] of Object.entries(entry)) {
        if (level !== "warn" && level !== "high") throw configError(`code-health.json: ${where}.${key}.${level} is an unknown setting`);
        merged[key][level] = number(limit, `${where}.${key}.${level}`, 0);
      }
    } else if (key === "nesting" || key === "parameters") {
      merged[key] = number(entry, `${where}.${key}`, 0);
    } else {
      throw configError(`code-health.json: ${where}.${key} is an unknown setting`);
    }
  }
  return merged;
}

/** The thresholds for a path: the defaults of the config with every matching override applied in order. */
export function thresholdsFor(settings: ComplexitySettings, path: string): Thresholds {
  let thresholds = settings.thresholds;
  for (const override of settings.overrides) {
    if (override.matches(path)) thresholds = mergeThresholds(thresholds, override.thresholds, "override", (value) => value as number);
  }
  return thresholds;
}
