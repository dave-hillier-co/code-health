import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { DEFAULT_ISSUE_PATTERN, type Grouping } from "@code-health/history/grouping";
import { DEFAULT_EVIDENCE_THRESHOLDS, type EvidenceThresholds } from "@code-health/history/evidence";
import type { MappingLocation } from "@code-health/history/identity-decisions";
import { DEFAULT_MAX_CHANGESET_SIZE } from "@code-health/history/noise";
import { DEFAULT_RENAME_LIMIT, DEFAULT_SIMILARITY } from "@code-health/history/refresh";
import { KNOWLEDGE_DEFAULTS } from "./abandonment/settings.ts";
import { riskDefaults } from "./risk/settings.ts";
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
    /** Coupling degree guideline, as a percentage (Tornhill's code-maat default). Orders and labels pairs. Only cluster membership cuts on it. */
    minDegree: 30,
    minDistance: 2,
    /**
     * The hook prints a note only when it has something worth a look. `confidence` is a guideline (percent), after
     * the high-confidence couples of Tornhill's Software Design X-Rays, and a judgement call as a default: it decides
     * whether a partner is named. `maxPartners` caps the partners one note names. `maxCommitsBehind` is how far the
     * history cache may trail HEAD before the hook prints nothing.
     */
    hook: { enabled: false, confidence: 80, maxPartners: 3, maxCommitsBehind: 50 },
    /** The change-risk skill: see risk/settings.ts. */
    risk: riskDefaults,
    identities: {
      /** Where the mapping lives: "committed" or "local". null decides from the files present, and the identities skill asks when there are none. */
      location: null,
      /** The one place bot and service patterns are configured. Regular expressions matched against `Name <email>`. */
      botPatterns: [],
      servicePatterns: [],
      /** Extra patterns for a Co-Authored-By trailer naming an AI agent, beside the built-in ones. */
      agentTrailerPatterns: [],
      /** Unmapped identities holding more than this percentage of lines at HEAD make the abandonment skill run the identities skill. */
      unmappedShareThreshold: 5,
      /** Commits in the analysis window that make an unmapped identity significant, whether or not it holds lines. */
      significantCommits: 3,
    },
    /** The abandonment analysis. Off until `enabled` is true. */
    knowledge: { ...KNOWLEDGE_DEFAULTS, alphas: [...KNOWLEDGE_DEFAULTS.alphas] },
    evidence: {
      strong: { ...DEFAULT_EVIDENCE_THRESHOLDS.strong },
      moderate: { ...DEFAULT_EVIDENCE_THRESHOLDS.moderate },
    },
  },
};

export interface IdentitySettings {
  location: MappingLocation | null;
  botPatterns: string[];
  servicePatterns: string[];
  agentTrailerPatterns: string[];
  unmappedShareThreshold: number;
  significantCommits: number;
}

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
  identities: IdentitySettings;
  evidenceThresholds: EvidenceThresholds;
  /** True when the config file states the analysis window, which a shallow clone requires. */
  windowStated: boolean;
  /** The opt-in change-set completeness hook. */
  hook: { enabled: boolean; confidence: number; maxPartners: number; maxCommitsBehind: number };
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
  const identities = readIdentities(section.identities as Record<string, unknown>, at);
  const minDegree = positive("minDegree");
  if (minDegree > 100) throw configError(`code-health.json: ${at("minDegree")} is a percentage, at most 100`);
  const evidence = section.evidence as EvidenceThresholds;
  const hook = section.hook as { enabled: boolean; confidence: unknown; maxPartners: unknown; maxCommitsBehind: unknown };
  const hookConfidence = hook.confidence;
  if (typeof hookConfidence !== "number" || !Number.isInteger(hookConfidence) || hookConfidence < 1 || hookConfidence > 100) {
    throw configError(`code-health.json: ${at("hook.confidence")} must be a percentage from 1 to 100`);
  }
  const maxPartners = hook.maxPartners;
  if (typeof maxPartners !== "number" || !Number.isInteger(maxPartners) || maxPartners < 1) {
    throw configError(`code-health.json: ${at("hook.maxPartners")} must be a positive integer`);
  }
  const behind = hook.maxCommitsBehind;
  if (typeof behind !== "number" || !Number.isInteger(behind) || behind < 0) {
    throw configError(`code-health.json: ${at("hook.maxCommitsBehind")} must be a non-negative integer`);
  }

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
    botPatterns: identities.botPatterns,
    identities,
    evidenceThresholds: evidence,
    windowStated: config.sources[at("windowMonths")] === "file",
    hook: { enabled: hook.enabled === true, confidence: hookConfidence, maxPartners, maxCommitsBehind: behind },
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

function readIdentities(section: Record<string, unknown>, at: (key: string) => string): IdentitySettings {
  const strings = (key: string): string[] => {
    const value = section[key];
    if (!Array.isArray(value) || value.some((p) => typeof p !== "string")) {
      throw configError(`code-health.json: ${at(`identities.${key}`)} must be an array of strings`);
    }
    return value as string[];
  };
  const location = section.location;
  if (location !== null && location !== "committed" && location !== "local") {
    throw configError(`code-health.json: ${at("identities.location")} must be "committed", "local" or null`);
  }
  const count = (key: string, max: number): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      throw configError(`code-health.json: ${at(`identities.${key}`)} must be a whole number from 0 to ${max}`);
    }
    return value;
  };
  return {
    location,
    botPatterns: strings("botPatterns"),
    servicePatterns: strings("servicePatterns"),
    agentTrailerPatterns: strings("agentTrailerPatterns"),
    unmappedShareThreshold: count("unmappedShareThreshold", 100),
    significantCommits: count("significantCommits", 1_000_000),
  };
}
