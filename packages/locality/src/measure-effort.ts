import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { runGit } from "@code-health/history/git";
import { measureRepo, type EffortReport } from "@code-health/transcripts/measure-repo";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import { parseWindow } from "@code-health/transcripts/time-window";
import type { DayWindow } from "./measure-window.ts";

/** Claude Code's projects directory, unless the command names another. */
export const defaultProjectsDirectory = (): string => join(homedir(), ".claude", "projects");

/**
 * Every checkout of the repository that sessions may have run in: this one, then its linked worktrees. A
 * session in a worktree is work on this repository, and its paths are repo-relative once the worktree root is removed.
 */
export async function checkouts(root: string): Promise<string[]> {
  const listing = await runGit(root, ["worktree", "list", "--porcelain"]);
  const others = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path !== root);
  return [root, ...others.sort()];
}

/** Agent effort over a window of days: the transcripts' tasks, paths and counts only. */
export function readEffort(projectsDir: string, repoRoots: readonly string[], window: DayWindow): EffortReport {
  return measureRepo({ projectsDir, repoRoots, window: parseWindow(window.from, window.to) });
}

/** The tasks that read or edited at least one of the files. A task touching files of two groups counts in both. */
export function tasksTouching(tasks: readonly TaskEffort[], files: ReadonlySet<string>): TaskEffort[] {
  return tasks.filter((task) => task.readPaths.some((path) => files.has(path)) || task.editedPaths.some((path) => files.has(path)));
}

/** A stamp of the transcript input: the same tasks always give the same stamp, so output can name it. */
export function stampOf(tasks: readonly TaskEffort[]): string {
  return createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 16);
}

export interface Heat {
  path: string;
  /** Tasks that read the file. */
  tasks: number;
}

/** The files read by the most tasks: where scattering costs most, which ranks candidates for attention. */
export function readHeat(tasks: readonly TaskEffort[], limit: number): Heat[] {
  const counts = new Map<string, number>();
  for (const task of tasks) for (const path of task.readPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return [...counts]
    .map(([path, count]): Heat => ({ path, tasks: count }))
    .sort((a, b) => b.tasks - a.tasks || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .slice(0, limit);
}
