import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCacheDir, locateCache } from "./cache-location.ts";
import { gitVersion, runGit } from "./git.ts";
import { withLock, type LockOptions } from "./lock.ts";
import { logArgs, parseLog } from "./log-parser.ts";
import {
  deleteCommits,
  insertCommits,
  openForWrite,
  setMeta,
  storedBoundaryShas,
  storedShas,
} from "./store.ts";

export interface RefreshOptions {
  /** The analysed ref. Defaults to HEAD. */
  ref?: string;
  /** Rename similarity percentage for -M. Defaults to 50. */
  similarity?: number;
  /** diff.renameLimit. Defaults to 1000. */
  renameLimit?: number;
  lock?: LockOptions;
  /** Commits fetched per git invocation. */
  batchSize?: number;
}

export interface ShallowInfo {
  isShallow: boolean;
  /** Commits whose parents were cut off by the shallow clone. */
  boundary: string[];
}

export interface RefreshResult {
  /** Commit the ref resolved to. */
  headSha: string;
  /** Commits newly stored by this refresh. */
  added: number;
  /** Commits reachable from the ref (all stored after the refresh). */
  reachable: number;
  /** The cache was discarded and rebuilt (schema or ingest setting mismatch). */
  rebuilt: boolean;
  shallow: ShallowInfo;
  gitVersion: string;
}

export const DEFAULT_SIMILARITY = 50;
export const DEFAULT_RENAME_LIMIT = 1000;

export async function readShallowInfo(repoPath: string): Promise<ShallowInfo> {
  const out = (await runGit(repoPath, ["rev-parse", "--is-shallow-repository", "--path-format=absolute", "--git-common-dir"]))
    .trim()
    .split("\n");
  const isShallow = out[0] === "true";
  if (!isShallow) return { isShallow: false, boundary: [] };
  const file = join(out[1] ?? "", "shallow");
  const boundary = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
    : [];
  return { isShallow, boundary: boundary.sort() };
}

export async function resolveRef(repoPath: string, ref: string): Promise<string> {
  return (await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
}

/**
 * Brings the shared history cache up to date with `ref`. Only commits that are
 * reachable from the ref and not yet stored are read from git. Stored commits
 * are immutable and never touched, except shallow-boundary commits, whose
 * recorded changes are an artefact of the truncation and are re-read once the
 * clone is deepened.
 */
export async function refresh(repoPath: string, options: RefreshOptions = {}): Promise<RefreshResult> {
  const ref = options.ref ?? "HEAD";
  const settings = {
    similarity: options.similarity ?? DEFAULT_SIMILARITY,
    renameLimit: options.renameLimit ?? DEFAULT_RENAME_LIMIT,
  };
  const batchSize = options.batchSize ?? 2000;
  const location = await locateCache(repoPath);
  const headSha = await resolveRef(location.repoRoot, ref);
  ensureCacheDir(location);

  return withLock(
    location.lockPath,
    async () => {
      // Read shallow state and reachability under the lock so a concurrent
      // refresh that finished first leaves us nothing to do.
      const shallow = await readShallowInfo(location.repoRoot);
      const version = await gitVersion(location.repoRoot);
      const { db, rebuilt } = openForWrite(location.dbPath, settings);
      try {
        const boundary = new Set(shallow.boundary);
        const stale = storedBoundaryShas(db).filter((sha) => !boundary.has(sha));
        if (stale.length > 0) deleteCommits(db, stale);

        const listing = await runGit(location.repoRoot, ["rev-list", headSha]);
        const reachable = listing.split("\n").filter((l) => l !== "");
        const stored = storedShas(db);
        const missing = reachable.filter((sha) => !stored.has(sha));

        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);
          const out = await runGit(location.repoRoot, logArgs(settings), { input: batch.join("\n") + "\n" });
          insertCommits(db, parseLog(out), boundary);
        }
        setMeta(db, "git_version", version);
        return { headSha, added: missing.length, reachable: reachable.length, rebuilt, shallow, gitVersion: version };
      } finally {
        db.close();
      }
    },
    options.lock,
  );
}
