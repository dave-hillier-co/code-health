import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig } from "@code-health/cli-kit/config";
import { compileFixClassifier, type FixClassifier } from "@code-health/history/fix-commits";
import { InvalidPatternError } from "@code-health/history/noise";
import { TOOL } from "../tool.ts";

export const PLACEMENT_MODES = ["self", "any", "off"] as const;
export type PlacementMode = (typeof PLACEMENT_MODES)[number];

/** Factors a repository may switch off by name. Every factor of the spec is listed. */
export const FACTOR_NAMES = [
  "size",
  "spread",
  "entropy",
  "mixed-purpose",
  "hotspots-touched",
  "defect-history",
  "contention",
  "age",
  "abandoned-touched",
  "missing-co-change",
  "novel-coupling",
  "test-evidence",
  "blast-radius",
  "complexity-delta",
  "structure-delta",
  "sensitive-paths",
] as const;

/** The `cochange.risk` section of code-health.json. These defaults define its shape. */
export const riskDefaults = {
  /** Branch the default base is merged into. null looks for origin/HEAD, then main, then master. */
  mainBranch: null as string | null,
  /** A value strictly above this percentile of the baseline is `moderate`. */
  moderatePercentile: 75,
  /** A value strictly above this percentile of the baseline is `high`. */
  highPercentile: 90,
  /** The most recent merged changes that form the baseline population, within the analysis window. */
  baselineChanges: 200,
  /** Fewest changes in the baseline before a factor is banded. Below it the band is unavailable, never low. */
  minBaseline: 10,
  /** Count-based factors: the count that is `moderate`, and the count that is `high`. */
  countModerate: 1,
  countHigh: 3,
  /** `missing-co-change` and `blast-radius`: confidence towards a touched file, as a percentage. Support is `cochange.minSupport`. */
  missingConfidence: 80,
  /** `novel-coupling`: touched files at least this far apart in the tree. */
  novelDistance: 4,
  /** `age`: a file changed within this many days of the change is still settling. */
  settlingDays: 7,
  /** `test-evidence`: a sibling test counts as usually changing with its file at this percentage of the file's revisions. */
  testShare: 50,
  /** `complexity-delta` without the complexity plugin: indentation complexity gained by one file that counts as a rise. */
  complexityRise: 10,
  /** Placement: share of a file's lines (percentage) for `owner` and for `regular`. */
  ownerShare: 50,
  regularShare: 10,
  /** Placement: changes to a file within `recentMonths` of this many make an author a regular of it. */
  regularChanges: 3,
  /** Placement: changes to a file within this many months count as recent. */
  recentChangesToFile: 3,
  /** Placement: an earlier change counts for half after this many months. */
  recencyHalfLifeMonths: 12,
  /** An identity is new when its first commit is within this many days of the change, or it has fewer changes than this. */
  newIdentityDays: 90,
  newIdentityChanges: 10,
  /** Touched files matching these globs raise the `sensitive-paths` finding. */
  sensitivePaths: [
    "**/migrations/**",
    "**/auth/**",
    "**/authentication/**",
    ".github/workflows/**",
    "Dockerfile",
    "**/Dockerfile",
    "package.json",
    "**/package.json",
    "*.csproj",
    "**/*.csproj",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "pyproject.toml",
    "requirements.txt",
  ] as string[],
  /** Backtest: a fix that touches a change's files within this many days counts as trouble. */
  followUpDays: 30,
  /** Whose placement `risk` computes: `self`, `any` or `off`. */
  placement: "any" as string,
  /** Factors to switch off, by name. */
  disable: [] as string[],
};

export interface RiskSettings {
  mainBranch: string | null;
  moderatePercentile: number;
  highPercentile: number;
  baselineChanges: number;
  minBaseline: number;
  countModerate: number;
  countHigh: number;
  missingConfidence: number;
  novelDistance: number;
  settlingDays: number;
  testShare: number;
  complexityRise: number;
  ownerShare: number;
  regularShare: number;
  regularChanges: number;
  recentChangesToFile: number;
  recencyHalfLifeMonths: number;
  newIdentityDays: number;
  newIdentityChanges: number;
  sensitivePaths: string[];
  /** The shared definition of a fix commit: `history.fixPatterns`, `fixExcludePatterns`, `revertPatterns` and `fixMatchBody`, as `cochange` resolves them. */
  fix: FixClassifier;
  followUpDays: number;
  placement: PlacementMode;
  disabled: ReadonlySet<string>;
}

/** Validates `cochange.risk` and returns it typed. Throws a config error (exit 2). */
export function readRiskSettings(config: LoadedConfig): RiskSettings {
  const section = (config.effective[TOOL] as { risk: Record<string, unknown> }).risk;
  const at = (key: string) => `${TOOL}.risk.${key}`;
  const whole = (key: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw configError(`code-health.json: ${at(key)} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };
  const strings = (key: string): string[] => {
    const value = section[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw configError(`code-health.json: ${at(key)} must be an array of strings`);
    }
    return value as string[];
  };

  const branch = section.mainBranch;
  if (branch !== null && (typeof branch !== "string" || branch === "")) {
    throw configError(`code-health.json: ${at("mainBranch")} must be a branch name or null`);
  }
  const moderatePercentile = whole("moderatePercentile", 1, 99);
  const highPercentile = whole("highPercentile", 1, 99);
  if (highPercentile < moderatePercentile) {
    throw configError(`code-health.json: ${at("highPercentile")} must not be below ${at("moderatePercentile")}`);
  }
  const countModerate = whole("countModerate", 1);
  const countHigh = whole("countHigh", 1);
  if (countHigh < countModerate) throw configError(`code-health.json: ${at("countHigh")} must not be below ${at("countModerate")}`);
  const placement = section.placement;
  if (typeof placement !== "string" || !(PLACEMENT_MODES as readonly string[]).includes(placement)) {
    throw configError(`code-health.json: ${at("placement")} must be "self", "any" or "off"`);
  }
  const disable = strings("disable");
  for (const name of disable) {
    if (!(FACTOR_NAMES as readonly string[]).includes(name)) {
      throw configError(`code-health.json: ${at("disable")} names unknown factor "${name}"; factors: ${FACTOR_NAMES.join(", ")}`);
    }
  }
  const ownerShare = whole("ownerShare", 1, 100);
  const regularShare = whole("regularShare", 1, 100);
  if (regularShare > ownerShare) throw configError(`code-health.json: ${at("regularShare")} must not exceed ${at("ownerShare")}`);

  return {
    mainBranch: branch,
    moderatePercentile,
    highPercentile,
    baselineChanges: whole("baselineChanges", 10),
    minBaseline: whole("minBaseline", 1),
    countModerate,
    countHigh,
    missingConfidence: whole("missingConfidence", 1, 100),
    novelDistance: whole("novelDistance", 1),
    settlingDays: whole("settlingDays", 0),
    testShare: whole("testShare", 1, 100),
    complexityRise: whole("complexityRise", 1),
    ownerShare,
    regularShare,
    regularChanges: whole("regularChanges", 1),
    recentChangesToFile: whole("recentChangesToFile", 1),
    recencyHalfLifeMonths: whole("recencyHalfLifeMonths", 1),
    newIdentityDays: whole("newIdentityDays", 0),
    newIdentityChanges: whole("newIdentityChanges", 0),
    sensitivePaths: strings("sensitivePaths"),
    fix: readFixClassifier(config),
    followUpDays: whole("followUpDays", 1),
    placement: placement as PlacementMode,
    disabled: new Set(disable),
  };
}

/** The shared fix definition as cochange resolves it: `cochange.fixPatterns` when set, otherwise `history.fixPatterns`. */
export function readFixClassifier(config: LoadedConfig): FixClassifier {
  const section = config.effective[TOOL] as { fixPatterns: string[]; fixExcludePatterns: string[]; revertPatterns: string[]; fixMatchBody: boolean };
  try {
    return compileFixClassifier({ fixPatterns: section.fixPatterns, fixExcludePatterns: section.fixExcludePatterns, revertPatterns: section.revertPatterns, fixMatchBody: section.fixMatchBody });
  } catch (error) {
    if (error instanceof InvalidPatternError) throw configError(`code-health.json: ${error.message}`);
    throw error;
  }
}
