import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { BlameRange } from "./blame-lines.ts";
import { createDatabase, loadSqlite } from "./sqlite.ts";

/** Bump when the table layout changes. A mismatch rebuilds the cache. */
export const BLAME_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE files (
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  options TEXT NOT NULL,
  at_commit TEXT NOT NULL,
  lines INTEGER NOT NULL,
  PRIMARY KEY (path, blob, options)
) WITHOUT ROWID;
CREATE TABLE ranges (
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  options TEXT NOT NULL,
  start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (path, blob, options, start)
) WITHOUT ROWID;
CREATE TABLE options (id TEXT PRIMARY KEY, description TEXT NOT NULL) WITHOUT ROWID;
`;

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
}

const versionOf = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

function create(path: string): DatabaseSync {
  const db = createDatabase(path, { timeout: 30_000 });
  configure(db);
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${BLAME_SCHEMA_VERSION}`);
  return db;
}

export interface WritableBlameStore {
  db: DatabaseSync;
  /** True when an incompatible or unreadable cache was discarded and recreated. */
  rebuilt: boolean;
}

/**
 * Opens the blame store for writing, creating it if absent. A schema version
 * mismatch (or a damaged file) discards the file and starts again. Call only
 * while holding the blame lock.
 */
export function openBlameForWrite(path: string): WritableBlameStore {
  loadSqlite(); // an unavailable sqlite must not be mistaken for a damaged cache
  if (existsSync(path)) {
    try {
      const db = createDatabase(path, { timeout: 30_000 });
      configure(db);
      if (versionOf(db) === BLAME_SCHEMA_VERSION) return { db, rebuilt: false };
      db.close();
    } catch {
      // unreadable: rebuild below
    }
    removeDatabase(path);
    return { db: create(path), rebuilt: true };
  }
  return { db: create(path), rebuilt: false };
}

/** Opens an existing, compatible store read-only. Returns undefined when there is none. */
export function openBlameForRead(path: string): DatabaseSync | undefined {
  loadSqlite();
  if (!existsSync(path)) return undefined;
  try {
    const db = createDatabase(path, { readOnly: true, timeout: 30_000 });
    if (versionOf(db) === BLAME_SCHEMA_VERSION) return db;
    db.close();
  } catch {
    // fall through
  }
  return undefined;
}

export interface StoredFile {
  path: string;
  blob: string;
  /** The commit the file was last known to be blamed at. */
  atCommit: string;
  lines: number;
}

export function storedFiles(db: DatabaseSync, options: string): StoredFile[] {
  const rows = db.prepare("SELECT path, blob, at_commit, lines FROM files WHERE options = ?").all(options) as {
    path: string;
    blob: string;
    at_commit: string;
    lines: number;
  }[];
  return rows.map((r) => ({ path: r.path, blob: r.blob, atCommit: r.at_commit, lines: r.lines }));
}

/** Stored files of every option set. */
export function countFiles(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
}

export function storedRanges(db: DatabaseSync, options: string, path: string, blob: string): BlameRange[] {
  const rows = db
    .prepare("SELECT start, count, sha FROM ranges WHERE path = ? AND blob = ? AND options = ? ORDER BY start")
    .all(path, blob, options) as unknown as BlameRange[];
  return rows.map((r) => ({ start: r.start, count: r.count, sha: r.sha }));
}

function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface BlamedFile {
  path: string;
  blob: string;
  ranges: BlameRange[];
}

/** Stores blames and their options together, so an interrupted refresh keeps every file that finished. */
export function putBlamedFiles(db: DatabaseSync, options: string, description: string, atCommit: string, files: readonly BlamedFile[]): void {
  const putFile = db.prepare("INSERT OR REPLACE INTO files (path, blob, options, at_commit, lines) VALUES (?, ?, ?, ?, ?)");
  const dropRanges = db.prepare("DELETE FROM ranges WHERE path = ? AND blob = ? AND options = ?");
  const putRange = db.prepare("INSERT INTO ranges (path, blob, options, start, count, sha) VALUES (?, ?, ?, ?, ?, ?)");
  inTransaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO options (id, description) VALUES (?, ?)").run(options, description);
    for (const file of files) {
      dropRanges.run(file.path, file.blob, options);
      putFile.run(file.path, file.blob, options, atCommit, file.ranges.reduce((n, r) => n + r.count, 0));
      for (const r of file.ranges) putRange.run(file.path, file.blob, options, r.start, r.count, r.sha);
    }
  });
}

/** Records that these files' blames are still right at `atCommit`. */
export function moveFilesTo(db: DatabaseSync, options: string, atCommit: string, files: readonly { path: string; blob: string }[]): void {
  const move = db.prepare("UPDATE files SET at_commit = ? WHERE path = ? AND blob = ? AND options = ?");
  inTransaction(db, () => {
    for (const f of files) move.run(atCommit, f.path, f.blob, options);
  });
}

/** Removes every stored file that `keep` does not list, as `path\0blob\0options`. Returns how many went. */
export function pruneFiles(db: DatabaseSync, keep: ReadonlySet<string>): number {
  const all = db.prepare("SELECT path, blob, options FROM files").all() as { path: string; blob: string; options: string }[];
  const gone = all.filter((f) => !keep.has(fileKey(f.path, f.blob, f.options)));
  const dropFile = db.prepare("DELETE FROM files WHERE path = ? AND blob = ? AND options = ?");
  const dropRanges = db.prepare("DELETE FROM ranges WHERE path = ? AND blob = ? AND options = ?");
  inTransaction(db, () => {
    for (const f of gone) {
      dropFile.run(f.path, f.blob, f.options);
      dropRanges.run(f.path, f.blob, f.options);
    }
    db.exec("DELETE FROM options WHERE id NOT IN (SELECT DISTINCT options FROM files)");
  });
  return gone.length;
}

export const fileKey = (path: string, blob: string, options: string): string => `${path}\0${blob}\0${options}`;
