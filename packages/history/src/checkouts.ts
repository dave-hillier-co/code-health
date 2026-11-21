import { runGit } from "./git.ts";

/**
 * Every checkout of the repository that sessions may have run in: this one, then its linked worktrees. A
 * session in a worktree is work on this repository, and its paths are repo-relative once the worktree root is removed.
 */
export async function checkouts(root: string): Promise<string[]> {
  const listing = await runGit(root, ["worktree", "list", "--porcelain"]);
  const others = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path !== root);
  return [root, ...others.sort()];
}
