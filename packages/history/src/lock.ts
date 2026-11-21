import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync, linkSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock on another host whose file has not been touched for this long is considered abandoned. */
  staleMs?: number;
  /** An unparseable lock file (a crash between create and write) is abandoned once it is this old. */
  unreadableMs?: number;
  pollMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out waiting for lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  time: number;
}

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function fileAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether the lock described by `raw` (the file's content) is abandoned. */
function ownerIsGone(path: string, raw: string, staleMs: number, unreadableMs: number): boolean {
  let owner: LockOwner;
  try {
    owner = JSON.parse(raw) as LockOwner;
    if (typeof owner.pid !== "number" || typeof owner.host !== "string") throw new Error("not a lock");
  } catch {
    // Empty or half-written lock file: only stale once it has aged.
    return fileAge(path) > unreadableMs;
  }
  if (owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  // The holder refreshes the file's mtime while it works.
  return fileAge(path) > staleMs;
}

function tryCreate(path: string, token: string): boolean {
  try {
    const fd = openSync(path, "wx");
    const owner: LockOwner = { token, pid: process.pid, host: hostname(), time: Date.now() };
    writeSync(fd, JSON.stringify(owner));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Removes the lock at `path` if it still has the content that was judged
 * abandoned. The file is renamed aside first so that only one stealer wins,
 * then its content is re-checked: if a live lock took its place in the
 * meantime it is put back.
 */
function steal(path: string, judged: string): void {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else already took care of it
  }
  if (readRaw(aside) !== judged) {
    try {
      linkSync(aside, path); // fails if yet another lock has appeared; that one stands
    } catch {
      // leave the newer lock in place
    }
  }
  rmSync(aside, { force: true });
}

/** Runs `fn` while holding an exclusive lock file. Waits for other holders. */
export async function withLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 120_000, staleMs = 600_000, unreadableMs = 5_000, pollMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (!tryCreate(path, token)) {
    const raw = readRaw(path);
    if (raw !== undefined && ownerIsGone(path, raw, staleMs, unreadableMs)) {
      steal(path, raw);
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(path);
    await sleep(pollMs);
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // the lock was taken away; nothing to refresh
    }
  }, Math.max(1_000, Math.floor(staleMs / 4)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    const raw = readRaw(path);
    if (raw !== undefined && safeToken(raw) === token) rmSync(path, { force: true });
  }
}

function safeToken(raw: string): string | undefined {
  try {
    return (JSON.parse(raw) as LockOwner).token;
  } catch {
    return undefined;
  }
}
