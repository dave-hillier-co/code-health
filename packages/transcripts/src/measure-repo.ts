import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isWithinRepo } from "./repo-path.ts";
import { measureSession, measureSubagent, type SubagentMeta, type TaskEffort } from "./agent-effort.ts";
import { inWindow, type TimeWindow } from "./time-window.ts";

export interface MeasureRepoOptions {
  /** Claude Code's projects directory, normally `~/.claude/projects`. */
  projectsDir: string;
  /** Every checkout of the repo that sessions may have run in: the main checkout, then any worktrees. */
  repoRoots: readonly string[];
  window: TimeWindow;
  /** Which tasks to measure: those of main sessions, those of subagent transcripts, or both. Default `all`. */
  source?: EffortSource;
}

export type EffortSource = "main" | "subagent" | "all";

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
  /** Main sessions measured and not measured. `subagents` counts transcript files the same way and is 0 and 0 when they were not read. */
  sessions: { measured: number; notMeasured: NotMeasuredSession[]; subagents: { measured: number; notMeasured: number } };
  tasks: TaskEffort[];
  summary: EffortSummary;
}

/** The directory name Claude Code gives a working directory under the projects directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[^A-Za-z0-9]/g, "-");
}

export function compareBytes(a: string, b: string): number {
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

export interface SubagentFile {
  /** The session that spawned the subagent. */
  sessionId: string;
  agentId: string;
  path: string;
}

function agentFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...agentFilesUnder(path));
    else if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

/** Subagent transcripts of a root's project directory: `agent-*.jsonl` files anywhere below `<session>/subagents/`, in a fixed order. */
export function subagentFiles(projectsDir: string, root: string): SubagentFile[] {
  const dir = join(projectsDir, encodeProjectDir(root));
  if (!existsSync(dir)) return [];
  const files: SubagentFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const subagents = join(dir, entry.name, "subagents");
    if (!entry.isDirectory() || !existsSync(subagents)) continue;
    for (const path of agentFilesUnder(subagents)) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      files.push({ sessionId: entry.name, agentId: name.slice("agent-".length, -".jsonl".length), path });
    }
  }
  return files.sort((a, b) => compareBytes(a.path, b.path));
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The meta file beside a subagent transcript, or null when it is missing or not an object. Only three fields are kept. */
function readMeta(transcriptPath: string): SubagentMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${transcriptPath.slice(0, -".jsonl".length)}.meta.json`, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const meta = parsed as Record<string, unknown>;
    return { agentType: stringField(meta["agentType"]), description: stringField(meta["description"]), worktreePath: stringField(meta["worktreePath"]) };
  } catch {
    return null;
  }
}

export function sessionFiles(projectsDir: string, root: string): { sessionId: string; path: string }[] {
  const dir = join(projectsDir, encodeProjectDir(root));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => ({ sessionId: entry.name.slice(0, -".jsonl".length), path: join(dir, entry.name) }))
    .sort((a, b) => compareBytes(a.sessionId, b.sessionId));
}

/**
 * Agent effort for a repo over an explicit window. The top-level session transcripts of each root's project
 * directory are read as main tasks (their sidechain lines are skipped), and each subagent transcript under
 * `<session>/subagents/` as one task of its own, according to `source`. Only transcripts whose recorded working
 * directory is inside one of the roots are read. A path inside a Claude Code worktree of the repo maps to the
 * same relative path in the repo whether or not the worktree still exists. Everything returned is paths, counts
 * and the meta file's short description, in a deterministic order.
 */
export function measureRepo(options: MeasureRepoOptions): EffortReport {
  const { projectsDir, repoRoots, window } = options;
  const source = options.source ?? "all";
  const seen = new Set<string>();
  const tasks: TaskEffort[] = [];
  const notMeasured: NotMeasuredSession[] = [];
  const subagents = { measured: 0, notMeasured: 0 };
  let measured = 0;

  for (const root of repoRoots) {
    if (source !== "main") {
      for (const file of subagentFiles(projectsDir, root)) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        let text: string;
        try {
          text = readFileSync(file.path, "utf8");
        } catch {
          continue;
        }
        const meta = readMeta(file.path);
        const result = measureSubagent(text, file.sessionId, file.agentId, repoRoots, meta);
        // The meta file's worktree is a checkout of this repo, since the transcript sits in this repo's project directory.
        const places = meta?.worktreePath == null ? repoRoots : [...repoRoots, meta.worktreePath];
        if (result.cwds.length > 0 && !result.cwds.some((cwd) => isWithinRepo(cwd, places))) continue;
        if (result.status === "not-measured") {
          if (result.startedAt !== null && inWindow(window, result.startedAt)) subagents.notMeasured++;
          continue;
        }
        const inside = result.tasks.filter((task) => inWindow(window, task.startedAt));
        if (inside.length > 0) subagents.measured++;
        tasks.push(...inside);
      }
    }
    if (source === "subagent") continue;
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
      compareBytes(a.agentId ?? "", b.agentId ?? "") ||
      a.taskIndex - b.taskIndex,
  );
  notMeasured.sort((a, b) => compareBytes(a.sessionId, b.sessionId));

  return {
    window: { from: window.from, to: window.to },
    sessions: { measured, notMeasured, subagents },
    tasks,
    summary: summariseTasks(tasks),
  };
}
