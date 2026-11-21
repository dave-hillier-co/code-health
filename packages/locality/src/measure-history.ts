import { analyseHistory, type HistoryAnalysis } from "@code-health/history/evidence";
import { runGit } from "@code-health/history/git";
import type { HistoryView } from "@code-health/history/read";
import { refresh } from "@code-health/history/refresh";
import type { LocalitySettings } from "./config.ts";

/**
 * The history both outcome windows are read from: refreshed first, with the suite's own commits left out (a move
 * commit is wide by construction) and the same noise filters for the baseline and its comparison. The view still
 * holds every commit, trailers included, for finding what the suite did.
 */
export async function readMeasureHistory(root: string, settings: LocalitySettings): Promise<HistoryAnalysis> {
  await refresh(root, { ref: "HEAD" });
  return analyseHistory(root, {
    ref: "HEAD",
    noise: { exclude: [...settings.exclude], excludeSuiteCommits: true },
    evidence: { windowMonths: settings.windowMonths },
  });
}

/**
 * The stable identity of each path as the files stood at `commit`: the path the file has now, after the renames
 * since. A path no commit touched keeps its own name. Deleted files keep theirs too, because a deletion ends the chain.
 */
export async function identitiesAt(root: string, view: HistoryView, commit: string, paths: Iterable<string>): Promise<Map<string, string>> {
  const ancestors = new Set((await runGit(root, ["rev-list", commit])).split("\n").filter((sha) => sha !== ""));
  const latest = new Map<string, string>();
  for (const candidate of view.commits) {
    if (!ancestors.has(candidate.sha)) continue;
    for (const change of candidate.changes) latest.set(change.path, change.fileId);
  }
  return new Map([...paths].map((path) => [path, latest.get(path) ?? path]));
}

/** True when `ancestor` is reachable from `descendant`. */
export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
