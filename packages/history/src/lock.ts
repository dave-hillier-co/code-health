import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock older than this whose owner cannot be checked is considered abandoned. */
  staleMs?: number;
  pollMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out waiting for lock ${path}`);
    this.name = "LockTimeoutError";
  }
}

interface LockOwner {
  pid: number;
  host: string;
  time: number;
}

function ownerIsGone(path: string, staleMs: number): boolean {
  let owner: LockOwner;
  try {
    owner = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
  } catch {
    // Empty or half-written lock file: only stale once it has aged.
    return false;
  }
  if (owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  return Date.now() - owner.time > staleMs;
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    const owner: LockOwner = { pid: process.pid, host: hostname(), time: Date.now() };
    writeSync(fd, JSON.stringify(owner));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Runs `fn` while holding an exclusive lock file. Waits for other holders. */
export async function withLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 120_000, staleMs = 600_000, pollMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  while (!tryCreate(path)) {
    if (ownerIsGone(path, staleMs)) {
      // Rename before removing so that only one stealer wins.
      const aside = `${path}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { force: true });
      } catch {
        // someone else already took care of it
      }
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(path);
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
