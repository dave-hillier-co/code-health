/**
 * The suite's one tree distance: `d(a, b) = depth(a) + depth(b) - 2 * depth(LCA(a, b))`
 * over the folder tree, with every file placed at its folder's depth. Every
 * plugin measures distance through this function.
 */

function assertPath(path: string): void {
  if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw new Error(`not a repo-relative POSIX path: "${path}"`);
  }
}

/** The folder a file lives in. Files at the repository root live in the root folder, `""`. */
export function folderOf(path: string): string {
  assertPath(path);
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Depth of a folder: the root `""` is 0. A file has the depth of its folder. */
export function depthOf(folder: string): number {
  return folder === "" ? 0 : folder.split("/").length;
}

function commonDepth(a: string, b: string): number {
  if (a === "" || b === "") return 0;
  const left = a.split("/");
  const right = b.split("/");
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

/** Distance between two folders, given as repo-relative POSIX paths (`""` is the root). */
export function folderDistance(a: string, b: string): number {
  return depthOf(a) + depthOf(b) - 2 * commonDepth(a, b);
}

/** Distance between two files, given as repo-relative POSIX paths. */
export function treeDistance(a: string, b: string): number {
  return folderDistance(folderOf(a), folderOf(b));
}
