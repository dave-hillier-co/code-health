import { configError } from "@code-health/cli-kit/errors";
import type { LoadedConfig, PluginConfigSpec } from "@code-health/cli-kit/config";
import { DEFAULT_EVIDENCE_THRESHOLDS, type EvidenceThresholds } from "@code-health/history/evidence";
import { DEFAULT_MAX_CHANGESET_SIZE } from "@code-health/history/noise";
import { DEFAULT_RENAME_LIMIT, DEFAULT_SIMILARITY } from "@code-health/history/refresh";
import { DEFAULT_EXACT_LIMIT } from "@code-health/graph/feedback-arc-set";
import { packagesDefaults, readPackageSettings, type PackageSettings } from "./packaging/settings.ts";
import { TOOL } from "./tool.ts";

/**
 * The `structure` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default.
 */
export const structureConfig: PluginConfigSpec = {
  plugin: TOOL,
  section: {
    /** Analysed branch. null analyses HEAD. */
    branch: null,
    /** Follow only first parents, for repositories that merge long-lived feature branches. */
    firstParent: false,
    renameSimilarity: DEFAULT_SIMILARITY,
    renameLimit: DEFAULT_RENAME_LIMIT,
    /** Analysis window, back from the analysed commit's date. */
    windowMonths: 12,
    maxChangesetSize: DEFAULT_MAX_CHANGESET_SIZE,
    /** Regular expressions matched against `Name <email>` of an author; their commits are left out of history. */
    botPatterns: [] as string[],
    /** Cycles whose strongly connected component has at most this many nodes get a minimum breaking set. */
    exactLimit: DEFAULT_EXACT_LIMIT,
    /** A side is "active" when it has at least this many revisions in the window, so a low co-change is evidence and not absence of data. */
    minRevisions: 3,
    /** A dependency points against change stability when the depended-on side's revisions per file are at least this multiple of the dependant's. */
    minVolatilityRatio: 2,
    /** A dependency points against structural stability when the depended-on side's instability exceeds the dependant's by at least this many percentage points. */
    minInstabilityGap: 20,
    evidence: {
      strong: { ...DEFAULT_EVIDENCE_THRESHOLDS.strong },
      moderate: { ...DEFAULT_EVIDENCE_THRESHOLDS.moderate },
    },
    /** The packaging skill's settings; see docs/specs/packaging.md. */
    packages: packagesDefaults,
  },
};

export interface StructureSettings {
  /** The ref analysed: the configured branch, or HEAD. */
  ref: string;
  firstParent: boolean;
  renameSimilarity: number;
  renameLimit: number;
  windowMonths: number;
  maxChangesetSize: number;
  botPatterns: string[];
  exactLimit: number;
  minRevisions: number;
  minVolatilityRatio: number;
  /** Percentage points. */
  minInstabilityGap: number;
  /** The suite's shared `exclude` globs. */
  exclude: string[];
  /** The suite's shared `components` config, as written. */
  components: Record<string, unknown>;
  evidenceThresholds: EvidenceThresholds;
  packages: PackageSettings;
  /** True when the config file states the analysis window, which a shallow clone requires. */
  windowStated: boolean;
}

/** Validates the effective structure section and returns it typed. Throws a config error (exit 2). */
export function readSettings(config: LoadedConfig): StructureSettings {
  const section = config.effective[TOOL] as Record<string, unknown>;
  const at = (key: string) => `${TOOL}.${key}`;

  const positive = (key: string): number => {
    const value = section[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw configError(`code-health.json: ${at(key)} must be a positive integer`);
    }
    return value;
  };

  const branch = section.branch;
  if (branch !== null && (typeof branch !== "string" || branch === "")) {
    throw configError(`code-health.json: ${at("branch")} must be a branch name or null`);
  }
  const botPatterns = section.botPatterns;
  if (!Array.isArray(botPatterns) || botPatterns.some((p) => typeof p !== "string")) {
    throw configError(`code-health.json: ${at("botPatterns")} must be an array of strings`);
  }
  const minInstabilityGap = positive("minInstabilityGap");
  if (minInstabilityGap > 100) throw configError(`code-health.json: ${at("minInstabilityGap")} is in percentage points, at most 100`);
  const exactLimit = positive("exactLimit");
  if (exactLimit > 30) throw configError(`code-health.json: ${at("exactLimit")} is at most 30, the largest component the exact search supports`);

  return {
    ref: branch ?? "HEAD",
    firstParent: section.firstParent === true,
    renameSimilarity: positive("renameSimilarity"),
    renameLimit: positive("renameLimit"),
    windowMonths: positive("windowMonths"),
    maxChangesetSize: positive("maxChangesetSize"),
    botPatterns: botPatterns as string[],
    exactLimit,
    minRevisions: positive("minRevisions"),
    minVolatilityRatio: positive("minVolatilityRatio"),
    minInstabilityGap,
    exclude: config.effective.exclude,
    components: config.effective.components,
    evidenceThresholds: section.evidence as EvidenceThresholds,
    packages: readPackageSettings(section.packages as Record<string, unknown>, at("packages")),
    windowStated: config.sources[at("windowMonths")] === "file",
  };
}
