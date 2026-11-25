import { compareIds } from "./graph.ts";
import { depthOf } from "./tree-distance.ts";

/** What the folder listing needs of a folder's figures: how many files are under it, its subfolders included. */
export interface FolderSize {
  files: number;
}

/** A folder and every folder above it, the repository root `""` first. */
export function withAncestors(folder: string): string[] {
  if (folder === "") return [""];
  const parts = folder.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

/**
 * The folder the listing starts under: the deepest folder that holds every counted file, so a repository whose
 * code is all under `src` or `packages` lists the folders inside it and not that one folder alone.
 */
export function commonRoot(figures: ReadonlyMap<string, FolderSize>): string {
  const total = figures.get("")?.files ?? 0;
  let root = "";
  for (;;) {
    const depth = depthOf(root) + 1;
    const next = [...figures].find(([folder, figure]) => depthOf(folder) === depth && (root === "" || folder.startsWith(`${root}/`)) && figure.files === total);
    if (next === undefined || total === 0) return root;
    root = next[0];
  }
}

/** The folders at most `levels` below `root`, in path order, so each folder follows the one that holds it. */
export function foldersBelow(figures: ReadonlyMap<string, FolderSize>, root: string, levels: number): string[] {
  const base = depthOf(root);
  return [...figures.keys()]
    .filter((folder) => folder !== root && (root === "" || folder.startsWith(`${root}/`)) && depthOf(folder) <= base + levels)
    .sort(compareIds);
}
