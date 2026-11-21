import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { DEFAULT_ISSUE_PATTERN, type Grouping } from "@code-health/history/grouping";
import { DEFAULT_EVIDENCE_THRESHOLDS, type EvidenceThresholds } from "@code-health/history/evidence";
import { DEFAULT_MAX_CHANGESET_SIZE } from "@code-health/history/noise";
import { DEFAULT_RENAME_LIMIT, DEFAULT_SIMILARITY } from "@code-health/history/refresh";
import { TOOL } from "./tool.ts";

/**
 * The `cochange` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default.
 */
export const cochangeConfig: PluginConfigSpec = {
  plugin: TOOL,
  section: {
    /** Analysed branch. null analyses HEAD. */
    branch: null,
    /** Follow only first parents, for repositories that merge long-lived feature branches. */
    firstParent: false,
    /** Rename similarity percentage for git's -M. Changing it rebuilds the cache. */
    renameSimilarity: DEFAULT_SIMILARITY,
    renameLimit: DEFAULT_RENAME_LIMIT,
    /** Analysis window, back from the analysed commit's date. */
    windowMonths: 12,
    recentMonths: 3,
    staleMonths: 12,
    /** A hotspot's score must be in the top (100 - this) percent of scored files. */
    hotspotPercentile: 90,
    /**
     * How commits form logical changes: "off" (each commit is its own change), "issue-key" (commits
     * sharing an issue key in the message) or "author-window" (one author's commits close in time).
     */
    grouping: "off",
    /** For "issue-key": a regular expression; the key is its first capture group, or the whole match. */
    issuePattern: DEFAULT_ISSUE_PATTERN,
    /** For "author-window": the longest pause, in hours, between commits of one change. */
    groupingWindowHours: 4,
    maxChangesetSize: DEFAULT_MAX_CHANGESET_SIZE,
    minSupport: 5,
    /** Minimum coupling degree, as a percentage. */
    minDegree: 30,
    minDistance: 2,
    hook: { enabled: false, confidence: 80, maxCommitsBehind: 50 },
    identities: { botPatterns: [] },
    evidence: {
      strong: { ...DEFAULT_EVIDENCE_THRESHOLDS.strong },
      moderate: { ...DEFAULT_EVIDENCE_THRESHOLDS.moderate },
    },
  },
};

export interface CochangeSettings {
  /** The ref analysed: the configured branch, or HEAD. */
  ref: string;
  firstParent: boolean;
  renameSimilarity: number;
  renameLimit: number;
  windowMonths: number;
  recentMonths: number;
  staleMonths: number;
  hotspotPercentile: number;
  /** How commits form logical changes. */
  grouping: Grouping;
  maxChangesetSize: number;
  minSupport: number;
  minDegree: number;
  minDistance: number;
  /** The suite's shared `exclude` globs. */
  exclude: string[];
  botPatterns: string[];
  evidenceThresholds: EvidenceThresholds;
  /** True when the config file states the analysis window, which a shallow clone requires. */
  windowStated: boolean;
}

/** Validates the effective cochange section and returns it typed. Throws a config error (exit 2). */
export function readSettings(config: LoadedConfig): CochangeSettings {
  const section = config.effective[TOOL] as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.${key}`;

  const positive = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw configError(`code-health.json: ${at(key)} must be a positive integer`);
    }
    return value;
  };

  const hotspotPercentile = (): number => {
    const value = positive("hotspotPercentile");
    if (value > 99) throw configError(`code-health.json: ${at("hotspotPercentile")} must be between 1 and 99`);
    return value;
  };

  const branch = section.branch;
  if (branch !== null && (typeof branch !== "string" || branch === "")) {
    throw configError(`code-health.json: ${at("branch")} must be a branch name or null`);
  }
  const grouping = readGrouping(section, positive);
  const botPatterns = (section.identities as { botPatterns: unknown }).botPatterns;
  if (!Array.isArray(botPatterns) || botPatterns.some((p) => typeof p !== "string")) {
    throw configError(`code-health.json: ${at("identities.botPatterns")} must be an array of strings`);
  }
  const minDegree = positive("minDegree");
  if (minDegree > 100) throw configError(`code-health.json: ${at("minDegree")} is a percentage, at most 100`);
  const evidence = section.evidence as EvidenceThresholds;

  return {
    ref: branch ?? "HEAD",
    firstParent: section.firstParent === true,
    renameSimilarity: positive("renameSimilarity"),
    renameLimit: positive("renameLimit"),
    windowMonths: positive("windowMonths"),
    recentMonths: positive("recentMonths"),
    staleMonths: positive("staleMonths"),
    hotspotPercentile: hotspotPercentile(),
    grouping,
    maxChangesetSize: positive("maxChangesetSize"),
    minSupport: positive("minSupport"),
    minDegree,
    minDistance: positive("minDistance"),
    exclude: config.effective.exclude,
    botPatterns: botPatterns as string[],
    evidenceThresholds: evidence,
    windowStated: config.sources[at("windowMonths")] === "file",
  };
}

function readGrouping(section: Record<string, unknown>, positive: (key: string) => number): Grouping {
  const at = (key: string) => `${TOOL}.${key}`;
  const mode = section.grouping;
  if (mode === "off") return { mode };
  if (mode === "issue-key") {
    const pattern = section.issuePattern;
    if (typeof pattern !== "string" || pattern === "") {
      throw configError(`code-health.json: ${at("issuePattern")} must be a non-empty regular expression`);
    }
    try {
      new RegExp(pattern);
    } catch (error) {
      throw configError(`code-health.json: ${at("issuePattern")} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { mode, pattern };
  }
  if (mode === "author-window") return { mode, windowSeconds: positive("groupingWindowHours") * 3600 };
  throw configError(`code-health.json: ${at("grouping")} must be "off", "issue-key" or "author-window"`);
}
