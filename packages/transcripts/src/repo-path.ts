import { posix } from "node:path";

function normalise(path: string): string {
  const converted = path.replaceAll("\\", "/");
  const drive = /^[A-Za-z]:\//.exec(converted);
  if (drive === null) return posix.normalize(converted);
  return drive[0] + posix.normalize(converted.slice(drive[0].length));
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Turns a path from a tool call into a repo-relative POSIX path, or null when it
 * lies outside the repo. `roots` lists every checkout of the repo that sessions
 * may have run in (the main checkout and any worktrees); the longest matching
 * root wins, so a worktree nested inside the main checkout maps to its own files.
 */
export function toRepoPath(path: string | null, roots: readonly string[]): string | null {
  if (path === null || path === "") return null;
  const normalised = normalise(path);
  if (!isAbsolute(normalised)) {
    return normalised === "." || normalised === ".." || normalised.startsWith("../") ? null : normalised;
  }
  const ordered = roots.map((root) => stripTrailingSlash(normalise(root))).sort((a, b) => b.length - a.length);
  for (const root of ordered) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (normalised.startsWith(prefix)) {
      const relative = normalised.slice(prefix.length);
      return relative === "" ? null : stripTrailingSlash(relative);
    }
  }
  return null;
}
