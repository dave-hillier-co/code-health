import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ComplexitySettings } from "./config.ts";
import { normalisePaths, type CurrentTree } from "./current-tree.ts";
import { isLowEvidence, measureFixes, SECONDARY_LIST_LIMIT, type FixStatistics, type UnitFixes } from "./fix-statistics.ts";
import { roleOfTest } from "./roles.ts";
import { unitName } from "./rows.ts";

/** `maxCommits` is null for the whole window. */
export interface FixOptions {
  maxCommits: number | null;
  evidence: number;
}

export const fixOptions = { "max-commits": { type: "string" }, evidence: { type: "string" } } as const;

export const fixOptionHelp = {
  "max-commits": "most commits of the history window to analyse, newest first, or all for the whole window (default complexity.fixes.maxCommits, null, which is all); the output says how many were left out",
  evidence: "fix commits listed per function (default complexity.fixes.evidence, 3); the output says how many were left out",
} as const;

function count<Fallback extends number | null>(value: unknown, option: string, min: number, fallback: Fallback): number | Fallback {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw usageError(`--${option} must be an integer of at least ${min}, got "${String(value)}"`);
  return parsed;
}

/** `--max-commits` and `--evidence`, or the configured defaults. */
export function parseFixOptions(values: CommandContext["values"], settings: ComplexitySettings): FixOptions {
  return {
    maxCommits: values["max-commits"] === "all" ? null : count(values["max-commits"], "max-commits", 1, settings.fixes.maxCommits),
    evidence: count(values.evidence, "evidence", 0, settings.fixes.evidence),
  };
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** The fix columns shared by `fixes` and `analyse --with-fixes`. */
export function fixFigures(fixes: UnitFixes | undefined) {
  return {
    fixCommits: fixes?.fixCommits ?? 0,
    unitRevisions: fixes?.revisions ?? 0,
    fixShare: fixes?.fixShare ?? null,
    reviewFixes: fixes?.reviewFixes ?? 0,
  };
}

/** The label of a function with fewer than `fixes.minRevisions` revisions in the window. */
export const LOW_EVIDENCE = "low evidence";

/**
 * One function of `complexity fixes`. `score` puts the fix count first, then functions with enough revisions before low evidence ones,
 * then the fix share, so the kit's sort by score gives that order: with the share at most 1 and scaled to 0.4, the low evidence band is
 * 0 to 0.4 and the other band 0.5 to 0.9 above the count.
 */
export function fixRow(fixes: UnitFixes, minRevisions: number, isTest: (path: string) => boolean) {
  const low = isLowEvidence(fixes, minRevisions);
  const unit = fixes.current;
  return {
    path: fixes.path,
    unit: unit === undefined ? fixes.id.slice(fixes.id.indexOf("#") + 1) : unitName(unit),
    id: fixes.id,
    role: roleOfTest(isTest(fixes.path)),
    ...(unit === undefined ? {} : { kind: unit.kind, startLine: unit.startLine, endLine: unit.endLine }),
    score: fixes.fixCommits + (low ? 0 : 0.5) + (fixes.fixShare ?? 0) * 0.4,
    ...fixFigures(fixes),
    cognitive: unit?.values.cognitive ?? null,
    labels: low ? [LOW_EVIDENCE] : [],
    evidence: fixes.evidence,
    evidenceOmitted: fixes.evidenceOmitted,
    reviewEvidence: fixes.reviewEvidence,
    reviewEvidenceOmitted: fixes.reviewEvidenceOmitted,
    earlierIds: fixes.earlierIds,
  };
}

/** The header of the fix statistics: the window, the convention check, how much history was analysed and what was left out. */
export function fixHeader(stats: FixStatistics, request: FixOptions, settings: ComplexitySettings) {
  const deleted = stats.deleted.filter((unit) => unit.fixCommits > 0);
  return {
    window: { months: stats.window.months, since: iso(stats.window.since), until: iso(stats.window.until) },
    shallow: stats.shallow,
    fixConvention: stats.convention,
    fixesExcluded: { ...stats.excluded, excludePatterns: "history.fixExcludePatterns", note: "Landed changes that a fix pattern matched and an exclude pattern removed because the change has a non-fix Conventional Commits type or the fix target is typos, spelling, lint or formatting. They are not counted as fixes." },
    lowEvidence: { minRevisions: stats.minRevisions, rule: `A function with fewer than ${stats.minRevisions} revisions in the analysed window is labelled "${LOW_EVIDENCE}" and sorts after the others with the same fix count.` },
    commits: { ...stats.commits, maxCommits: request.maxCommits },
    files: stats.files,
    cache: stats.cache,
    summary: {
      unitsTouched: stats.unitsTouched,
      unitsWithFixes: stats.unitsWithFixes,
      currentUnitsWithFixes: [...stats.units.values()].filter((unit) => unit.fixCommits > 0).length,
    },
    deleted: {
      units: stats.deleted.length,
      withFixes: deleted.length,
      limit: SECONDARY_LIST_LIMIT,
      omitted: Math.max(0, deleted.length - SECONDARY_LIST_LIMIT),
      rows: deleted.slice(0, SECONDARY_LIST_LIMIT).map((unit) => fixRow(unit, stats.minRevisions, settings.isTest)),
    },
    outsideUnits: {
      /** Distinct fix changes with a changed line outside every function, so never more than the fixes of the window. */
      fixCommits: stats.outside.fixCommits,
      /** The same changes counted once per file they touched. */
      fixFileChanges: stats.outside.fixFileChanges,
      files: stats.outside.files.length,
      limit: SECONDARY_LIST_LIMIT,
      omitted: Math.max(0, stats.outside.files.length - SECONDARY_LIST_LIMIT),
      rows: stats.outside.files.slice(0, SECONDARY_LIST_LIMIT),
    },
  };
}

/** Lines a table run prints after the rows. JSON carries the same facts in the header. */
export function fixNotices(stats: FixStatistics, request: FixOptions): string[] {
  const { commits, window } = stats;
  const deletedWithFixes = stats.deleted.filter((unit) => unit.fixCommits > 0).length;
  const notices = [
    ...(commits.skippedBy.maxCommits > 0
      ? [`Only the newest ${commits.analysed} of ${commits.inWindow} commits in the window were analysed: ${commits.skippedBy.maxCommits} older commits were left out by --max-commits ${request.maxCommits ?? "all"}, so every figure below covers part of the window. Pass --max-commits all to analyse the whole window`]
      : []),
    `Analysed ${commits.analysed} of ${commits.inWindow} commits in the ${window.months} month window and skipped ${commits.skipped}: ${commits.skippedBy.maxCommits} over --max-commits ${request.maxCommits ?? "all"}, ${commits.skippedBy.oversized} in oversized changes, ${commits.skippedBy.noSourceFile} touching no source file`,
    `${stats.unitsWithFixes} of the ${stats.unitsTouched} functions touched in the window have a fix, ${deletedWithFixes} of them since deleted; ${stats.outside.fixCommits} fixes changed lines outside any function (${stats.outside.fixFileChanges} counting each file of a fix). The deleted functions and those files are listed in the JSON output`,
  ];
  if (stats.convention.note !== null) notices.unshift(stats.convention.note.replace(/\.$/, ""));
  if (stats.excluded.fixes > 0) {
    notices.push(`${stats.excluded.fixes} changes matched a fix pattern and were left out because the commit has a non-fix Conventional Commits type, or is about typos, spelling, lint or formatting (history.fixExcludePatterns): ${stats.excluded.byPattern.map((entry) => `${entry.count} by ${entry.pattern}`).join("; ")}`);
  }
  if (stats.shallow) notices.push("The clone is shallow, so history before its boundary is missing");
  return notices;
}

export interface MeasuredFixes {
  stats: FixStatistics;
  request: FixOptions;
  paths: string[];
}

/** Measures the fix statistics of the files under the command's path arguments against the current tree. */
export async function measureFixesFor(context: CommandContext, settings: ComplexitySettings, current: CurrentTree): Promise<MeasuredFixes> {
  const paths = normalisePaths(context.positionals);
  const request = parseFixOptions(context.values, settings);
  const stats = await measureFixes(context.repo.root, settings, context.config.effective.exclude, current.tree, { paths, ...request });
  return { stats, request, paths };
}
