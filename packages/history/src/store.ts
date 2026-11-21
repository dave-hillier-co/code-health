import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase, loadSqlite } from "./sqlite.ts";
import type { ParsedCommit } from "./log-parser.ts";

/** Bump when the table layout changes. A mismatch rebuilds the cache. */
export const SCHEMA_VERSION = 1;

export interface IngestSettings {
  similarity: number;
  renameLimit: number;
}

const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE commits (
  sha TEXT PRIMARY KEY,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  mapped_name TEXT NOT NULL,
  mapped_email TEXT NOT NULL,
  author_date INTEGER NOT NULL,
  committer_date INTEGER NOT NULL,
  message TEXT NOT NULL,
  parent_count INTEGER NOT NULL,
  boundary INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE commit_parents (
  sha TEXT NOT NULL,
  ord INTEGER NOT NULL,
  parent TEXT NOT NULL,
  PRIMARY KEY (sha, ord)
) WITHOUT ROWID;
CREATE TABLE changes (
  sha TEXT NOT NULL,
  idx INTEGER NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  status TEXT NOT NULL,
  similarity INTEGER,
  added INTEGER,
  deleted INTEGER,
  binary INTEGER NOT NULL,
  blob TEXT,
  PRIMARY KEY (sha, idx)
) WITHOUT ROWID;
`;

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function compatible(db: DatabaseSync, settings: IngestSettings): boolean {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== SCHEMA_VERSION) return false;
  return (
    readMeta(db, "rename_similarity") === String(settings.similarity) &&
    readMeta(db, "rename_limit") === String(settings.renameLimit)
  );
}

function create(path: string, settings: IngestSettings): DatabaseSync {
  const db = createDatabase(path, { timeout: 30_000 });
  configure(db);
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  put.run("rename_similarity", String(settings.similarity));
  put.run("rename_limit", String(settings.renameLimit));
  return db;
}

export interface WritableStore {
  db: DatabaseSync;
  /** True when an incompatible or unreadable cache was discarded and recreated. */
  rebuilt: boolean;
}

/**
 * Opens the store for writing, creating it if absent. A schema version or
 * ingest setting mismatch (or a damaged file) discards the file and starts
 * again. Call only while holding the write lock.
 */
export function openForWrite(path: string, settings: IngestSettings): WritableStore {
  loadSqlite(); // an unavailable sqlite must not be mistaken for a damaged cache
  if (existsSync(path)) {
    try {
      const db = createDatabase(path, { timeout: 30_000 });
      configure(db);
      if (compatible(db, settings)) return { db, rebuilt: false };
      db.close();
    } catch {
      // unreadable: rebuild below
    }
    removeDatabase(path);
    return { db: create(path, settings), rebuilt: true };
  }
  return { db: create(path, settings), rebuilt: false };
}

/** Opens an existing, compatible store read-only. Returns undefined when there is none. */
export function openForRead(path: string): DatabaseSync | undefined {
  loadSqlite();
  if (!existsSync(path)) return undefined;
  try {
    const db = createDatabase(path, { readOnly: true, timeout: 30_000 });
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === SCHEMA_VERSION) return db;
    db.close();
  } catch {
    // fall through
  }
  return undefined;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  return readMeta(db, key);
}

export function storedShas(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT sha FROM commits").all() as { sha: string }[];
  return new Set(rows.map((r) => r.sha));
}

export function storedBoundaryShas(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT sha FROM commits WHERE boundary = 1").all() as { sha: string }[];
  return rows.map((r) => r.sha);
}

export function deleteCommits(db: DatabaseSync, shas: string[]): void {
  const statements = ["commits", "commit_parents", "changes"].map((t) => db.prepare(`DELETE FROM ${t} WHERE sha = ?`));
  db.exec("BEGIN");
  try {
    for (const sha of shas) for (const s of statements) s.run(sha);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function insertCommits(db: DatabaseSync, commits: ParsedCommit[], boundary: ReadonlySet<string>): void {
  const insertCommit = db.prepare(
    `INSERT OR IGNORE INTO commits
     (sha, author_name, author_email, mapped_name, mapped_email, author_date, committer_date, message, parent_count, boundary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertParent = db.prepare("INSERT OR IGNORE INTO commit_parents (sha, ord, parent) VALUES (?, ?, ?)");
  const insertChange = db.prepare(
    `INSERT OR IGNORE INTO changes
     (sha, idx, path, old_path, status, similarity, added, deleted, binary, blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const c of commits) {
      insertCommit.run(
        c.sha,
        c.authorName,
        c.authorEmail,
        c.mappedName,
        c.mappedEmail,
        c.authorDate,
        c.committerDate,
        c.message,
        c.parents.length,
        boundary.has(c.sha) ? 1 : 0,
      );
      c.parents.forEach((parent, ord) => insertParent.run(c.sha, ord, parent));
      c.changes.forEach((ch, idx) =>
        insertChange.run(c.sha, idx, ch.path, ch.oldPath, ch.status, ch.similarity, ch.added, ch.deleted, ch.binary ? 1 : 0, ch.blob),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
