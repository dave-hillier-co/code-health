import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { configError } from "@code-health/cli-kit/errors";
import { TOOL } from "./tool.ts";

/**
 * The `locality` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default.
 * Entry points, exclusions and vague names live in the suite-wide part of the file.
 */
export const localityConfig: PluginConfigSpec = {
  plugin: TOOL,
  history: ["windowMonths", "maxChangesetSize", "botPatterns"],
  section: {
    /** Guideline for the net distance a move saves, in folder hops. Ranks and annotates candidates (`guidelines.gain`); units below it are counted in `summary.placed`, not listed. A judgement call. */
    minDistance: 2,
    /** Guideline: a unit of at most this many lines is tiny, its import overhead outweighing its content. A judgement call. */
    tinyLines: 15,
    /** Guideline: a unit of more than this many lines is large and stays a module of its own. A judgement call. */
    largeLines: 150,
    /** Guideline: a medium unit is inlined only while its consumer plus the unit stay within this many lines. A judgement call. */
    inlineHostLines: 300,
    /** Guideline for distinct production consumer files: a unit at or above it is worth scrutinising instead of moving. Reported as `guidelines.fanIn`. A judgement call. */
    highFanIn: 8,
    /** Deepest folder nesting a target may have. A judgement call: a depth cap stops code being buried to lower its distance. */
    maxDepth: 6,
    /** Guideline: a unit of more than this many files is a folder, and moving a folder reorganises the code base instead of relocating one module. Such a unit is not proposed as a move: it is counted in `summary.omitted` and listed in `omitted`. A judgement call: 20 is above the largest multi-file units that looked like single modules in Orleans (19 files) and below the folders Solent proposed moving whole (58 and 76 files). */
    maxMoveFiles: 20,
    /** Guideline: a target shallower than this depth that is an ancestor of the unit (the repository root, or a top-level folder such as src or pkg) is a root. A unit of more than one file is not moved up to a root: it is counted in `summary.omitted` and listed in `omitted`. A single file still moves to a root, because that is where its consumers' lowest common ancestor can be. A judgement call. */
    minTargetDepth: 2,
    /** Read co-change, age and churn from the history cache, so the history guards and rules can fire. */
    useHistory: true,
    /** Guideline: a unit younger than this many days is reviewed, not inlined or moved, because one callsite is only evidence once reuse has had time. A judgement call. */
    graceDays: 90,
    /** Guideline: consumers co-changing at or below this degree (percent) look independent, which suggests coincidental reuse. A judgement call. */
    lowCoChange: 10,
    /** Guideline: consumers co-changing at or above this degree (percent) share a reason to change, so the distance looks earned. Matches the 30 to 50 percent range Tornhill gives for coupling degree. */
    highCoChange: 40,
    /** Floor: logical changes touching any of the consumers that the co-change rules need before they read the degree. A degree from fewer is not meaningful, so it is reported as null. */
    minCoChangeChanges: 6,
    /** History-only floor: shared logical changes a partner needs before it counts as a consumer. 5 matches cochange.minSupport and code-maat's default. A coupling from fewer is not meaningful. */
    historyMinSupport: 5,
    /** History-only guideline: percent of a unit's changes that also touch a partner for it to count as a consumer. 30 matches cochange.minDegree and code-maat's default. */
    historyMinConfidence: 30,
    /** Floor: `measure compare` concludes nothing from fewer than this many tasks, or measured changes, in any of its four figures, and reports the observed direction as low confidence. A judgement call. */
    measureMinSamples: 10,
    /** Guideline: `measure compare` calls a difference no change when it is within this percent of the acted-on files' own starting figure. It reports the percent and its ratio to this guideline. A judgement call. */
    measureNoisePercent: 10,
    /** Guideline (a judgement call): when more than this percent of the C and C++ includes found no file, a warning is printed on stderr and a notice goes in the output, because consumers, and every result drawn from them, are incomplete. Units whose results rest on an include that found no file are marked low confidence whatever the share. Nothing is hidden. */
    unresolvedIncludePercent: 20,
    /** Globs of files that must not move and folders code may not move into (routes, migrations, app folders). */
    fixedPoints: [] as string[],
  },
};

export interface LocalitySettings {
  minDistance: number;
  tinyLines: number;
  largeLines: number;
  inlineHostLines: number;
  highFanIn: number;
  maxDepth: number;
  /** Units of more files than this are not proposed as moves. */
  maxMoveFiles: number;
  /** A target shallower than this that is an ancestor of the unit is a root, and a unit of several files is not moved up to it. */
  minTargetDepth: number;
  fixedPoints: string[];
  useHistory: boolean;
  graceDays: number;
  /** The shared history settings: the window, the largest changeset kept and the author patterns left out. */
  windowMonths: number;
  maxChangesetSize: number;
  botPatterns: string[];
  lowCoChange: number;
  highCoChange: number;
  minCoChangeChanges: number;
  historyMinSupport: number;
  historyMinConfidence: number;
  measureMinSamples: number;
  measureNoisePercent: number;
  /** Percent of C and C++ includes that found no file above which a warning and a notice are given. */
  unresolvedIncludePercent: number;
  /** The suite's shared `includeRoots`: directories C and C++ includes are tried against. */
  includeRoots: string[];
  /** The suite's shared `entryPoints` globs. Empty means entries are detected. */
  entryPoints: string[];
  /** The suite's shared `exclude` globs. */
  exclude: string[];
  /** The suite's shared `vagueNames`. */
  vagueNames: string[];
}

/** Validates the effective locality section and returns it typed. Throws a config error (exit 2). */
export function readSettings(config: LoadedConfig): LocalitySettings {
  const section = config.effective[TOOL] as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.${key}`;

  const positive = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw configError(`code-health.json: ${at(key)} must be a positive integer`);
    }
    return value;
  };

  const fixedPoints = section.fixedPoints;
  if (!Array.isArray(fixedPoints) || fixedPoints.some((item) => typeof item !== "string")) {
    throw configError(`code-health.json: ${at("fixedPoints")} must be an array of strings`);
  }
  const tinyLines = positive("tinyLines");
  const largeLines = positive("largeLines");
  if (tinyLines >= largeLines) {
    throw configError(`code-health.json: ${at("tinyLines")} must be below ${at("largeLines")}`);
  }

  const percent = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw configError(`code-health.json: ${at(key)} must be a percentage from 0 to 100`);
    }
    return value;
  };
  const lowCoChange = percent("lowCoChange");
  const highCoChange = percent("highCoChange");
  if (lowCoChange >= highCoChange) {
    throw configError(`code-health.json: ${at("lowCoChange")} must be below ${at("highCoChange")}`);
  }

  return {
    minDistance: positive("minDistance"),
    tinyLines,
    largeLines,
    inlineHostLines: positive("inlineHostLines"),
    highFanIn: positive("highFanIn"),
    maxDepth: positive("maxDepth"),
    maxMoveFiles: positive("maxMoveFiles"),
    minTargetDepth: positive("minTargetDepth"),
    fixedPoints: fixedPoints as string[],
    useHistory: section.useHistory === true,
    graceDays: positive("graceDays"),
    windowMonths: positive("windowMonths"),
    maxChangesetSize: positive("maxChangesetSize"),
    botPatterns: section.botPatterns as string[],
    lowCoChange,
    highCoChange,
    minCoChangeChanges: positive("minCoChangeChanges"),
    historyMinSupport: positive("historyMinSupport"),
    historyMinConfidence: percent("historyMinConfidence"),
    measureMinSamples: positive("measureMinSamples"),
    measureNoisePercent: percent("measureNoisePercent"),
    unresolvedIncludePercent: percent("unresolvedIncludePercent"),
    includeRoots: config.effective.includeRoots,
    entryPoints: config.effective.entryPoints,
    exclude: config.effective.exclude,
    vagueNames: config.effective.vagueNames,
  };
}
