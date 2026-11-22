import { usageError } from "@code-health/cli-kit/errors";
import { builtinExcluder } from "@code-health/history/builtin-excludes";
import { runGit } from "@code-health/history/git";
import { untrackedFiles } from "@code-health/parse/source-tree";
import type { ComplexitySettings } from "./config.ts";

export interface Revision {
  /** How the revision was named, or how it was found. */
  rev: string;
  sha: string;
}

export async function resolveRevision(root: string, rev: string): Promise<Revision> {
  try {
    const sha = (await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
    if (sha !== "") return { rev, sha };
  } catch {
    // Fall through to the usage error: git exits 1 for an unknown revision.
  }
  throw usageError(`unknown revision "${rev}"`);
}

const mainBranchCandidates = ["origin/main", "main", "origin/master", "master"];

/**
 * The base `check` compares against when `--base` is not given: `complexity.base`, or the merge base of
 * HEAD with the main branch (`complexity.mainBranch`, or the first of origin/main, main, origin/master and
 * master that exists).
 */
export async function defaultBase(root: string, settings: ComplexitySettings): Promise<Revision> {
  if (settings.base !== null) return resolveRevision(root, settings.base);
  const candidates = settings.mainBranch === null ? mainBranchCandidates : [settings.mainBranch];
  for (const candidate of candidates) {
    let main: Revision;
    try {
      main = await resolveRevision(root, candidate);
    } catch {
      continue;
    }
    try {
      const sha = (await runGit(root, ["merge-base", "HEAD", main.sha])).trim();
      return { rev: `merge base of HEAD and ${candidate}`, sha };
    } catch {
      throw usageError(`HEAD and ${candidate} share no history, so there is no merge base; pass --base REV`);
    }
  }
  throw usageError(
    settings.mainBranch === null
      ? `no main branch found (tried ${candidates.join(", ")}); pass --base REV or set complexity.base or complexity.mainBranch`
      : `the main branch "${settings.mainBranch}" does not exist; pass --base REV or fix complexity.mainBranch`,
  );
}

/**
 * Paths that differ between `base` and a revision, or between `base` and the working tree when `head` is
 * null (which also lists untracked files). Renames are reported as a delete and an add, so that a moved
 * function is found on both sides and matched by body.
 */
export async function changedPaths(root: string, base: string, head: string | null): Promise<string[]> {
  const diffArgs = ["diff", "--name-only", "--no-renames", "-z", base];
  const changed = (await runGit(root, head === null ? diffArgs : [...diffArgs, head])).split("\0");
  if (head === null) changed.push(...(await untrackedFiles(root)));
  const omitted = builtinExcluder(root, [], { record: false });
  return [...new Set(changed.filter((path) => path !== "" && !omitted(path)))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
