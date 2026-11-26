import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { configError, usageError, CliError, ExitCode } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { identityFiles } from "@code-health/history/identity-decisions";

const TOOL = "cochange";

export const RANK_MODES = ["hotspot", "abandonment"] as const;
export type RankMode = (typeof RANK_MODES)[number];

/**
 * The `cochange.knowledge` section of code-health.json. Everything in the
 * abandonment analysis is off until `enabled` is true, because it reasons about
 * people (see the privacy rules of the abandonment spec).
 */
export const KNOWLEDGE_DEFAULTS = {
  enabled: true,
  /** Months without a commit after which a developer counts as having left. */
  activityWindowMonths: 6,
  /** Months in one period of the turnover rate. */
  periodMonths: 3,
  /** Periods the simulation looks ahead. */
  horizonPeriods: 4,
  /** A file is abandoned when at least this percentage of the lines held by people belong to people who have left. */
  abandonmentGuideline: 90,
  /** Per-period turnover, as a percentage (15 is 15 percent, not 0.15). null estimates it from history. */
  turnoverRate: null as number | null,
  /** A turnover rate estimated from fewer observed periods than this is called a weak estimate. A judgement call. */
  minTurnoverPeriods: 4,
  /** Results are labelled as depending on unmapped identities when settled identities hold less than this percentage of the lines held by people. A judgement call. */
  mappedShareGuideline: 80,
  /**
   * The loss figures are labelled an upper bound when the mean probability that an active developer leaves over the horizon
   * reaches this percentage. A judgement call: from one half on, a typical trial already loses most of the team, so the
   * expected loss is close to the worst case and the tail ratio is close to 1.
   */
  leaverProbabilityGuideline: 50,
  /** `abandonment trend` notes points whose measured files or active developers differ from the point before by at least this percentage. A judgement call. */
  populationChangeGuideline: 25,
  trials: 10_000,
  /** Percentiles of the loss distribution reported as knowledge at risk. */
  alphas: [95, 99],
  seed: 1,
  rank: "hotspot",
  /** Follow lines moved or copied between files (`git blame -C`). Slow on a large repository. */
  copyDetection: true,
  /** A file whose abandonment probability reaches this percentage is at risk. */
  atRiskProbability: 10,
  /** A component whose tail ratio reaches this is concentrated. The paper found losses more than three times the expected loss in the tail. */
  concentratedTailRatio: 3,
  // Knowledge-risk patterns (`abandonment patterns`). Every value below is a guideline: it labels and orders files and hides none.
  /** A file has a single owner when one active developer holds at least this percentage of the lines held by people. A judgement call. */
  singleOwnerShare: 90,
  /** Complex code by former contributors: developers who have left hold at least this percentage of the lines held by people. A judgement call. */
  formerContributorShare: 50,
  /** A file is complex for the patterns when its complexity is at or above this percentile of the scored files. A judgement call. */
  complexityPercentile: 75,
  /** Many active developers: at least this many active developers each hold a meaningful share. A judgement call. */
  manyActiveAuthors: 5,
  /** A meaningful share, as a percentage of the lines held by people. A judgement call. */
  meaningfulShare: 5,
  /** A file is inconclusive when lines of bots, services, agents, unknown commits and unmapped identities are at least this percentage of its lines. A judgement call. */
  inconclusiveShare: 50,
  /** The bus factor of a file is the fewest active developers who together hold this percentage of the lines held by people. A judgement call. */
  busFactorShare: 80,
};

export interface KnowledgeSettings {
  enabled: boolean;
  activityWindowMonths: number;
  periodMonths: number;
  horizonPeriods: number;
  /** Percentage, 1 to 100. */
  abandonmentGuideline: number;
  /** Per-period turnover as a fraction (0 to 1), or null to estimate it from history. The configured percentage divided by 100. */
  turnoverRate: number | null;
  /** The configured percentage as written, 0 to 100, or null. */
  turnoverRatePercent: number | null;
  minTurnoverPeriods: number;
  /** Percentage, 0 to 100. */
  mappedShareGuideline: number;
  /** Percentage, 0 to 100. */
  leaverProbabilityGuideline: number;
  /** Percentage, 0 or more. */
  populationChangeGuideline: number;
  trials: number;
  alphas: number[];
  seed: number;
  rank: RankMode;
  copyDetection: boolean;
  /** Percentage, 0 to 100. */
  atRiskProbability: number;
  concentratedTailRatio: number;
  /** Percentages, 1 to 100, except `complexityPercentile` (0 to 100) and `manyActiveAuthors` (a count). */
  singleOwnerShare: number;
  formerContributorShare: number;
  complexityPercentile: number;
  manyActiveAuthors: number;
  meaningfulShare: number;
  inconclusiveShare: number;
  busFactorShare: number;
}

/** Validates the effective `cochange.knowledge` section. Throws a config error (exit 2). */
export function readKnowledgeSettings(effective: Record<string, unknown>): KnowledgeSettings {
  const section = (effective[TOOL] as Record<string, unknown>).knowledge as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.knowledge.${key}`;
  const whole = (key: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw configError(`code-health.json: ${at(key)} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };
  const rate = section.turnoverRate;
  if (rate !== null && (typeof rate !== "number" || !(rate >= 0 && rate <= 100))) {
    throw configError(`code-health.json: ${at("turnoverRate")} must be a percentage from 0 to 100, or null`);
  }
  const alphas = section.alphas;
  if (!Array.isArray(alphas) || alphas.length === 0 || alphas.some((a) => typeof a !== "number" || !(a > 0 && a < 100))) {
    throw configError(`code-health.json: ${at("alphas")} must be a non-empty array of percentiles above 0 and below 100`);
  }
  const rank = section.rank;
  if (!RANK_MODES.includes(rank as RankMode)) throw configError(`code-health.json: ${at("rank")} must be "hotspot" or "abandonment"`);
  const ratio = section.concentratedTailRatio;
  if (typeof ratio !== "number" || !(ratio >= 1)) throw configError(`code-health.json: ${at("concentratedTailRatio")} must be a number of at least 1`);
  return {
    enabled: section.enabled !== false,
    activityWindowMonths: whole("activityWindowMonths", 1),
    periodMonths: whole("periodMonths", 1),
    horizonPeriods: whole("horizonPeriods", 1),
    abandonmentGuideline: whole("abandonmentGuideline", 1, 100),
    turnoverRate: rate === null ? null : (rate as number) / 100,
    turnoverRatePercent: rate === null ? null : (rate as number),
    minTurnoverPeriods: whole("minTurnoverPeriods", 0),
    mappedShareGuideline: whole("mappedShareGuideline", 0, 100),
    leaverProbabilityGuideline: whole("leaverProbabilityGuideline", 0, 100),
    populationChangeGuideline: whole("populationChangeGuideline", 0),
    trials: whole("trials", 1, 10_000_000),
    alphas: [...(alphas as number[])].sort((a, b) => a - b),
    seed: whole("seed", 0, 0xffffffff),
    rank: rank as RankMode,
    copyDetection: section.copyDetection === true,
    atRiskProbability: whole("atRiskProbability", 0, 100),
    concentratedTailRatio: ratio,
    singleOwnerShare: whole("singleOwnerShare", 1, 100),
    formerContributorShare: whole("formerContributorShare", 1, 100),
    complexityPercentile: whole("complexityPercentile", 0, 100),
    manyActiveAuthors: whole("manyActiveAuthors", 1),
    meaningfulShare: whole("meaningfulShare", 1, 100),
    inconclusiveShare: whole("inconclusiveShare", 1, 100),
    busFactorShare: whole("busFactorShare", 1, 100),
  };
}

/**
 * Every command of the abandonment analysis starts here, and stops with a usage
 * error when the repository's config sets `cochange.knowledge.enabled` to false.
 */
export function requireKnowledge(context: CommandContext): KnowledgeSettings {
  const settings = readKnowledgeSettings(context.config.effective);
  if (!settings.enabled) {
    throw new CliError(
      ExitCode.Usage,
      "knowledge-disabled",
      "the abandonment analysis is switched off in code-health.json (cochange.knowledge.enabled is false)",
    );
  }
  return settings;
}

/** Corrections to who counts as active, kept local and never committed. Keys are mapped identities, `Name <email>`. */
export interface KnowledgeOverrides {
  active: Set<string>;
  inactive: Set<string>;
  /** A short hash of the file when it exists, for the output's `inputs`. */
  stamp: string | null;
}

export const OVERRIDES_FILE = "knowledge-overrides.json";

export function overridesPath(root: string): string {
  return join(identityFiles(root).localDir, OVERRIDES_FILE);
}

/**
 * Reads `.code-health/local/knowledge-overrides.json`: `{ "schemaVersion": 1, "active": [...], "inactive": [...] }`.
 * `active` names people who are on leave or moved to another repository and will return,
 * `inactive` names people who have gone but whose last commit is recent. It is not part of the cache.
 */
export function readOverrides(root: string): KnowledgeOverrides {
  const file = overridesPath(root);
  if (!existsSync(file)) return { active: new Set(), inactive: new Set(), stamp: null };
  const text = readFileSync(file, "utf8");
  const fail = (what: string): never => {
    throw configError(`${file}: ${what}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("must be a JSON object");
  const document = value as Record<string, unknown>;
  const unknown = Object.keys(document).filter((k) => !["schemaVersion", "active", "inactive"].includes(k));
  if (unknown.length > 0) fail(`unknown key ${unknown.join(", ")}`);
  if (document.schemaVersion !== 1) fail("schemaVersion must be 1");
  const list = (key: string): Set<string> => {
    const items = document[key] ?? [];
    if (!Array.isArray(items) || items.some((i) => typeof i !== "string")) return fail(`${key} must be an array of "Name <email>" strings`);
    return new Set(items as string[]);
  };
  const active = list("active");
  const inactive = list("inactive");
  const both = [...active].filter((k) => inactive.has(k));
  if (both.length > 0) fail("an identity cannot be both active and inactive");
  return { active, inactive, stamp: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

/** The `--rank` option over the configured ranking. */
export function readRank(context: CommandContext, settings: KnowledgeSettings): RankMode {
  const value = context.values.rank;
  if (value === undefined) return settings.rank;
  if (!RANK_MODES.includes(value as RankMode)) throw usageError(`--rank must be "hotspot" or "abandonment", not "${String(value)}"`);
  return value as RankMode;
}
