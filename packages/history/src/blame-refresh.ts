import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBlameOptions, type BlameSettings } from "./blame-options.ts";
import { authoredFilesAt, parseBlameRanges, textFilesAt } from "./blame-lines.ts";
import { reusableFiles } from "./blame-reuse.ts";
import { countFiles, fileKey, moveFilesTo, openBlameForRead, openBlameForWrite, pruneFiles, putBlamedFiles, storedFiles, type BlamedFile } from "./blame-store.ts";
import { ensureCacheDir, locateCache } from "./cache-location.ts";
import { runGit } from "./git.ts";
import { lockIsHeld, withLock, type LockOptions } from "./lock.ts";
import { resolveRef } from "./refresh.ts";

export interface BlameProgress {
  /** Files blamed so far in this refresh. */
  done: number;
  /** Files this refresh has to blame. */
  total: number;
}

export interface BlameRefreshOptions extends BlameSettings {
  /** The analysed ref. Defaults to HEAD. */
  ref?: string;
  /** Globs of paths left out, usually the suite's `exclude`. */
  exclude?: readonly string[];
  /**
   * Blame only these files (repo-relative POSIX paths), as a change-risk placement needs
   * the files a change touches. Other stored blames are kept, not pruned.
   */
  paths?: readonly string[];
  /** Blames running at once. Default 8. */
  concurrency?: number;
  /** Files finished between writes to the store. An interrupted refresh keeps them. Default 50. */
  batchSize?: number;
  /** Called after each file is blamed, so a long first run can report progress. */
  onProgress?: (progress: BlameProgress) => void;
  /** Stops the refresh after the files in flight; what finished stays stored, and the next refresh resumes. */
  signal?: AbortSignal;
  lock?: LockOptions;
}

export interface BlameRefreshResult {
  /** Commit the ref resolved to, and the commit every stored blame is now known to be right at. */
  headSha: string;
  /** Names the options the blames were made with (`-w -M`, `-C` unless turned off, the ignored revisions). */
  optionsId: string;
  /** Files that hold authored code at the ref (or the requested paths among them). */
  files: number;
  /** Files blamed by this refresh. */
  blamed: number;
  /** Files whose stored blame was still right. */
  reused: number;
  /** Files with no lines to blame: binary or empty. */
  noText: number;
  /** Files git could not blame. Not stored, tried again next time. */
  failed: string[];
  /** Stored blames dropped because their blob is no longer in the tree (not done for `paths`). */
  pruned: number;
  /** The cache was discarded and rebuilt (schema mismatch or damage). */
  rebuilt: boolean;
  /** The refresh stopped early because `signal` aborted. */
  aborted: boolean;
}

/**
 * Brings the shared blame cache up to date with `ref`: `git blame -w -M -C` of every
 * authored file whose stored blame is missing or no longer right (see `reusableFiles`),
 * and nothing else. Blames are stored as the commit behind each line range, per blob and
 * path, and carry no identities, so a mailmap or decision change never needs a re-blame.
 * Holds the blame lock, so concurrent refreshes are safe.
 */
export async function refreshBlame(repoPath: string, options: BlameRefreshOptions = {}): Promise<BlameRefreshResult> {
  const location = await locateCache(repoPath);
  const sha = await resolveRef(location.repoRoot, options.ref ?? "HEAD");
  ensureCacheDir(location);
  const root = location.repoRoot;

  if (lockIsHeld(location.blameLockPath, options.lock)) {
    const done = await alreadyRight(location.blamePath, root, sha, options);
    if (done) return done;
  }

  return withLock(
    location.blameLockPath,
    async (lock) => {
      const settings = await resolveBlameOptions(root, sha, options);
      const wantedPaths = options.paths === undefined ? undefined : new Set(options.paths);
      const authored = (await authoredFilesAt(root, sha, options.exclude)).filter((f) => wantedPaths === undefined || wantedPaths.has(f.path));
      const wanted = new Map(authored.map((f) => [f.path, f.blob]));
      lock.progress(`checking ${authored.length} files against the cache`);

      const { db, rebuilt } = openBlameForWrite(location.blamePath);
      try {
        const stored = storedFiles(db, settings.id);
        const reusable = await reusableFiles(root, sha, stored, wanted);
        const reusedKeys = new Set(reusable.map((f) => f.path));
        moveFilesTo(db, settings.id, sha, reusable.filter((f) => f.atCommit !== sha));

        const missing = authored.filter((f) => !reusedKeys.has(f.path));
        const text = await textFilesAt(root, sha, missing.map((f) => f.path));
        const toBlame = missing.filter((f) => text.has(f.path));
        const noText = missing.filter((f) => !text.has(f.path));
        const description = `-w -M${settings.copyDetection ? " -C" : ""}, ${settings.ignoreRevs.length} ignored revisions`;
        // Files with no lines are stored too, so they are not looked at again until their blob changes.
        putBlamedFiles(db, settings.id, description, sha, noText.map((f) => ({ path: f.path, blob: f.blob, ranges: [] })));

        const ignoreFile = settings.ignoreRevs.length > 0 ? join(location.cacheDir, `ignore-revs-${settings.id}.txt`) : undefined;
        if (ignoreFile) writeFileSync(ignoreFile, settings.ignoreRevs.join("\n") + "\n");
        const args = [
          "blame",
          "--incremental",
          "-w",
          "-M",
          ...(settings.copyDetection ? ["-C"] : []),
          ...(ignoreFile ? [`--ignore-revs-file=${ignoreFile}`] : []),
        ];

        const failed: string[] = [];
        const finished: BlamedFile[] = [];
        let blamed = 0;
        let next = 0;
        let aborted = false;
        const flush = () => {
          if (finished.length > 0) putBlamedFiles(db, settings.id, description, sha, finished.splice(0));
        };
        const batchSize = options.batchSize ?? 50;
        const worker = async () => {
          while (next < toBlame.length) {
            if (options.signal?.aborted) {
              aborted = true;
              return;
            }
            const file = toBlame[next++]!;
            try {
              const out = await runGit(root, [...args, sha, "--", file.path]);
              finished.push({ path: file.path, blob: file.blob, ranges: parseBlameRanges(out) });
              blamed++;
              lock.progress(`blamed ${blamed} of ${toBlame.length} files`);
              options.onProgress?.({ done: blamed, total: toBlame.length });
              if (finished.length >= batchSize) flush();
            } catch {
              failed.push(file.path); // for example a path git cannot blame
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, Math.max(toBlame.length, 1)) }, worker));
        } finally {
          flush();
          if (ignoreFile) rmSync(ignoreFile, { force: true });
        }

        let pruned = 0;
        if (wantedPaths === undefined && !aborted) {
          pruned = pruneFiles(db, new Set(authored.map((f) => fileKey(f.path, f.blob, settings.id))));
        }
        return {
          headSha: sha,
          optionsId: settings.id,
          files: authored.length,
          blamed,
          reused: reusable.length,
          noText: noText.length,
          failed: failed.sort(),
          pruned,
          rebuilt,
          aborted,
        };
      } finally {
        db.close();
      }
    },
    options.lock,
  );
}

/**
 * The result of a refresh that would change nothing, read without the lock: every wanted
 * file already has a right blame and, for a whole-tree refresh, nothing is left to prune.
 * Undefined when there is work to do. The store is in WAL mode, so this read sees the last
 * committed state of a refresh another process is running and never blocks it.
 */
async function alreadyRight(blamePath: string, root: string, sha: string, options: BlameRefreshOptions): Promise<BlameRefreshResult | undefined> {
  const db = openBlameForRead(blamePath);
  if (!db) return undefined;
  try {
    const settings = await resolveBlameOptions(root, sha, options);
    const wantedPaths = options.paths === undefined ? undefined : new Set(options.paths);
    const authored = (await authoredFilesAt(root, sha, options.exclude)).filter((f) => wantedPaths === undefined || wantedPaths.has(f.path));
    const reusable = await reusableFiles(root, sha, storedFiles(db, settings.id), new Map(authored.map((f) => [f.path, f.blob])));
    if (reusable.length !== authored.length) return undefined;
    if (wantedPaths === undefined && countFiles(db) !== reusable.length) return undefined;
    return { headSha: sha, optionsId: settings.id, files: authored.length, blamed: 0, reused: reusable.length, noText: 0, failed: [], pruned: 0, rebuilt: false, aborted: false };
  } finally {
    db.close();
  }
}
