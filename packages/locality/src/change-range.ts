import { usageError } from "@code-health/cli-kit/errors";
import { runGit } from "@code-health/history/git";

export interface ChangeRange {
  /** The commit the change starts from: the merge base of the named base and the tip. */
  base: string;
  head: string;
  /** What the base was taken against: the ref named, the main branch, or the first parent of the tip. */
  against: string;
}

const git = async (root: string, args: string[]): Promise<string> => (await runGit(root, args)).trim();

async function exists(root: string, ref: string): Promise<boolean> {
  try {
    await runGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The branch changes are merged into: the remote's default, then `main`, then `master`. */
async function mainBranch(root: string): Promise<string | null> {
  try {
    const remote = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (remote !== "" && (await exists(root, remote))) return remote.replace(/^refs\/remotes\//, "");
  } catch {
    // no remote default
  }
  for (const candidate of ["main", "master"]) if (await exists(root, candidate)) return candidate;
  return null;
}

export const FIRST_PARENT = "the first parent of HEAD";

/**
 * Resolves `BASE`, `BASE..HEAD` or `BASE...HEAD` to a merge base and a tip, as `cochange risk` reads a range. With
 * no range, the change is the branch since its merge base with the main branch, and when the tip is already on the
 * main branch it is the tip's own change: its first parent to the tip.
 */
export async function resolveChangeRange(root: string, range: string | undefined): Promise<ChangeRange> {
  const parts = range === undefined ? null : /^(.*?)(\.\.\.?)(.*)$/.exec(range);
  const named = parts === null ? range : parts[1] || undefined;
  const tip = parts === null ? "HEAD" : parts[3] || "HEAD";
  if (!(await exists(root, tip))) throw usageError(`"${tip}" is not a commit in this repository`);
  const head = await git(root, ["rev-parse", `${tip}^{commit}`]);
  const against = named ?? (await mainBranch(root));
  if (against === null) throw usageError("there is no main branch to take the base from: name one with measure change BASE");
  if (!(await exists(root, against))) throw usageError(`"${against}" is not a commit in this repository`);
  let base: string;
  try {
    base = await git(root, ["merge-base", against, head]);
  } catch {
    throw usageError(`"${against}" and "${tip}" have no common ancestor`);
  }
  if (base === head) {
    if (named !== undefined) throw usageError(`"${against}" contains "${tip}", so there is no change between them`);
    if (!(await exists(root, `${head}^1`))) throw usageError("HEAD is the first commit, so there is no earlier revision to compare with");
    return { base: await git(root, ["rev-parse", `${head}^1`]), head, against: FIRST_PARENT };
  }
  return { base, head, against };
}

/** Files renamed between two commits, as git detects them: the path at `base` to the path at `head`. */
export async function renamesBetween(root: string, base: string, head: string): Promise<Map<string, string>> {
  const fields = (await runGit(root, ["diff", "-z", "-M", "--no-ext-diff", "--name-status", "--diff-filter=R", base, head])).split("\0");
  const renames = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) renames.set(fields[i + 1]!, fields[i + 2]!);
  return renames;
}
