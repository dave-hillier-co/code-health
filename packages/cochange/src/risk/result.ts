import type { Assessed } from "./assess.ts";

const FILES_SHOWN = 50;

/** The change as the output describes it: counts, and the files it touches up to a limit. */
export function describeChange(assessed: Assessed) {
  const { change } = assessed;
  const added = change.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = change.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return {
    base: change.base,
    head: change.head,
    against: change.against,
    worktree: change.worktree,
    commits: change.commits.length,
    files: change.files.length,
    added,
    deleted,
    moved: change.moved,
    filteredPaths: change.filtered,
    agentCommits: change.agentCommits,
    paths: change.files.slice(0, FILES_SHOWN).map((file) => ({
      path: file.path,
      status: file.status,
      added: file.added,
      deleted: file.deleted,
    })),
    pathsNotShown: Math.max(0, change.files.length - FILES_SHOWN),
  };
}
