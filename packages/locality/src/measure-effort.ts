import { createHash } from "node:crypto";
import { checkouts } from "@code-health/history/checkouts";
import { defaultProjectsDirectory } from "@code-health/transcripts/projects-dir";
import { measureRepo, type EffortReport } from "@code-health/transcripts/measure-repo";
import type { TaskEffort } from "@code-health/transcripts/agent-effort";
import { parseWindow } from "@code-health/transcripts/time-window";
import type { DayWindow } from "./measure-window.ts";

export { checkouts, defaultProjectsDirectory };

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
