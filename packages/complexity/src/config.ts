import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { compileFixClassifier, type FixClassifier } from "@code-health/history/fix-commits";
import { compileGlobs } from "@code-health/history/glob";
import { InvalidPatternError } from "@code-health/history/noise";
import { profiles } from "@code-health/lexical/profile";
import { defaultGuidelines, isMetricId, metricIds, type MetricId, type Guidelines } from "./metrics.ts";
import { TOOL } from "./tool.ts";

/**
 * The `complexity` section of code-health.json. These defaults define its shape: unknown keys are
 * rejected and values keep the type of their default.
 */
export const complexityConfig: PluginConfigSpec = {
  plugin: TOOL,
  history: ["windowMonths", "maxChangesetSize", "botPatterns", "fixPatterns", "revertPatterns", "fixMatchBody"],
  section: {
    /** Metrics reported and ranked. `--metrics` narrows them for one run. */
    metrics: [...metricIds],
    /**
     * Guidelines for investigation. A metric is above its guideline when its value is above it, and `high` marks a second band. They label and order results and
     * hide nothing. Only `check` turns them into an exit code, and only for new or worsened units. Defaults: cyclomatic 10 and 20, cognitive 15 and 25, nesting 4 and parameters 5 are judgement calls
     * (CodeScene's default for cyclomatic is 9 and for parameters 4); bumps 3 and deepBumps 2 are judgement calls beside CodeScene's 2 bumps at depth 2.
     */
    guidelines: {
      cyclomatic: { ...defaultGuidelines.cyclomatic },
      cognitive: { ...defaultGuidelines.cognitive },
      nesting: defaultGuidelines.nesting,
      parameters: defaultGuidelines.parameters,
      /** A function with this many bumps or more is labelled a bumpy road. */
      bumps: defaultGuidelines.bumps,
      /** The count that makes a bumpy road when the deepest bump is deeper than `nesting`. */
      deepBumps: defaultGuidelines.deepBumps,
    },
    /** `case` counts every case of a switch toward cyclomatic complexity, `modified` counts one per switch. */
    cyclomaticSwitch: "case",
    /** Base revision of `check`. null is the merge base with `mainBranch`. */
    base: null,
    /** The branch `check` forks from. null tries origin/main, main, origin/master and master. */
    mainBranch: null,
    /** `check` exits 1 for a unit above a guideline that worsened by more than this on that metric. `check` is the gate, so this is the only place a guideline becomes an exit code. */
    delta: 0,
    /** Exact-boundary agreement a lexer profile must reach for its per-function metrics to be reported. */
    agreementBar: 0.9,
    /** Body similarity, 0 to 1, at which a unit that disappeared and one that appeared are the same unit moved or renamed. */
    moveSimilarity: 0.8,
    /** Analyse test files. They are ranked among themselves. */
    analyseTests: true,
    /** Weight the ranking by how often each file changed in the window, so code that never changes ranks last. */
    changeWeighting: true,
    /** `{ "paths": [globs], "guidelines": { ...partial guidelines } }`, the last matching entry winning per metric. */
    overrides: [],
    /** The post-edit hook, off unless a repository turns it on. It uses `guidelines`, `delta`, `analyseTests` and `agreementBar`. */
    hook: { enabled: false },
    /**
     * `complexity fixes` and `analyse --with-fixes`. `maxCommits` bounds how many commits of the history window are parsed, newest first, and the output says how many were left out:
     * 500 is a judgement call about run time, not calibrated on a corpus. `evidence` is how many fix commits are listed per function.
     */
    fixes: { maxCommits: 500, evidence: 3 },
    /** `shallow`: a guideline of 10, a judgement call not calibrated on a corpus. An exported function, class or module with fewer syntax nodes than this per element of its interface is labelled shallow. Rows are ordered by depth whatever the guideline. */
    interfaceDepth: { shallow: 10 },
  },
};

export interface GuidelineOverride {
  matches: (path: string) => boolean;
  guidelines: unknown;
}

export interface ComplexitySettings {
  metrics: MetricId[];
  guidelines: Guidelines;
  overrides: GuidelineOverride[];
  cyclomaticSwitch: "case" | "modified";
  base: string | null;
  mainBranch: string | null;
  delta: number;
  agreementBar: number;
  moveSimilarity: number;
  analyseTests: boolean;
  changeWeighting: boolean;
  /** The shared history settings: the window, the largest changeset kept and the author patterns left out. */
  windowMonths: number;
  maxChangesetSize: number;
  botPatterns: string[];
  /** The shared definition of a fix commit: `history.fixPatterns`, `revertPatterns` and `fixMatchBody`. */
  fix: FixClassifier;
  /** The opt-in post-edit hook. */
  hook: { enabled: boolean };
  /** Defaults of `--max-commits` and `--evidence` for the per-function fix statistics. */
  fixes: { maxCommits: number; evidence: number };
  /** Nodes per interface element below which an exported unit is labelled shallow. */
  shallowDepth: number;
  /** The suite's shared `exclude` globs. */
  isExcluded: (path: string) => boolean;
  /** The suite's shared `languages`: file extension to lexer profile name. Per-function values from them are unverified. */
  languageProfiles: Record<string, string>;
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

  const guidelines = readGuidelines(section.guidelines, at("guidelines"), number);
  const overrides = readOverrides(section.overrides, at("overrides"), number, guidelines);

  return {
    metrics,
    guidelines,
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
    maxChangesetSize: number(section.maxChangesetSize, at("maxChangesetSize"), 1),
    botPatterns: section.botPatterns as string[],
    fix: readFixClassifier(section),
    hook: { enabled: (section.hook as { enabled: boolean }).enabled === true },
    fixes: {
      maxCommits: number((section.fixes as { maxCommits: unknown }).maxCommits, at("fixes.maxCommits"), 1),
      evidence: number((section.fixes as { evidence: unknown }).evidence, at("fixes.evidence"), 0),
    },
    shallowDepth: number((section.interfaceDepth as { shallow: unknown }).shallow, at("interfaceDepth.shallow"), 0),
    isExcluded: compileGlobs(config.effective.exclude),
    languageProfiles: readLanguageProfiles(config.effective.languages),
  };
}

function readFixClassifier(section: Record<string, unknown>): FixClassifier {
  try {
    return compileFixClassifier({
      fixPatterns: section.fixPatterns as string[],
      revertPatterns: section.revertPatterns as string[],
      fixMatchBody: section.fixMatchBody === true,
    });
  } catch (error) {
    if (error instanceof InvalidPatternError) throw configError(`code-health.json: ${error.message}`);
    throw error;
  }
}

function readLanguageProfiles(languages: Record<string, string>): Record<string, string> {
  for (const [extension, name] of Object.entries(languages)) {
    if (!(name in profiles)) {
      throw configError(`code-health.json: languages.${extension} names the lexer profile "${name}", which does not exist: use one of ${Object.keys(profiles).join(", ")}`);
    }
  }
  return languages;
}

type NumberReader = (value: unknown, key: string, min: number, max?: number) => number;

function readGuidelines(value: unknown, where: string, number: NumberReader): Guidelines {
  const source = value as Guidelines;
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
    bumps: number(source.bumps, `${where}.bumps`, 1),
    deepBumps: number(source.deepBumps, `${where}.deepBumps`, 1),
  };
}

function readOverrides(value: unknown, where: string, number: NumberReader, global: Guidelines): GuidelineOverride[] {
  if (!Array.isArray(value)) throw configError(`code-health.json: ${where} must be an array`);
  return value.map((entry, index) => {
    const here = `${where}[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.paths) || entry.paths.some((glob) => typeof glob !== "string")) {
      throw configError(`code-health.json: ${here} needs "paths", an array of globs, and "guidelines"`);
    }
    if (!isRecord(entry.guidelines)) throw configError(`code-health.json: ${here}.guidelines must be an object`);
    // Validate the shape now by merging over the global guidelines, so a typo or a high below warn fails at load time and not mid-run.
    const merged = mergeGuidelines(global, entry.guidelines, `${here}.guidelines`, number);
    for (const name of ["cyclomatic", "cognitive"] as const) {
      if (merged[name].high < merged[name].warn) {
        throw configError(`code-health.json: ${here}.guidelines.${name}.high must not be below warn (${merged[name].warn}); set both when raising warn`);
      }
    }
    return { matches: compileGlobs(entry.paths as string[]), guidelines: entry.guidelines };
  });
}

function mergeGuidelines(base: Guidelines, patch: unknown, where: string, number: NumberReader): Guidelines {
  if (!isRecord(patch)) throw configError(`code-health.json: ${where} must be an object`);
  const merged: Guidelines = { cyclomatic: { ...base.cyclomatic }, cognitive: { ...base.cognitive }, nesting: base.nesting, parameters: base.parameters, bumps: base.bumps, deepBumps: base.deepBumps };
  for (const [key, entry] of Object.entries(patch)) {
    if (key === "cyclomatic" || key === "cognitive") {
      if (!isRecord(entry)) throw configError(`code-health.json: ${where}.${key} must be an object with warn and high`);
      for (const [level, limit] of Object.entries(entry)) {
        if (level !== "warn" && level !== "high") throw configError(`code-health.json: ${where}.${key}.${level} is an unknown setting`);
        merged[key][level] = number(limit, `${where}.${key}.${level}`, 0);
      }
    } else if (key === "nesting" || key === "parameters") {
      merged[key] = number(entry, `${where}.${key}`, 0);
    } else if (key === "bumps" || key === "deepBumps") {
      merged[key] = number(entry, `${where}.${key}`, 1);
    } else {
      throw configError(`code-health.json: ${where}.${key} is an unknown setting`);
    }
  }
  return merged;
}

/** The guidelines for a path: the defaults of the config with every matching override applied in order. */
export function guidelinesFor(settings: ComplexitySettings, path: string): Guidelines {
  let guidelines = settings.guidelines;
  for (const override of settings.overrides) {
    if (override.matches(path)) guidelines = mergeGuidelines(guidelines, override.guidelines, "override", (value) => value as number);
  }
  return guidelines;
}
