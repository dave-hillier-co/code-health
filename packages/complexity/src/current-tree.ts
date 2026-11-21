import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { treeFromRef, treeFromWorkingTree, type SourceTree } from "@code-health/parse/source-tree";

export interface CurrentTree {
  tree: SourceTree;
  /** `head` for a clean tree, `working-tree` when there are uncommitted changes, so the work in progress is measured. */
  kind: "head" | "working-tree";
}

/** The code as it stands: the commit at HEAD when the tree is clean, otherwise the files on disk. */
export async function currentTree(context: CommandContext): Promise<CurrentTree> {
  if (context.repo.dirty) return { tree: await treeFromWorkingTree(context.repo.root), kind: "working-tree" };
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
