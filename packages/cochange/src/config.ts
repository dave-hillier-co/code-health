import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { DEFAULT_ISSUE_PATTERN, type Grouping } from "@code-health/history/grouping";
import type { EvidenceGuidelines } from "@code-health/history/evidence";
import type { MappingLocation } from "@code-health/history/identity-decisions";
import { KNOWLEDGE_DEFAULTS } from "./abandonment/settings.ts";
import { riskDefaults } from "./risk/settings.ts";
import { TOOL } from "./tool.ts";

/**
 * The `cochange` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default.
 */
export const cochangeConfig: PluginConfigSpec = {
  plugin: TOOL,
  history: ["branch", "firstParent", "renameSimilarity", "renameLimit", "windowMonths", "maxChangesetSize", "botPatterns", "fixPatterns", "fixExcludePatterns", "revertPatterns", "fixMatchBody", "evidence"],
  section: {
    recentMonths: 3,
    staleMonths: 12,
    /** A hotspot's score must be in the top (100 - this) percent of scored files. */
    hotspotPercentile: 90,
    /**
     * A guideline for the hotspots report: the friction files it asks for a judgement of, the most hotspot score
     * first. Each judged file costs two slots, so ten keeps a page to a length a person reads in one sitting; the
     * rest of the friction list is still in the table. It sets length, not what counts as a hotspot.
     */
    hotspotJudged: 10,
    /**
     * How commits form logical changes: "off" (each commit is its own change), "issue-key" (commits
     * sharing an issue key in the message) or "author-window" (one author's commits close in time).
     */
    grouping: "off",
    /** For "issue-key": a regular expression; the key is its first capture group, or the whole match. */
    issuePattern: DEFAULT_ISSUE_PATTERN,
    /** For "author-window": the longest pause, in hours, between commits of one change. */
    groupingWindowHours: 4,
    minSupport: 5,
    /** Coupling degree guideline, as a percentage (Tornhill's code-maat default). Orders and labels pairs. Only cluster membership cuts on it. */
    minDegree: 30,
    minDistance: 2,
    /** Percentage points of degree within which a pair's coupling is stable between two windows (`coupling --trend`). A judgement call. */
    couplingTrendTolerance: 10,
    /** The change-risk skill: see risk/settings.ts. */
    risk: riskDefaults,
    identities: {
      /** Where the mapping lives: "committed" or "local". null decides from the files present, and the identities skill asks when there are none. */
      location: null,
      /** Regular expressions matched against `Name <email>`. Bot patterns are the `history.botPatterns` setting, which this section may override as `cochange.botPatterns`. */
      servicePatterns: [],
      /** Extra patterns for a Co-Authored-By trailer naming an AI agent, beside the built-in ones. */
      agentTrailerPatterns: [],
      /** Unmapped identities holding more than this percentage of lines at HEAD make the abandonment skill run the identities skill. */
      unmappedShareGuideline: 5,
      /** Commits in the analysis window that make an unmapped identity significant, whether or not it holds lines. */
      significantCommits: 3,
    },
    /** The abandonment analysis. Off until `enabled` is true. */
    knowledge: { ...KNOWLEDGE_DEFAULTS, alphas: [...KNOWLEDGE_DEFAULTS.alphas] },
  },
};

export interface IdentitySettings {
  location: MappingLocation | null;
  servicePatterns: string[];
  agentTrailerPatterns: string[];
  unmappedShareGuideline: number;
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
  /** The friction files the hotspots report asks a judgement of. */
  hotspotJudged: number;
  /** How commits form logical changes. */
  grouping: Grouping;
  maxChangesetSize: number;
  minSupport: number;
  minDegree: number;
  minDistance: number;
  couplingTrendTolerance: number;
  /** The suite's shared `exclude` globs. */
  exclude: string[];
  botPatterns: string[];
  identities: IdentitySettings;
  evidenceGuidelines: EvidenceGuidelines;
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
  const identities = readIdentities(section.identities as Record<string, unknown>, at);
  const minDegree = positive("minDegree");
  if (minDegree > 100) throw configError(`code-health.json: ${at("minDegree")} is a percentage, at most 100`);
  const tolerance = section.couplingTrendTolerance;
  if (typeof tolerance !== "number" || !Number.isInteger(tolerance) || tolerance < 0 || tolerance > 100) {
    throw configError(`code-health.json: ${at("couplingTrendTolerance")} is a number of percentage points, from 0 to 100`);
  }
  const evidence = section.evidence as EvidenceGuidelines;

  return {
    ref: branch ?? "HEAD",
    firstParent: section.firstParent === true,
    renameSimilarity: positive("renameSimilarity"),
    renameLimit: positive("renameLimit"),
    windowMonths: positive("windowMonths"),
    recentMonths: positive("recentMonths"),
    staleMonths: positive("staleMonths"),
    hotspotPercentile: hotspotPercentile(),
    hotspotJudged: positive("hotspotJudged"),
    grouping,
    maxChangesetSize: positive("maxChangesetSize"),
    minSupport: positive("minSupport"),
    minDegree,
    minDistance: positive("minDistance"),
    couplingTrendTolerance: tolerance,
    exclude: config.effective.exclude,
    botPatterns: section.botPatterns as string[],
    identities,
    evidenceGuidelines: evidence,
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
    servicePatterns: strings("servicePatterns"),
    agentTrailerPatterns: strings("agentTrailerPatterns"),
    unmappedShareGuideline: count("unmappedShareGuideline", 100),
    significantCommits: count("significantCommits", 1_000_000),
  };
}
