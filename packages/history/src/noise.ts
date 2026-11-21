import { compileGlobs } from "./glob.ts";
import { groupCommits, mergeFileChanges, type Grouping } from "./grouping.ts";
import { detectImportedHistory, type ImportDetectionOptions, type ImportedHistory } from "./imported.ts";
import type { HistoryChange, HistoryCommit, HistoryView } from "./read.ts";
import { hasCodeHealthTrailer } from "./trailers.ts";
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

/** A configured pattern is not a valid regular expression. */
export class InvalidPatternError extends Error {
  readonly pattern: string;

  constructor(pattern: string, reason: string, kind = "bot pattern") {
    super(`invalid ${kind} "${pattern}": ${reason}`);
    this.name = "InvalidPatternError";
    this.pattern = pattern;
  }
}

function compileBotPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new InvalidPatternError(pattern, error instanceof Error ? error.message : String(error));
  }
}

/** One entry per file over the commits of a group, in order of first appearance. */
function mergeAcrossCommits(perCommit: readonly (readonly HistoryChange[])[]): HistoryChange[] {
  const byFile = new Map<string, HistoryChange[]>();
  for (const files of perCommit) {
    for (const file of files) {
      const entries = byFile.get(file.fileId);
      if (entries) entries.push(file);
      else byFile.set(file.fileId, [file]);
    }
  }
  return [...byFile.values()].map(mergeFileChanges);
}

function compileIssuePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new InvalidPatternError(pattern, error instanceof Error ? error.message : String(error), "issue pattern");
  }
}

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
  /**
   * Drop commits that carry a `Code-Health:` trailer, the suite's own refactoring
   * commits, which are wide by construction. Every window that measures outcomes
   * should set this. Default false: such commits are kept, flagged `suiteCommit`.
   */
  excludeSuiteCommits?: boolean;
  /** How surviving commits form logical changes. Default: each commit is its own change. */
  grouping?: Grouping;
  importDetection?: ImportDetectionOptions;
  /** Window, in unix seconds of committer date. `since` is inclusive, `until` exclusive. */
  since?: number;
  until?: number;
}

/**
 * One unit of intent. With grouping off (the default) every commit is its own
 * logical change. Grouping by issue key or author window merges several commits
 * here: `files` is then the union over the commits, one entry per file.
 */
export interface LogicalChange {
  /** SHA of the first commit. */
  id: string;
  /** The commits of the change, oldest first. */
  shas: string[];
  /** Latest committer date among the commits, unix seconds. */
  committerDate: number;
  /** Distinct mapped author emails. */
  authors: string[];
  /** Files left after filtering, as of this change. */
  files: HistoryChange[];
  /** More files than the maximum changeset size: counts for frequency, not for coupling or spread. */
  oversized: boolean;
  /** Some commit carries a `Code-Health:` trailer: the change was made through the suite's skills. */
  suiteCommit: boolean;
}

export interface FiltersApplied {
  excludeGlobs: string[];
  lockfiles: boolean;
  gitattributes: boolean;
  blameIgnoreRevs: string | null;
  botPatterns: string[];
  maxChangesetSize: number;
  excludeImported: boolean;
  excludeSuiteCommits: boolean;
  /** How commits were grouped into logical changes, and how many were folded into another change. */
  grouping: {
    mode: Grouping["mode"];
    issuePattern: string | null;
    windowSeconds: number | null;
    mergedCommits: number;
  };
  /** What was dropped, so a reader can see how much each filter removed. */
  dropped: {
    outsideWindow: number;
    shallowBoundaryCommits: number;
    importedCommits: number;
    blameIgnoredCommits: number;
    botCommits: number;
    suiteCommits: number;
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
  const excludeSuiteCommits = options.excludeSuiteCommits ?? false;
  const grouping: Grouping = options.grouping ?? { mode: "off" };
  const excluded = compileGlobs(options.exclude ?? []);
  const bots = botPatterns.map(compileBotPattern);

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
    suiteCommits: 0,
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
    if (excludeSuiteCommits && hasCodeHealthTrailer(commit.message)) return countOut("suiteCommits");
    return false;
  };
  function countOut(key: keyof typeof dropped): true {
    dropped[key]++;
    return true;
  }

  const survivors: { commit: HistoryCommit; files: HistoryChange[] }[] = [];
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
    survivors.push({ commit, files });
  }

  const groups = groupCommits(
    survivors.map(({ commit }) => ({ message: commit.message, author: commit.mappedEmail, date: commit.committerDate })),
    grouping,
    compileIssuePattern,
  );
  for (const group of groups) {
    const members = group.map((index) => survivors[index]!);
    // A single commit keeps its entries exactly as recorded. Only commits grouped together merge.
    const files = members.length === 1 ? members[0]!.files : mergeAcrossCommits(members.map((m) => m.files));
    changes.push({
      id: members[0]!.commit.sha,
      shas: members.map(({ commit }) => commit.sha),
      committerDate: Math.max(...members.map(({ commit }) => commit.committerDate)),
      authors: [...new Set(members.map(({ commit }) => commit.mappedEmail))],
      files,
      oversized: files.length > maxChangesetSize,
      suiteCommit: members.some(({ commit }) => hasCodeHealthTrailer(commit.message)),
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
      excludeSuiteCommits,
      grouping: {
        mode: grouping.mode,
        issuePattern: grouping.mode === "issue-key" ? grouping.pattern : null,
        windowSeconds: grouping.mode === "author-window" ? grouping.windowSeconds : null,
        mergedCommits: survivors.length - changes.length,
      },
      dropped,
      oversizedChanges: changes.filter((c) => c.oversized).length,
    },
  };
}
