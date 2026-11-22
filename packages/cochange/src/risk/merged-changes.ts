import { readLandings } from "@code-health/history/landings";
import { mergeFileChanges } from "@code-health/history/grouping";
import type { LogicalChange } from "@code-health/history/noise";
import type { HistoryChange, HistoryView } from "@code-health/history/read";

/**
 * A past change as it was merged: the commits a merge commit brought in, taken together, or a squash
 * commit, or a single commit on the main line. This is the unit the baseline population is made of,
 * so a branch is compared with like and never with its individual commits.
 */
export interface MergedChange {
  /** The commit on the main line that brought the change in. */
  id: string;
  /** Committer date of that commit, in unix seconds, never earlier than the change before it. */
  time: number;
  /** The non-merge commits of the change, oldest first. */
  shas: string[];
  /** Distinct mapped author emails. */
  authors: string[];
  /** Files left after the noise filters, one entry per file, as the change leaves them. */
  files: HistoryChange[];
  /** What the change says of itself, which is what decides whether it is a fix: the pull request title of a merge, or the message of a squash or direct commit. */
  text: string;
  /** The messages of the commits only the merge's later parents reach. They are not what the change is classified by. */
  branchMessages: string[];
  /** How it came in: a merge commit, or one commit on the main line. */
  how: "merge" | "direct";
}

export interface Mainline {
  /** Oldest first. Changes whose files were all filtered out are not listed. */
  changes: MergedChange[];
  merges: number;
  direct: number;
}

/**
 * The changes on the first-parent line of `tip`, oldest first. The merge style is read from the graph
 * itself: a commit with several parents brings in everything reachable from its later parents that
 * the line did not already have, any other commit on the line stands for itself.
 */
export async function mergedChanges(
  root: string,
  view: HistoryView,
  changes: readonly LogicalChange[],
  tip: string,
): Promise<Mainline> {
  const landings = await readLandings(root, tip);
  const commits = new Map(view.commits.map((c) => [c.sha, c]));
  const logicalOf = new Map<string, LogicalChange>();
  for (const change of changes) for (const sha of change.shas) logicalOf.set(sha, change);

  const result: MergedChange[] = [];
  let merges = 0;
  let direct = 0;
  let clock = 0;
  for (const landing of landings) {
    clock = Math.max(clock, landing.time);
    if (landing.how === "merge") merges++;
    else direct++;
    const members = landing.members;
    const distinct = [...new Set(members.flatMap((sha) => (logicalOf.has(sha) ? [logicalOf.get(sha)!] : [])))];
    if (distinct.length === 0) continue;
    const perFile = new Map<string, HistoryChange[]>();
    for (const change of distinct) {
      for (const file of change.files) {
        const list = perFile.get(file.fileId);
        if (list) list.push(file);
        else perFile.set(file.fileId, [file]);
      }
    }
    const files = [...perFile.values()].map(mergeFileChanges).sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
    result.push({
      id: landing.id,
      time: clock,
      shas: members.filter((sha) => commits.has(sha)),
      authors: [...new Set(distinct.flatMap((c) => c.authors))].sort(),
      files,
      text: landing.text,
      branchMessages: landing.branch.map((commit) => commit.message),
      how: landing.how,
    });
  }
  return { changes: result, merges, direct };
}
