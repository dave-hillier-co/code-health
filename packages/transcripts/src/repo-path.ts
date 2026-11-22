/**
 * Maps the paths in tool calls to repo-relative paths. Claude Code worktrees live at
 * `<repo>/.claude/worktrees/<name>/` and are deleted once their work is merged, after which `git worktree list`
 * no longer names them, so the mapping does not depend on it: a path under `<root>/.claude/worktrees/<name>/`
 * maps to the same relative path in the repo, for any root given. The checkouts a caller lists (the main
 * checkout, live worktrees, a subagent's meta `worktreePath`) are matched first, longest first, and the path rule
 * covers every other worktree. A worktree is recognised only by its path, never by reading the file system.
 */
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

/** Directories whose files are ignored or vendored, so reading them is not reading the repo's own code. */
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules"]);

function isExcluded(relative: string): boolean {
  return relative.split("/").some((part) => EXCLUDED_SEGMENTS.has(part));
}

/** Windows drive paths compare case-insensitively, because the file system does. */
function comparable(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

const WORKTREE_BELOW_ROOT = /^\.claude\/worktrees\/[^/]+(?:\/(.*))?$/;
const WORKTREE_ROOT = /^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/;

/**
 * The checkout root of a Claude Code worktree that `path` lies in (`<repo>/.claude/worktrees/<name>`), or null when
 * it is not under one. It needs no `git worktree list`, so it names worktrees that have since been deleted.
 */
export function worktreeRootOf(path: string): string | null {
  const match = WORKTREE_ROOT.exec(normalise(path));
  return match === null ? null : match[1]!;
}

/**
 * The part of `path` below the longest root that contains it, "" for the root itself, or null when outside every root.
 * A path under `<root>/.claude/worktrees/<name>/` maps to the same relative path in the repo, whether or not that
 * worktree is among the roots, because Claude Code worktrees are deleted after the work is done.
 */
function relativeToRoots(path: string, roots: readonly string[]): string | null {
  const ordered = roots.map((root) => stripTrailingSlash(normalise(root))).sort((a, b) => b.length - a.length);
  for (const root of ordered) {
    let relative: string;
    if (comparable(path) === comparable(root)) return "";
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (comparable(path).startsWith(comparable(prefix))) relative = stripTrailingSlash(path.slice(prefix.length));
    else continue;
    const worktree = WORKTREE_BELOW_ROOT.exec(relative);
    return worktree === null ? relative : stripTrailingSlash(worktree[1] ?? "");
  }
  return null;
}

/**
 * True when a tool call's path lies in the repo or is the repo root itself. A missing path counts as in the
 * repo, because tools default to the working directory. Used to count searches only when they search the repo.
 */
export function isWithinRepo(path: string | null, roots: readonly string[]): boolean {
  if (path === null || path === "") return true;
  if (path.startsWith("~")) return false;
  const normalised = normalise(path);
  if (!isAbsolute(normalised)) return !(normalised === ".." || normalised.startsWith("../"));
  return relativeToRoots(normalised, roots) !== null;
}

/**
 * Turns a path from a tool call into a repo-relative POSIX path, or null when it lies outside the repo,
 * names a home-relative location (`~`), or sits under `.git` or `node_modules`. `roots` lists every checkout
 * of the repo that sessions may have run in (the main checkout and any worktrees); the longest matching
 * root wins, so a worktree nested inside the main checkout maps to its own files. Symlinks are not resolved:
 * a path reached through a link to a root is outside it.
 */
export function toRepoPath(path: string | null, roots: readonly string[]): string | null {
  if (path === null || path === "" || path.startsWith("~")) return null;
  const normalised = normalise(path);
  let relative: string | null;
  if (isAbsolute(normalised)) {
    relative = relativeToRoots(normalised, roots);
  } else {
    relative = normalised === "." || normalised === ".." || normalised.startsWith("../") ? null : normalised;
  }
  if (relative === null || relative === "" || isExcluded(relative)) return null;
  return relative;
}
