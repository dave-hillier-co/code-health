import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, linkSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockOptions {
  /**
   * Give up waiting once the holder has shown no progress for this long. A holder that
   * keeps reporting progress (see `LockHolder.progress`) is waited for however long it takes.
   */
  timeoutMs?: number;
  /** A lock on another host whose file has not been touched for this long is considered abandoned. */
  staleMs?: number;
  /** An unparseable lock file (a crash between create and write) is abandoned once it is this old. */
  unreadableMs?: number;
  pollMs?: number;
  /** The first line about the wait is printed once the wait has lasted this long. */
  noticeAfterMs?: number;
  /** Then a line is printed this often while the wait lasts. */
  noticeEveryMs?: number;
  /** A holder rewrites its progress into the lock file at most this often. */
  progressEveryMs?: number;
  /** Where the lines about waiting and taking over go. Defaults to stderr. */
  notify?: (line: string) => void;
}

/** What the function run under the lock can do with it. */
export interface LockHolder {
  /** Records what the holder has done so far, such as "blamed 120 of 4400 files", for anyone waiting. */
  progress(text: string): void;
}

export class LockTimeoutError extends Error {
  constructor(path: string, holder: string, quietMs: number) {
    super(`Timed out waiting for ${basename(path)}: ${holder} holds it and showed no progress for ${formatDuration(quietMs)}`);
    this.name = "LockTimeoutError";
  }
}

interface LockOwner {
  token: string;
  pid: number;
  host: string;
  /** When the holder took the lock, unix milliseconds. */
  time: number;
  /** The command line of the holder. */
  command?: string;
  /** What the holder last said it had done. */
  progress?: string;
}

/** "45s", "3m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The running command as a person would type it: the script's name and its arguments. */
function commandLine(): string {
  const script = process.argv[1] === undefined ? "node" : basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "");
  const line = [script, ...process.argv.slice(2)].join(" ");
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
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

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(raw) as LockOwner;
    if (typeof owner.pid !== "number" || typeof owner.host !== "string") return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

function describeHolder(owner: LockOwner): string {
  const host = owner.host === hostname() ? "" : ` on host ${owner.host}`;
  const command = owner.command === undefined ? "" : ` (${owner.command})`;
  return `process ${owner.pid}${host}${command}`;
}

/** Why the lock described by `raw` (the file's content) is abandoned, or undefined while its holder may still be at work. */
function abandonment(path: string, raw: string, staleMs: number, unreadableMs: number): string | undefined {
  const owner = parseOwner(raw);
  if (owner === undefined) {
    // Empty or half-written lock file: only stale once it has aged.
    const age = fileAge(path);
    return age > unreadableMs ? `the lock file is unreadable and ${formatDuration(age)} old` : undefined;
  }
  if (owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? `${describeHolder(owner)} is no longer running` : undefined;
    }
  }
  // The holder refreshes the file's mtime while it works.
  const age = fileAge(path);
  return age > staleMs ? `${describeHolder(owner)} has not updated the lock for ${formatDuration(age)}` : undefined;
}

/** Whether a live holder has the lock at `path`: false when there is no lock file or its holder is gone. */
export function lockIsHeld(path: string, options: Pick<LockOptions, "staleMs" | "unreadableMs"> = {}): boolean {
  const raw = readRaw(path);
  return raw !== undefined && abandonment(path, raw, options.staleMs ?? 600_000, options.unreadableMs ?? 5_000) === undefined;
}

function tryCreate(path: string, owner: LockOwner): boolean {
  try {
    const fd = openSync(path, "wx");
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
 * meantime it is put back. Returns whether the judged lock was removed.
 */
function steal(path: string, judged: string): boolean {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // someone else already took care of it
  }
  const removed = readRaw(aside) === judged;
  if (!removed) {
    try {
      linkSync(aside, path); // fails if yet another lock has appeared; that one stands
    } catch {
      // leave the newer lock in place
    }
  }
  rmSync(aside, { force: true });
  return removed;
}

/** Rewrites the lock file with the holder's latest progress, if the lock is still this holder's. */
function rewrite(path: string, owner: LockOwner): void {
  const current = readRaw(path);
  if (current === undefined || parseOwner(current)?.token !== owner.token) return;
  const next = `${path}.${owner.token}.tmp`;
  try {
    writeFileSync(next, JSON.stringify(owner));
    renameSync(next, path);
  } catch {
    rmSync(next, { force: true });
  }
}

const toStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Runs `fn` while holding an exclusive lock file. Waits for other holders, printing
 * through `notify` which lock it waits for, who holds it, for how long and with what
 * progress. A lock whose holder has died is taken over, with a line saying so.
 */
export async function withLock<T>(path: string, fn: (holder: LockHolder) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const {
    timeoutMs = 300_000,
    staleMs = 600_000,
    unreadableMs = 5_000,
    pollMs = 25,
    noticeAfterMs = 2_000,
    noticeEveryMs = 30_000,
    progressEveryMs = 1_000,
    notify = toStderr,
  } = options;
  const name = basename(path);
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, host: hostname(), time: Date.now(), command: commandLine() };
  const waitStarted = Date.now();
  let nextNotice = waitStarted + noticeAfterMs;
  let lastSeen: string | undefined;
  let quietSince = waitStarted;
  for (;;) {
    owner.time = Date.now();
    if (tryCreate(path, owner)) break;
    const raw = readRaw(path);
    const now = Date.now();
    if (raw === undefined) continue;
    if (raw !== lastSeen) {
      lastSeen = raw;
      quietSince = now;
    }
    const reason = abandonment(path, raw, staleMs, unreadableMs);
    if (reason !== undefined) {
      if (steal(path, raw)) notify(`${name}: ${reason}, so this command takes the lock over`);
      continue;
    }
    const holder = parseOwner(raw);
    if (now - quietSince > timeoutMs) {
      throw new LockTimeoutError(path, holder === undefined ? "a process that has not written its details" : describeHolder(holder), timeoutMs);
    }
    if (now >= nextNotice) {
      notify(waitingLine(name, holder, now));
      nextNotice = now + noticeEveryMs;
    }
    await sleep(pollMs);
  }
  let lastProgress = 0;
  const lock: LockHolder = {
    progress(text) {
      const now = Date.now();
      if (text === owner.progress || now - lastProgress < progressEveryMs) return;
      owner.progress = text;
      lastProgress = now;
      rewrite(path, owner);
    },
  };
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
    return await fn(lock);
  } finally {
    clearInterval(heartbeat);
    const raw = readRaw(path);
    if (raw !== undefined && parseOwner(raw)?.token === owner.token) rmSync(path, { force: true });
  }
}

function waitingLine(name: string, holder: LockOwner | undefined, now: number): string {
  if (holder === undefined) return `waiting for ${name}: held by a process that has not written its details yet`;
  const progress = holder.progress === undefined ? "" : `, ${holder.progress}`;
  return `waiting for ${name}: held by ${describeHolder(holder)} for ${formatDuration(now - holder.time)}${progress}`;
}
