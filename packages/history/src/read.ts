import type { DatabaseSync } from "node:sqlite";
import { locateCache } from "./cache-location.ts";
import type { ChangeStatus } from "./log-parser.ts";
import { resolveRef } from "./refresh.ts";
import { RenameMap } from "./renames.ts";
import { openForRead } from "./store.ts";

export class NoCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoCacheError";
  }
}

export interface HistoryChange {
  /** Path as of this commit. */
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  similarity: number | null;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  blob: string | null;
  /** Stable identity: the file's last known path, following renames. */
  fileId: string;
}

export interface HistoryCommit {
  sha: string;
  /** Position in topological order, oldest first. */
  position: number;
  authorName: string;
  authorEmail: string;
  mappedName: string;
  mappedEmail: string;
  authorDate: number;
  committerDate: number;
  message: string;
  /** Parent count in the real graph (not the walked one). */
  parentCount: number;
  /** Ingested while the clone was shallow: its changes are an artefact. */
  boundary: boolean;
  changes: HistoryChange[];
}

export interface HistoryView {
  ref: string;
  headSha: string;
  /** Committer date of the head commit, in unix seconds. The anchor for all time windows. */
  headDate: number;
  firstParent: boolean;
  /** Non-merge commits reachable from the ref, parents before children. */
  commits: HistoryCommit[];
  renames: RenameMap;
}

export interface ReadOptions {
  ref?: string;
  /** Follow only first parents, as `git log --first-parent`. */
  firstParent?: boolean;
}

interface CommitRow {
  sha: string;
  author_name: string;
  author_email: string;
  mapped_name: string;
  mapped_email: string;
  author_date: number;
  committer_date: number;
  message: string;
  parent_count: number;
  boundary: number;
}

interface ChangeRow {
  sha: string;
  path: string;
  old_path: string | null;
  status: ChangeStatus;
  similarity: number | null;
  added: number | null;
  deleted: number | null;
  binary: number;
  blob: string | null;
}

const REACH = (firstParent: boolean) => `
  WITH RECURSIVE reach(sha) AS (
    SELECT ?
    UNION
    SELECT p.parent FROM reach r JOIN commit_parents p ON p.sha = r.sha ${firstParent ? "AND p.ord = 0" : ""}
  )`;

/**
 * Selects the history reachable from a ref out of the cache. Never reads git
 * history itself and never refreshes: run `refresh` first.
 */
export async function readHistory(repoPath: string, options: ReadOptions = {}): Promise<HistoryView> {
  const ref = options.ref ?? "HEAD";
  const firstParent = options.firstParent ?? false;
  const location = await locateCache(repoPath);
  const headSha = await resolveRef(location.repoRoot, ref);
  const db = openForRead(location.dbPath);
  if (!db) throw new NoCacheError("No history cache. Run refresh first.");
  try {
    return select(db, ref, headSha, firstParent);
  } finally {
    db.close();
  }
}

function select(db: DatabaseSync, ref: string, headSha: string, firstParent: boolean): HistoryView {
  const head = db.prepare("SELECT committer_date FROM commits WHERE sha = ?").get(headSha) as
    | { committer_date: number }
    | undefined;
  if (!head) throw new NoCacheError(`Commit ${headSha} is not in the history cache. Run refresh first.`);

  const rows = db
    .prepare(`${REACH(firstParent)} SELECT c.* FROM commits c JOIN reach ON reach.sha = c.sha`)
    .all(headSha) as unknown as CommitRow[];
  const changeRows = db
    .prepare(
      `${REACH(firstParent)}
       SELECT ch.* FROM changes ch JOIN reach ON reach.sha = ch.sha ORDER BY ch.sha, ch.idx`,
    )
    .all(headSha) as unknown as ChangeRow[];
  const parentRows = db
    .prepare(
      `${REACH(firstParent)}
       SELECT p.sha, p.parent FROM commit_parents p JOIN reach ON reach.sha = p.sha
       ${firstParent ? "WHERE p.ord = 0" : ""} ORDER BY p.sha, p.ord`,
    )
    .all(headSha) as unknown as { sha: string; parent: string }[];

  const parents = new Map<string, string[]>();
  for (const { sha, parent } of parentRows) {
    const list = parents.get(sha);
    if (list) list.push(parent);
    else parents.set(sha, [parent]);
  }
  const changesBySha = new Map<string, ChangeRow[]>();
  for (const row of changeRows) {
    const list = changesBySha.get(row.sha);
    if (list) list.push(row);
    else changesBySha.set(row.sha, [row]);
  }

  const ordered = topologicalOrder(rows, parents);
  const renames = new RenameMap();
  const commits: HistoryCommit[] = [];
  for (const row of ordered) {
    const rawChanges = changesBySha.get(row.sha) ?? [];
    const isMerge = row.parent_count > 1;
    if (isMerge) continue;
    const position = commits.length;
    for (const ch of rawChanges) {
      if (ch.status === "R" && ch.old_path) renames.add(ch.old_path, ch.path, position);
      else if (ch.status === "D") renames.delete(ch.path, position);
    }
    commits.push({
      sha: row.sha,
      position,
      authorName: row.author_name,
      authorEmail: row.author_email,
      mappedName: row.mapped_name,
      mappedEmail: row.mapped_email,
      authorDate: row.author_date,
      committerDate: row.committer_date,
      message: row.message,
      parentCount: row.parent_count,
      boundary: row.boundary === 1,
      changes: rawChanges.map((ch) => ({
        path: ch.path,
        oldPath: ch.old_path,
        status: ch.status,
        similarity: ch.similarity,
        added: ch.added,
        deleted: ch.deleted,
        binary: ch.binary === 1,
        blob: ch.blob,
        fileId: "",
      })),
    });
  }
  for (const commit of commits) {
    for (const ch of commit.changes) ch.fileId = renames.resolve(ch.path, commit.position);
  }
  return { ref, headSha, headDate: head.committer_date, firstParent, commits, renames };
}

/**
 * Parents before children, ties broken by committer date then SHA, so the
 * order is deterministic and independent of insertion order.
 */
function topologicalOrder(rows: CommitRow[], parents: Map<string, string[]>): CommitRow[] {
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const sorted = [...rows].sort((a, b) => a.committer_date - b.committer_date || (a.sha < b.sha ? -1 : 1));
  const done = new Set<string>();
  const out: CommitRow[] = [];
  for (const start of sorted) {
    if (done.has(start.sha)) continue;
    const stack: { row: CommitRow; next: number }[] = [{ row: start, next: 0 }];
    done.add(start.sha);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const ps = parents.get(frame.row.sha) ?? [];
      let descended = false;
      while (frame.next < ps.length) {
        const parent = bySha.get(ps[frame.next++]!);
        if (parent && !done.has(parent.sha)) {
          done.add(parent.sha);
          stack.push({ row: parent, next: 0 });
          descended = true;
          break;
        }
      }
      if (!descended) {
        out.push(frame.row);
        stack.pop();
      }
    }
  }
  return out;
}
