import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runGit } from "./git.ts";

export interface CacheLocation {
  /** Top level of the working tree being analysed. */
  repoRoot: string;
  /** Absolute path of the repository's common git directory. */
  gitDir: string;
  /** `.cache/code-health` directory. Shared by all linked worktrees. */
  cacheDir: string;
  dbPath: string;
  lockPath: string;
  /** Line authorship per file blob, kept apart from the history store so neither rebuilds the other. */
  blamePath: string;
  blameLockPath: string;
}

/**
 * Resolves where the shared cache lives for the repository containing
 * `repoPath`. Linked worktrees share the main worktree's cache, because the
 * history store is content-addressed.
 */
export async function locateCache(repoPath: string): Promise<CacheLocation> {
  const out = await runGit(repoPath, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  const [repoRoot, gitDir] = out.split("\n");
  if (!repoRoot || !gitDir) throw new Error(`Not a git working tree: ${repoPath}`);
  const cacheRoot = basename(gitDir) === ".git" ? dirname(gitDir) : repoRoot;
  const cacheDir = join(cacheRoot, ".cache", "code-health");
  return {
    repoRoot,
    gitDir,
    cacheDir,
    dbPath: join(cacheDir, "history.sqlite"),
    lockPath: join(cacheDir, "history.lock"),
    blamePath: join(cacheDir, "blame.sqlite"),
    blameLockPath: join(cacheDir, "blame.lock"),
  };
}

/** Creates the cache directory and, on first use, its self-ignoring `.gitignore`. */
export function ensureCacheDir(location: CacheLocation): void {
  ensureSelfIgnoring(location.cacheDir);
}

/** Creates a directory that git ignores everything in, by a `.gitignore` of `*` inside it. */
export function ensureSelfIgnoring(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const ignore = join(directory, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}
