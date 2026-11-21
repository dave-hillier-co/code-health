import { existsSync, readFileSync } from "node:fs";
import { isWithinRepo, toRepoPath } from "./repo-path.ts";
import { compareBytes, sessionFiles } from "./measure-repo.ts";
import { parseTranscript } from "./transcript-format.ts";
import { inWindow, type TimeWindow } from "./time-window.ts";

/** The repo files one session edited, in the order of the edits. Paths only. */
export interface SessionEdits {
  sessionId: string;
  /** Timestamp of the session's first event. */
  startedAt: string;
  /** Repo-relative paths, one entry per edit call, in order. A file edited twice appears twice. */
  edits: string[];
}

/** The edits of one transcript, or null when its format is not recognised or it has no edit to a repo file. */
export function readSessionEdits(text: string, sessionId: string, roots: readonly string[]): SessionEdits | null {
  const parsed = parseTranscript(text);
  if (parsed.status !== "recognised") return null;
  const edits: string[] = [];
  for (const event of parsed.events) {
    if (event.kind !== "agent-turn") continue;
    for (const action of event.actions) {
      if (action.kind !== "edit") continue;
      const path = toRepoPath(action.path, roots);
      if (path !== null) edits.push(path);
    }
  }
  const first = parsed.events[0];
  if (edits.length === 0 || first === undefined) return null;
  return { sessionId, startedAt: first.timestamp, edits };
}

export interface ReadEditsOptions {
  projectsDir: string;
  repoRoots: readonly string[];
  window: TimeWindow;
}

/** The sessions of a repo that started in the window and edited at least one of its files, in session id order. */
export function readRepoSessionEdits(options: ReadEditsOptions): SessionEdits[] {
  const { projectsDir, repoRoots, window } = options;
  const seen = new Set<string>();
  const sessions: SessionEdits[] = [];
  for (const root of repoRoots) {
    for (const file of sessionFiles(projectsDir, root)) {
      if (seen.has(file.path) || !existsSync(file.path)) continue;
      seen.add(file.path);
      let text: string;
      try {
        text = readFileSync(file.path, "utf8");
      } catch {
        continue;
      }
      const parsed = parseTranscript(text);
      // The recorded working directory decides whether the session belongs to this repo, as in measureRepo.
      if (parsed.cwds.length > 0 && !parsed.cwds.some((cwd) => isWithinRepo(cwd, repoRoots))) continue;
      const result = readSessionEdits(text, file.sessionId, repoRoots);
      if (result !== null && inWindow(window, result.startedAt)) sessions.push(result);
    }
  }
  return sessions.sort((a, b) => compareBytes(a.sessionId, b.sessionId));
}
