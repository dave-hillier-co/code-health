import { usageError } from "@code-health/cli-kit/errors";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import type { ComplexitySettings } from "./config.ts";
import { normalisePaths, type CurrentTree } from "./current-tree.ts";
import { measureFixes, SECONDARY_LIST_LIMIT, type FixStatistics, type UnitFixes } from "./fix-statistics.ts";
import { unitName } from "./rows.ts";

export const fixOptions = { "max-commits": { type: "string" }, evidence: { type: "string" } } as const;

export const fixOptionHelp = {
  "max-commits": "most commits of the history window to analyse, newest first (default complexity.fixes.maxCommits, 500); the output says how many were left out",
  evidence: "fix commits listed per function (default complexity.fixes.evidence, 3); the output says how many were left out",
} as const;

function count(value: unknown, option: string, min: number, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw usageError(`--${option} must be an integer of at least ${min}, got "${String(value)}"`);
  return parsed;
}

/** `--max-commits` and `--evidence`, or the configured defaults. */
export function parseFixOptions(values: CommandContext["values"], settings: ComplexitySettings): { maxCommits: number; evidence: number } {
  return {
    maxCommits: count(values["max-commits"], "max-commits", 1, settings.fixes.maxCommits),
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
  };
}

/** One function of `complexity fixes`. `score` is the fix count plus the fix share, so the kit's sort by score is fix count, then fix share. */
export function fixRow(fixes: UnitFixes) {
  const unit = fixes.current;
  return {
    path: fixes.path,
    unit: unit === undefined ? fixes.id.slice(fixes.id.indexOf("#") + 1) : unitName(unit),
    id: fixes.id,
    ...(unit === undefined ? {} : { kind: unit.kind, startLine: unit.startLine, endLine: unit.endLine }),
    score: fixes.fixCommits + (fixes.fixShare ?? 0),
    ...fixFigures(fixes),
    cognitive: unit?.values.cognitive ?? null,
    evidence: fixes.evidence,
    evidenceOmitted: fixes.evidenceOmitted,
    earlierIds: fixes.earlierIds,
  };
}

/** The header of the fix statistics: the window, the convention check, how much history was analysed and what was left out. */
export function fixHeader(stats: FixStatistics, request: { maxCommits: number; evidence: number }) {
  const deleted = stats.deleted.filter((unit) => unit.fixCommits > 0);
  return {
    window: { months: stats.window.months, since: iso(stats.window.since), until: iso(stats.window.until) },
    shallow: stats.shallow,
    fixConvention: stats.convention,
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
      rows: deleted.slice(0, SECONDARY_LIST_LIMIT).map(fixRow),
    },
    outsideUnits: {
      fixCommits: stats.outside.fixCommits,
      files: stats.outside.files.length,
      limit: SECONDARY_LIST_LIMIT,
      omitted: Math.max(0, stats.outside.files.length - SECONDARY_LIST_LIMIT),
      rows: stats.outside.files.slice(0, SECONDARY_LIST_LIMIT),
    },
  };
}

/** Lines a table run prints after the rows. JSON carries the same facts in the header. */
export function fixNotices(stats: FixStatistics, request: { maxCommits: number }): string[] {
  const { commits, window } = stats;
  const deletedWithFixes = stats.deleted.filter((unit) => unit.fixCommits > 0).length;
  const notices = [
    `Analysed ${commits.analysed} of ${commits.inWindow} commits in the ${window.months} month window and skipped ${commits.skipped}: ${commits.skippedBy.maxCommits} over --max-commits ${request.maxCommits}, ${commits.skippedBy.oversized} in oversized changes, ${commits.skippedBy.noSourceFile} touching no source file`,
    `${stats.unitsWithFixes} of the ${stats.unitsTouched} functions touched in the window have a fix, ${deletedWithFixes} of them since deleted; ${stats.outside.fixCommits} fixes changed lines outside any function. The deleted functions and those files are listed in the JSON output`,
  ];
  if (stats.convention.note !== null) notices.unshift(stats.convention.note.replace(/\.$/, ""));
  if (stats.shallow) notices.push("The clone is shallow, so history before its boundary is missing");
  return notices;
}

export interface MeasuredFixes {
  stats: FixStatistics;
  request: { maxCommits: number; evidence: number };
  paths: string[];
}

/** Measures the fix statistics of the files under the command's path arguments against the current tree. */
export async function measureFixesFor(context: CommandContext, settings: ComplexitySettings, current: CurrentTree): Promise<MeasuredFixes> {
  const paths = normalisePaths(context.positionals);
  const request = parseFixOptions(context.values, settings);
  const stats = await measureFixes(context.repo.root, settings, context.config.effective.exclude, current.tree, { paths, ...request });
  return { stats, request, paths };
}
