import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** The real path of a file that may not exist yet: its directory is resolved, the name is kept. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

const inside = (root: string, path: string): string | undefined => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
};

/**
 * A path as an agent or a tool reports it, made repo-relative POSIX: no `./`,
 * and an absolute path inside the repository relativised, whether or not it
 * goes through a symbolic link (macOS temporary directories do). A path
 * outside the repository is returned unchanged.
 */
export function repoRelative(root: string, raw: string): string {
  let path = raw;
  if (isAbsolute(path)) {
    path = inside(root, path) ?? inside(realish(root), realish(path)) ?? path;
  }
  if (sep !== "/") path = path.split(sep).join("/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}
