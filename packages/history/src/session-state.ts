import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSelfIgnoring } from "./cache-location.ts";

/** What a hook measured of one file: metric values per unit, by unit id. */
export type FileMeasurement = Record<string, Record<string, number>>;

/**
 * What a hook remembers about one session. It is the hook's own record,
 * written on each edit it sees: it never reads the transcript, which is
 * written asynchronously and can lag behind the tool call. Each hook has its
 * own file, so a note one hook printed never stops another hook printing its own.
 */
export interface SessionState {
  /** Files edited so far, repo-relative, in the order first edited. */
  edited: string[];
  /** Files the hook has already printed a note for. It prints at most one note per file. */
  spokenAbout: string[];
  /** The previous run's outcome and how long it took, for diagnosing a slow hook or one that printed nothing. */
  lastRun: { outcome: string; durationMs: number } | null;
  /** The last measurement of each file the hook measured, by repo-relative path. */
  measurements: Record<string, FileMeasurement>;
}

export const emptySession = (): SessionState => ({ edited: [], spokenAbout: [], lastRun: null, measurements: {} });

/** Where a session's state lives, under the repository's `.cache/code-health/sessions`. */
export function sessionDirectory(root: string): string {
  return join(root, ".cache", "code-health", "sessions");
}

/**
 * The state file of a hook for a session id: `<id>.<hook>.json`. An id is used as is
 * when it is a safe file name; anything else is replaced by a digest, so no id can
 * name a path outside the directory. `hook` is the plugin's own constant name.
 */
export function sessionFile(root: string, sessionId: string, hook: string): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : `h-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
  return join(sessionDirectory(root), `${safe}.${hook}.json`);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The stored state, or an empty one when there is none or it cannot be read. */
export function readSession(root: string, sessionId: string, hook: string): SessionState {
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(root, sessionId, hook), "utf8")) as Record<string, unknown>;
    const last = parsed.lastRun as { outcome?: unknown; durationMs?: unknown } | null | undefined;
    return {
      edited: strings(parsed.edited),
      spokenAbout: strings(parsed.spokenAbout),
      lastRun: last && typeof last.outcome === "string" && typeof last.durationMs === "number" ? { outcome: last.outcome, durationMs: last.durationMs } : null,
      measurements: typeof parsed.measurements === "object" && parsed.measurements !== null && !Array.isArray(parsed.measurements) ? (parsed.measurements as Record<string, FileMeasurement>) : {},
    };
  } catch {
    return emptySession();
  }
}

/** Writes the state through a temporary file and a rename, so a reader never sees half a file. */
export function writeSession(root: string, sessionId: string, hook: string, state: SessionState): void {
  const file = sessionFile(root, sessionId, hook);
  // The cache's own .gitignore comes first: the hook may be the first thing to write here.
  ensureSelfIgnoring(join(root, ".cache", "code-health"));
  mkdirSync(sessionDirectory(root), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + "\n");
  renameSync(temporary, file);
}

/** A lock older than this is a crashed holder's, and is taken over. */
const STALE_LOCK_MS = 2_000;
/** How long to wait for a lock before going on without it. */
const LOCK_WAIT_MS = 300;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `work` holding the session's lock file, so concurrent hook processes take turns. After the wait it runs unlocked rather than block an edit. */
function withLock<T>(file: string, work: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch {
        // The holder released it between the attempt and the stat; try again.
      }
      if (Date.now() >= deadline) break;
      sleep(5);
    }
  }
  try {
    return work();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

/**
 * Reads the latest state, applies `change` to it and writes it back, all under the session's lock.
 * Two hooks editing different files in one session each see the other's edit, so neither is lost.
 */
export function updateSession(root: string, sessionId: string, hook: string, change: (state: SessionState) => void): SessionState {
  const file = sessionFile(root, sessionId, hook);
  ensureSelfIgnoring(join(root, ".cache", "code-health"));
  mkdirSync(sessionDirectory(root), { recursive: true });
  return withLock(file, () => {
    const state = readSession(root, sessionId, hook);
    change(state);
    writeSession(root, sessionId, hook, state);
    return state;
  });
}
