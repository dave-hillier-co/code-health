import { GitError, runGit } from "./git.ts";
import type { StoredFile } from "./blame-store.ts";

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false; // 1: not an ancestor. Anything else: a commit that no longer exists.
    throw error;
  }
}

/** Every path any commit in `range` changed, merge resolutions included, with renames shown as a delete and an add. */
async function pathsChangedIn(root: string, range: string): Promise<Set<string>> {
  const out = await runGit(root, ["log", "-c", "--no-renames", "--name-only", "-z", "--format=", range]);
  return new Set(out.split("\0").filter((p) => p !== ""));
}

/**
 * The paths changed between two commits, one the ancestor of the other, or null when
 * neither is (a rewritten or unrelated branch, or a commit that is gone).
 */
async function changedBetween(root: string, a: string, b: string): Promise<Set<string> | null> {
  if (a === b) return new Set();
  if (await isAncestor(root, a, b)) return pathsChangedIn(root, `${a}..${b}`);
  if (await isAncestor(root, b, a)) return pathsChangedIn(root, `${b}..${a}`);
  return null;
}

/**
 * The stored files whose blame is still the blame at `sha`.
 *
 * A file's blame is fixed by its blob and the history behind it, and the same blob
 * can have different blames: a file reverted to earlier content is blamed on the
 * revert, not on the commit that first wrote the content. A stored blame is therefore
 * reused only when its blob is the one at `sha` and nothing between the commit it
 * was made at and `sha` changed the path, which one `git log` per distinct stored
 * commit settles for every file. Blames made on a branch that is not an ancestor or a
 * descendant of `sha` are not reused.
 */
export async function reusableFiles(root: string, sha: string, stored: readonly StoredFile[], wanted: ReadonlyMap<string, string>): Promise<StoredFile[]> {
  const matching = stored.filter((f) => wanted.get(f.path) === f.blob);
  const changedSince = new Map<string, Set<string> | null>();
  for (const atCommit of new Set(matching.map((f) => f.atCommit))) {
    changedSince.set(atCommit, await changedBetween(root, atCommit, sha));
  }
  return matching.filter((f) => {
    const changed = changedSince.get(f.atCommit);
    return changed !== null && changed !== undefined && !changed.has(f.path);
  });
}
