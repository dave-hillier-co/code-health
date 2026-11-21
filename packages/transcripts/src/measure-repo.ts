import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isWithinRepo } from "./repo-path.ts";
import { measureSession, type TaskEffort } from "./agent-effort.ts";
import { inWindow, type TimeWindow } from "./time-window.ts";

export interface MeasureRepoOptions {
  /** Claude Code's projects directory, normally `~/.claude/projects`. */
  projectsDir: string;
  /** Every checkout of the repo that sessions may have run in: the main checkout, then any worktrees. */
  repoRoots: readonly string[];
  window: TimeWindow;
}

export interface Distribution {
  mean: number;
  median: number;
}

export interface EffortSummary {
  /** The sample size every figure below rests on. */
  tasks: number;
  filesRead: Distribution | null;
  foldersVisited: Distribution | null;
  reReads: Distribution | null;
  edits: Distribution | null;
  tokens: Distribution | null;
}

export interface NotMeasuredSession {
  sessionId: string;
  version: string | null;
  reason: string;
}

export interface EffortReport {
  window: { from: string; to: string };
  sessions: { measured: number; notMeasured: NotMeasuredSession[] };
  tasks: TaskEffort[];
  summary: EffortSummary;
}

/** The directory name Claude Code gives a working directory under the projects directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9]/g, "-");
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { mean: round(mean), median: round(median) };
}

export function summariseTasks(tasks: readonly TaskEffort[]): EffortSummary {
  return {
    tasks: tasks.length,
    filesRead: distribution(tasks.map((t) => t.filesRead)),
    foldersVisited: distribution(tasks.map((t) => t.foldersVisited)),
    reReads: distribution(tasks.map((t) => t.reReads)),
    edits: distribution(tasks.map((t) => t.edits)),
    tokens: distribution(tasks.map((t) => t.tokens.total)),
  };
}

function sessionFiles(projectsDir: string, root: string): { sessionId: string; path: string }[] {
  const dir = join(projectsDir, encodeProjectDir(root));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => ({ sessionId: entry.name.slice(0, -".jsonl".length), path: join(dir, entry.name) }))
    .sort((a, b) => compareBytes(a.sessionId, b.sessionId));
}

/**
 * Agent effort for a repo over an explicit window. Only the top-level session
 * transcripts of each root's project directory are read, and only those whose recorded working
 * directory is inside one of the roots. Everything returned is
 * paths and counts, in a deterministic order.
 */
export function measureRepo(options: MeasureRepoOptions): EffortReport {
  const { projectsDir, repoRoots, window } = options;
  const seen = new Set<string>();
  const tasks: TaskEffort[] = [];
  const notMeasured: NotMeasuredSession[] = [];
  let measured = 0;

  for (const root of repoRoots) {
    for (const file of sessionFiles(projectsDir, root)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      let text: string;
      try {
        text = readFileSync(file.path, "utf8");
      } catch {
        continue; // unreadable now, so it cannot be placed in a window either
      }
      const result = measureSession(text, file.sessionId, repoRoots);
      // The directory name is a lossy encoding (/work/my.repo and /work/my-repo collide), so the working
      // directory recorded in the session decides whether it belongs to this repo.
      if (result.cwds.length > 0 && !result.cwds.some((cwd) => isWithinRepo(cwd, repoRoots))) continue;
      if (result.status === "not-measured") {
        if (result.startedAt !== null && inWindow(window, result.startedAt)) {
          notMeasured.push({ sessionId: result.sessionId, version: result.version, reason: result.reason });
        }
        continue;
      }
      const inside = result.tasks.filter((task) => inWindow(window, task.startedAt));
      if (inside.length > 0) measured++;
      tasks.push(...inside);
    }
  }

  tasks.sort(
    (a, b) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
      compareBytes(a.sessionId, b.sessionId) ||
      a.taskIndex - b.taskIndex,
  );
  notMeasured.sort((a, b) => compareBytes(a.sessionId, b.sessionId));

  return {
    window: { from: window.from, to: window.to },
    sessions: { measured, notMeasured },
    tasks,
    summary: summariseTasks(tasks),
  };
}
