import type { ExcludedCount } from "@code-health/report/protocol";
import type { Evidence } from "./evidence.ts";
import type { FiltersApplied } from "./noise.ts";

/** Commits the history read dropped, each with the words the page uses. */
const COMMIT_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["outsideWindow", "commits outside the analysis window"],
  ["shallowBoundaryCommits", "shallow boundary commits"],
  ["importedCommits", "commits of imported history"],
  ["blameIgnoredCommits", "commits in the blame ignore file"],
  ["botCommits", "commits by bots and service accounts"],
  ["suiteCommits", "commits trailed by this suite"],
  ["emptyAfterFiltering", "commits with no file left after filtering"],
];

/** File changes the history read dropped. */
const CHANGE_FILTERS: [keyof FiltersApplied["dropped"], string][] = [
  ["pureRenames", "file changes that only rename"],
  ["excludedByGlob", "file changes matching exclude globs"],
  ["lockfiles", "lockfile changes"],
  ["generated", "generated file changes"],
  ["vendored", "vendored file changes"],
];

/** How a page names each kind of file a filter leaves out. */
export const FILE_KINDS: Record<string, string> = { generated: "generated files", vendored: "vendored files", nonCode: "non-code files", tests: "test files" };

/**
 * The count of generated and vendored files is of the files the report's commands read, so two reports of one commit
 * can differ: a history-only report counts the files changed in its window or range, and a report that also reads
 * the tree counts those in the tree at HEAD as well.
 */
export const READ_BY_COMMANDS = new Set(["generated", "vendored"]);
export const FILES_READ = " (counted over the files this report's commands read: changed in the window or range, and in the tree at HEAD where the report reads it)";

/** Where a report's wording differs from the default. */
export interface ExcludedWording {
  /** What the files left out were left out of: "the rankings" gives "generated files left out of the rankings". Default "the results". */
  leftOutOf?: string;
  /** Text after "changes over the changeset limit of N files". Default none. */
  oversizedNote?: string;
}

/**
 * Everything a run left out, as a report header lists it: what the history filters dropped, the changes over the
 * changeset limit, the files the commands left out (`droppedCounts()` of cli-kit) and the files under built-in
 * excludes (`builtinOmissions()`). Zero counts are included; filter them with `.filter((e) => e.count > 0)`.
 */
export function excludedCounts(filters: FiltersApplied, files: Record<string, number>, builtin: Record<string, number>, wording: ExcludedWording = {}): ExcludedCount[] {
  const leftOutOf = wording.leftOutOf ?? "the results";
  return [
    ...[...COMMIT_FILTERS, ...CHANGE_FILTERS].map(([key, what]) => ({ what, count: filters.dropped[key] })),
    { what: `changes over the changeset limit of ${filters.maxChangesetSize} files${wording.oversizedNote === undefined ? "" : `, ${wording.oversizedNote}`}`, count: filters.oversizedChanges },
    ...Object.entries(files).map(([kind, count]) => ({ what: `${FILE_KINDS[kind] ?? kind} left out of ${leftOutOf}${READ_BY_COMMANDS.has(kind) ? FILES_READ : ""}`, count })),
    ...Object.entries(builtin).map(([entry, count]) => ({ what: `files under the built-in exclude ${entry}`, count })),
  ];
}

/** A date as `YYYY-MM-DD`, from epoch seconds or an ISO string. */
export function isoDate(value: number | string): string {
  return new Date(typeof value === "number" ? value * 1000 : value).toISOString().slice(0, 10);
}

/**
 * The header's history window sentence: "12 months of usable history; the analysis window is 12 months, 2025-01-01
 * to 2025-12-31", followed by `suffix` (for example "; authorship is the blame at the analysed commit") when given.
 */
export function historyWindowText(evidence: Pick<Evidence, "usableHistoryMonths" | "window">, window: { since: number | string; until: number | string }, suffix = ""): string {
  return `${evidence.usableHistoryMonths} months of usable history; the analysis window is ${evidence.window.months} months, ${isoDate(window.since)} to ${isoDate(window.until)}${suffix}`;
}
