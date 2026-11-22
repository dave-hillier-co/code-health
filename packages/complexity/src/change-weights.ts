import { midRankPercentiles } from "@code-health/cli-kit/ranking";
import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { analyseHistory, monthsBefore } from "@code-health/history/evidence";
import { readShallowInfo, refresh } from "@code-health/history/refresh";
import type { LogicalChange } from "@code-health/history/noise";
import type { ComplexitySettings } from "./config.ts";

/** How often each file changed in the window, and the weight that gives its code in the ranking. */
export interface ChangeWeights {
  window: { months: number; since: number; until: number };
  /** Logical changes touching each file in the window, by the file's name at HEAD. Files absent from the map had none. */
  revisions: ReadonlyMap<string, number>;
  /** 0 for a file with no change in the window, otherwise its revisions' percentile among the files that changed, above 0 and up to 1. */
  weights: ReadonlyMap<string, number>;
}

/**
 * Reads change frequency from the shared history cache, refreshing it first as every analysis does.
 * Returns undefined when history cannot give an honest answer, as in a shallow clone with no stated
 * window or a repository without commits, so the ranking falls back to percentile alone.
 */
export async function readChangeWeights(context: CommandContext, settings: ComplexitySettings): Promise<ChangeWeights | undefined> {
  const { root } = context.repo;
  try {
    const shallow = await readShallowInfo(root);
    if (shallow.isShallow) return undefined;
    await refresh(root, { ref: "HEAD" });
    const analysis = await analyseHistory(root, { ref: "HEAD", noise: { exclude: [...context.config.effective.exclude], botPatterns: settings.botPatterns, maxChangesetSize: settings.maxChangesetSize } });
    const until = analysis.view.headDate;
    return weightsFromChanges(analysis.filtered.changes, monthsBefore(until, settings.windowMonths), until, settings.windowMonths);
  } catch {
    return undefined;
  }
}

/**
 * How often each file changed from `since` to `until`, unix seconds, and the weight that gives its code. A
 * change counts for a file under the file's stable id, which is its name at HEAD.
 */
export function weightsFromChanges(changes: readonly LogicalChange[], since: number, until: number, months: number): ChangeWeights {
  const revisions = new Map<string, number>();
  for (const change of changes) {
    if (change.committerDate < since || change.committerDate > until) continue;
    for (const file of change.files) revisions.set(file.fileId, (revisions.get(file.fileId) ?? 0) + 1);
  }
  const paths = [...revisions.keys()].sort();
  const percentiles = midRankPercentiles(paths.map((path) => revisions.get(path)!));
  const weights = new Map(paths.map((path, index) => [path, percentiles[index]!] as const));
  return { window: { months, since, until }, revisions, weights };
}
