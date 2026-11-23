import type { FiltersApplied } from "@code-health/history/noise";
import type { ExcludedCount } from "@code-health/report/protocol";

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

const FILE_KINDS: Record<string, string> = { generated: "generated files", vendored: "vendored files", nonCode: "non-code files", tests: "test files" };

/** Everything the run left out, as the header lists it: what the history filters dropped and the files the commands left out. */
export function excludedCounts(filters: FiltersApplied, files: Record<string, number>, builtin: Record<string, number>): ExcludedCount[] {
  return [
    ...[...COMMIT_FILTERS, ...CHANGE_FILTERS].map(([key, what]) => ({ what, count: filters.dropped[key] })),
    { what: `changes over the changeset limit of ${filters.maxChangesetSize} files`, count: filters.oversizedChanges },
    ...Object.entries(files).map(([kind, count]) => ({ what: `${FILE_KINDS[kind] ?? kind} left out of the results`, count })),
    ...Object.entries(builtin).map(([entry, count]) => ({ what: `files under the built-in exclude ${entry}`, count })),
  ];
}
