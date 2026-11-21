import type { HistoryView } from "./read.ts";

export interface ImportDetectionOptions {
  /** A root commit adding at least this share of the current tree is an import. Default 0.5. */
  share?: number;
  /** Trees smaller than this are never treated as imports. Default 20 files. */
  minFiles?: number;
}

export interface ImportedHistory {
  sha: string;
  /** Files the commit added that still exist at the ref. */
  files: number;
  /** Share of the current tree those files make up. */
  share: number;
  committerDate: number;
}

/**
 * Detects a history that begins mid-life: a commit at the start of the history
 * (not a shallow boundary) that adds a large share of the current tree, as a migration from
 * another VCS or a bulk "initial import" does. `treeFiles` are the files at the ref.
 */
export function detectImportedHistory(
  view: HistoryView,
  treeFiles: readonly string[],
  options: ImportDetectionOptions = {},
): ImportedHistory[] {
  const { share = 0.5, minFiles = 20 } = options;
  if (treeFiles.length < minFiles) return [];
  const current = new Set(treeFiles);
  const found: ImportedHistory[] = [];
  // Only the start of the history can be an import: a root commit, or a commit
  // that arrives before the history has built up (a near-empty root followed by
  // a bulk "import from svn" commit).
  let addedBefore = 0;
  for (const commit of view.commits) {
    const atStart = commit.parentCount === 0 || addedBefore < minFiles;
    addedBefore += commit.changes.filter((c) => c.status === "A").length;
    if (!atStart || commit.boundary) continue;
    const kept = new Set(
      commit.changes.filter((c) => c.status === "A" && current.has(c.fileId)).map((c) => c.fileId),
    );
    const ratio = kept.size / treeFiles.length;
    if (ratio >= share) {
      found.push({ sha: commit.sha, files: kept.size, share: ratio, committerDate: commit.committerDate });
    }
  }
  return found;
}
