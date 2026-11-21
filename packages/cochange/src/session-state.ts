import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a hook remembers about one session. It is the hook's own record,
 * written on each edit it sees: it never reads the transcript, which is
 * written asynchronously and can lag behind the tool call.
 */
export interface SessionState {
  /** Files edited so far, repo-relative, in the order first edited. */
  edited: string[];
  /** Files the hook has already spoken about. It speaks at most once per file. */
  spokenAbout: string[];
  /** The previous run's outcome and how long it took, for diagnosing a slow or silent hook. */
  lastRun: { outcome: string; durationMs: number } | null;
}

export const emptySession = (): SessionState => ({ edited: [], spokenAbout: [], lastRun: null });

/** Where a session's state lives, under the repository's `.cache/code-health/sessions`. */
export function sessionDirectory(root: string): string {
  return join(root, ".cache", "code-health", "sessions");
}

/**
 * The state file name for a session id. An id is used as is when it is a safe
 * file name; anything else is replaced by a digest, so no id can name a path
 * outside the directory.
 */
export function sessionFile(root: string, sessionId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : `h-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
  return join(sessionDirectory(root), `${safe}.json`);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The stored state, or an empty one when there is none or it cannot be read. */
export function readSession(root: string, sessionId: string): SessionState {
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(root, sessionId), "utf8")) as Record<string, unknown>;
    const last = parsed.lastRun as { outcome?: unknown; durationMs?: unknown } | null | undefined;
    return {
      edited: strings(parsed.edited),
      spokenAbout: strings(parsed.spokenAbout),
      lastRun: last && typeof last.outcome === "string" && typeof last.durationMs === "number" ? { outcome: last.outcome, durationMs: last.durationMs } : null,
    };
  } catch {
    return emptySession();
  }
}

/** Writes the state through a temporary file and a rename, so a reader never sees half a file. */
export function writeSession(root: string, sessionId: string, state: SessionState): void {
  const file = sessionFile(root, sessionId);
  mkdirSync(sessionDirectory(root), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + "\n");
  renameSync(temporary, file);
}
