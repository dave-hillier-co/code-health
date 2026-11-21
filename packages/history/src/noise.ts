import { compileGlobs } from "./glob.ts";
import { detectImportedHistory, type ImportDetectionOptions, type ImportedHistory } from "./imported.ts";
import type { HistoryChange, HistoryCommit, HistoryView } from "./read.ts";
import { listTree, readBlameIgnoreRevs, readPathAttributes } from "./tree.ts";

export const DEFAULT_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "gradle.lockfile",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
];

export const DEFAULT_MAX_CHANGESET_SIZE = 30;

export interface NoiseOptions {
  /** The suite's shared `exclude` globs. */
  exclude?: readonly string[];
  /** Lockfile basenames to drop. Defaults to the built-in list. `false` keeps lockfiles. */
  lockfiles?: readonly string[] | false;
  /** Drop paths marked linguist-generated or linguist-vendored. Default true. */
  gitattributes?: boolean;
  /** File listing revisions to ignore. Default `.git-blame-ignore-revs`; `false` disables. */
  blameIgnoreRevs?: string | false;
  /** Regular expression sources matched (case-insensitively) against `Name <email>` of the mapped author. */
  botPatterns?: readonly string[];
  /** Logical changes with more files than this are flagged oversized. Default 30. */
  maxChangesetSize?: number;
  /** Drop the root commit of an imported history. Default true. */
  excludeImported?: boolean;
  importDetection?: ImportDetectionOptions;
  /** Window, in unix seconds of committer date. `since` is inclusive, `until` exclusive. */
  since?: number;
  until?: number;
}

/**
 * One unit of intent. With grouping off (the default) every commit is its own
 * logical change. Grouping by issue key or author window arrives later and
 * merges several commits here.
 */
export interface LogicalChange {
  /** SHA of the first commit. */
  id: string;
  shas: string[];
  /** Latest committer date among the commits, unix seconds. */
  committerDate: number;
  /** Distinct mapped author emails. */
  authors: string[];
  /** Files left after filtering, as of this change. */
  files: HistoryChange[];
  /** More files than the maximum changeset size: counts for frequency, not for coupling or spread. */
  oversized: boolean;
}

export interface FiltersApplied {
  excludeGlobs: string[];
  lockfiles: boolean;
  gitattributes: boolean;
  blameIgnoreRevs: string | null;
  botPatterns: string[];
  maxChangesetSize: number;
  excludeImported: boolean;
  /** What was dropped, so a reader can see how much each filter removed. */
  dropped: {
    outsideWindow: number;
    shallowBoundaryCommits: number;
    importedCommits: number;
    blameIgnoredCommits: number;
    botCommits: number;
    pureRenames: number;
    excludedByGlob: number;
    lockfiles: number;
    generated: number;
    vendored: number;
    emptyAfterFiltering: number;
  };
  oversizedChanges: number;
}

export interface FilteredHistory {
  changes: LogicalChange[];
  imported: ImportedHistory[];
  filtersApplied: FiltersApplied;
}

const isPureRename = (c: HistoryChange) =>
  c.status === "R" && c.similarity === 100 && (c.added ?? 0) === 0 && (c.deleted ?? 0) === 0;

/**
 * Applies the noise filters to a view at query time, so changing any option
 * gives a new answer without touching the cache.
 */
export async function filterHistory(
  repoPath: string,
  view: HistoryView,
  options: NoiseOptions = {},
): Promise<FilteredHistory> {
  const maxChangesetSize = options.maxChangesetSize ?? DEFAULT_MAX_CHANGESET_SIZE;
  const lockfileNames = options.lockfiles === false ? [] : (options.lockfiles ?? DEFAULT_LOCKFILES);
  const lockfileSet = new Set(lockfileNames);
  const useAttributes = options.gitattributes ?? true;
  const blameFile = options.blameIgnoreRevs === undefined ? ".git-blame-ignore-revs" : options.blameIgnoreRevs;
  const botPatterns = options.botPatterns ?? [];
  const excludeImported = options.excludeImported ?? true;
  const excluded = compileGlobs(options.exclude ?? []);
  const bots = botPatterns.map((p) => new RegExp(p, "i"));

  const treeFiles = await listTree(repoPath, view.headSha);
  const imported = detectImportedHistory(view, treeFiles, options.importDetection);
  const importedShas = new Set(excludeImported ? imported.map((i) => i.sha) : []);
  const ignoredRevs = blameFile === false ? [] : await readBlameIgnoreRevs(repoPath, view.headSha, blameFile);
  const attributes = useAttributes
    ? await readPathAttributes(
        repoPath,
        view.headSha,
        [...new Set(view.commits.flatMap((c) => c.changes.map((ch) => ch.path)))].sort(),
        treeFiles,
      )
    : { generated: new Set<string>(), vendored: new Set<string>() };

  const dropped = {
    outsideWindow: 0,
    shallowBoundaryCommits: 0,
    importedCommits: 0,
    blameIgnoredCommits: 0,
    botCommits: 0,
    pureRenames: 0,
    excludedByGlob: 0,
    lockfiles: 0,
    generated: 0,
    vendored: 0,
    emptyAfterFiltering: 0,
  };
  const changes: LogicalChange[] = [];

  const commitDropped = (commit: HistoryCommit): boolean => {
    if (options.since !== undefined && commit.committerDate < options.since) return countOut("outsideWindow");
    if (options.until !== undefined && commit.committerDate >= options.until) return countOut("outsideWindow");
    if (commit.boundary) return countOut("shallowBoundaryCommits");
    if (importedShas.has(commit.sha)) return countOut("importedCommits");
    if (ignoredRevs.some((rev) => commit.sha.startsWith(rev))) return countOut("blameIgnoredCommits");
    const author = `${commit.mappedName} <${commit.mappedEmail}>`;
    if (bots.some((re) => re.test(author))) return countOut("botCommits");
    return false;
  };
  function countOut(key: keyof typeof dropped): true {
    dropped[key]++;
    return true;
  }

  for (const commit of view.commits) {
    if (commitDropped(commit)) continue;
    const files: HistoryChange[] = [];
    for (const change of commit.changes) {
      if (isPureRename(change)) {
        dropped.pureRenames++;
      } else if (excluded(change.path)) {
        dropped.excludedByGlob++;
      } else if (lockfileSet.has(change.path.slice(change.path.lastIndexOf("/") + 1))) {
        dropped.lockfiles++;
      } else if (attributes.generated.has(change.path)) {
        dropped.generated++;
      } else if (attributes.vendored.has(change.path)) {
        dropped.vendored++;
      } else {
        files.push(change);
      }
    }
    if (files.length === 0) {
      dropped.emptyAfterFiltering++;
      continue;
    }
    changes.push({
      id: commit.sha,
      shas: [commit.sha],
      committerDate: commit.committerDate,
      authors: [commit.mappedEmail],
      files,
      oversized: files.length > maxChangesetSize,
    });
  }

  return {
    changes,
    imported,
    filtersApplied: {
      excludeGlobs: [...(options.exclude ?? [])],
      lockfiles: lockfileNames.length > 0,
      gitattributes: useAttributes,
      blameIgnoreRevs: blameFile === false ? null : blameFile,
      botPatterns: [...botPatterns],
      maxChangesetSize,
      excludeImported,
      dropped,
      oversizedChanges: changes.filter((c) => c.oversized).length,
    },
  };
}
