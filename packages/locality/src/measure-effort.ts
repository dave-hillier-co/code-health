import { checkouts } from "@code-health/history/checkouts";
import { defaultProjectsDirectory } from "@code-health/transcripts/projects-dir";
import { measureRepo, type EffortReport, type EffortSource } from "@code-health/transcripts/measure-repo";
import type { EffortMode, TaskEffort } from "@code-health/transcripts/agent-effort";
import { stampOf } from "@code-health/transcripts/stamp";
import { parseWindow } from "@code-health/transcripts/time-window";
import type { DayWindow } from "./measure-window.ts";

export { checkouts, defaultProjectsDirectory, stampOf };

/** Agent effort over a window of days: the transcripts' tasks, paths and counts only. */
export function readEffort(
  projectsDir: string,
  repoRoots: readonly string[],
  window: DayWindow,
  source: EffortSource = "all",
  effort: EffortMode = "all",
): EffortReport {
  return measureRepo({ projectsDir, repoRoots, window: parseWindow(window.from, window.to), source, effort });
}

/** The tasks that read or edited at least one of the files. A task touching files of two groups counts in both. */
export function tasksTouching(tasks: readonly TaskEffort[], files: ReadonlySet<string>): TaskEffort[] {
  return tasks.filter((task) => task.readPaths.some((path) => files.has(path)) || task.editedPaths.some((path) => files.has(path)));
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
