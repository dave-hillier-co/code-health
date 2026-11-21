import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { treeFromRef, treeFromWorkingTree, type SourceTree } from "@code-health/parse/source-tree";

export interface CurrentTree {
  tree: SourceTree;
  /** `head` for a clean tree, `working-tree` when there is uncommitted work, so work in progress is measured. */
  kind: "head" | "working-tree";
}

/**
 * Whether the working tree holds anything the commit at HEAD does not: edits to tracked files, or new files
 * that are not ignored. The repository state of the CLI kit counts only the first.
 */
export async function hasUncommittedWork(context: CommandContext): Promise<boolean> {
  if (context.repo.dirty) return true;
  return (await runGit(context.repo.root, ["ls-files", "--others", "--exclude-standard", "-z"])) !== "";
}

/** The code as it stands: the commit at HEAD when the tree is clean, otherwise the files on disk. */
export async function currentTree(context: CommandContext): Promise<CurrentTree> {
  if (await hasUncommittedWork(context)) return { tree: await treeFromWorkingTree(context.repo.root), kind: "working-tree" };
  return { tree: await treeFromRef(context.repo.root, "HEAD"), kind: "head" };
}

/** Normalises path arguments to repo-relative POSIX paths without a leading `./` or trailing slash. */
export function normalisePaths(positionals: readonly string[]): string[] {
  return positionals.map((path) => path.replace(/^\.\//, "").replace(/\/+$/, "")).filter((path) => path !== "" && path !== ".");
}

/** Whether a path is one of the arguments or beneath one. No arguments selects everything. */
export function pathSelector(selected: readonly string[]): (path: string) => boolean {
  if (selected.length === 0) return () => true;
  return (path) => selected.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
