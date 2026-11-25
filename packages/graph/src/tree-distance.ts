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
  if (folder === "") return 0;
  let depth = 1;
  for (let at = folder.indexOf("/"); at !== -1; at = folder.indexOf("/", at + 1)) depth++;
  return depth;
}

const SLASH = 47;

/** How many leading folder names two folders share. Read character by character, since the analysis asks it for every candidate target of every unit. */
function commonDepth(a: string, b: string): number {
  if (a === "" || b === "") return 0;
  const shorter = Math.min(a.length, b.length);
  let shared = 0;
  for (let at = 0; at < shorter; at++) {
    const code = a.charCodeAt(at);
    if (code !== b.charCodeAt(at)) return shared;
    if (code === SLASH) shared++;
  }
  // One is the other, or the other with more names after a slash.
  if (a.length === b.length) return shared + 1;
  return (a.length > shorter ? a : b).charCodeAt(shorter) === SLASH ? shared + 1 : shared;
}

/** Distance between two folders, given as repo-relative POSIX paths (`""` is the root). */
export function folderDistance(a: string, b: string): number {
  return depthOf(a) + depthOf(b) - 2 * commonDepth(a, b);
}

/** Distance between two files, given as repo-relative POSIX paths. */
export function treeDistance(a: string, b: string): number {
  return folderDistance(folderOf(a), folderOf(b));
}
