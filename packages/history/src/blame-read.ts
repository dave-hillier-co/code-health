import { resolveBlameOptions, type BlameSettings } from "./blame-options.ts";
import { authoredFilesAt, type BlameRange } from "./blame-lines.ts";
import { reusableFiles } from "./blame-reuse.ts";
import { openBlameForRead, storedFiles, storedRanges } from "./blame-store.ts";
import { locateCache } from "./cache-location.ts";
import { resolveRef } from "./refresh.ts";

export interface BlameReadOptions extends BlameSettings {
  /** The analysed ref. Defaults to HEAD. */
  ref?: string;
  /** Globs of paths left out. Use the same as the refresh that filled the cache. */
  exclude?: readonly string[];
  /** Read only these files (repo-relative POSIX paths). */
  paths?: readonly string[];
}

export interface FileBlame {
  path: string;
  blob: string;
  lines: number;
  /** Ordered by line, covering every line of the file. */
  ranges: BlameRange[];
}

export interface BlameSnapshot {
  /** Commit the ref resolved to. */
  headSha: string;
  optionsId: string;
  /** Files with at least one line, by path. */
  files: Map<string, FileBlame>;
  /**
   * Authored files at the ref that the cache holds no right blame for, sorted: never
   * refreshed, or changed since. Their authorship is unknown, not zero. Empty after a
   * refresh of the same ref, options and paths.
   */
  missing: string[];
}

/**
 * The line authorship the cache holds for the tree at `ref`. Never runs a blame and
 * never writes: run `refreshBlame` first. A stored blame is used only when it is
 * still the blame at the ref (see `reusableFiles`), so the snapshot of a ref is
 * the same whichever refs the cache was last refreshed at. Without a cache every
 * authored file is `missing`.
 */
export async function readBlame(repoPath: string, options: BlameReadOptions = {}): Promise<BlameSnapshot> {
  const location = await locateCache(repoPath);
  const root = location.repoRoot;
  const headSha = await resolveRef(root, options.ref ?? "HEAD");
  const settings = await resolveBlameOptions(root, headSha, options);
  const wantedPaths = options.paths === undefined ? undefined : new Set(options.paths);
  const authored = (await authoredFilesAt(root, headSha, options.exclude)).filter((f) => wantedPaths === undefined || wantedPaths.has(f.path));
  const wanted = new Map(authored.map((f) => [f.path, f.blob]));

  const db = openBlameForRead(location.blamePath);
  const files = new Map<string, FileBlame>();
  if (!db) return { headSha, optionsId: settings.id, files, missing: [...wanted.keys()].sort() };
  try {
    const reusable = await reusableFiles(root, headSha, storedFiles(db, settings.id), wanted);
    const found = new Set<string>();
    for (const f of reusable) {
      found.add(f.path);
      if (f.lines > 0) files.set(f.path, { path: f.path, blob: f.blob, lines: f.lines, ranges: storedRanges(db, settings.id, f.path, f.blob) });
    }
    const missing = [...wanted.keys()].filter((path) => !found.has(path)).sort();
    return { headSha, optionsId: settings.id, files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), missing };
  } finally {
    db.close();
  }
}
