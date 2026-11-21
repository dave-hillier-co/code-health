import { runGit } from "@code-health/history/git";
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
  /** First lines of the messages of the main-line commit and of the commits it brought in. */
  subjects: string[];
  /** How it came in: a merge commit, or one commit on the main line. */
  how: "merge" | "direct";
}

export interface Mainline {
  /** Oldest first. Changes whose files were all filtered out are not listed. */
  changes: MergedChange[];
  merges: number;
  direct: number;
}

interface CommitLine {
  sha: string;
  parents: string[];
  time: number;
  subject: string;
}

async function readGraph(root: string, tip: string): Promise<Map<string, CommitLine>> {
  const out = await runGit(root, ["log", "--format=%H%x1f%P%x1f%ct%x1f%s", tip]);
  const graph = new Map<string, CommitLine>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const [sha, parents, time, ...subject] = line.split("\x1f");
    graph.set(sha!, { sha: sha!, parents: parents === "" ? [] : parents!.split(" "), time: Number(time), subject: subject.join("\x1f") });
  }
  return graph;
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
  const graph = await readGraph(root, tip);
  const line: CommitLine[] = [];
  for (let at = graph.get(tip); at !== undefined; at = at.parents[0] === undefined ? undefined : graph.get(at.parents[0])) {
    line.push(at);
  }
  line.reverse();

  const commits = new Map(view.commits.map((c) => [c.sha, c]));
  const logicalOf = new Map<string, LogicalChange>();
  for (const change of changes) for (const sha of change.shas) logicalOf.set(sha, change);

  const assigned = new Set<string>(line.map((c) => c.sha));
  const result: MergedChange[] = [];
  let merges = 0;
  let direct = 0;
  let clock = 0;
  for (const entry of line) {
    clock = Math.max(clock, entry.time);
    const members: string[] = [];
    const subjects = [entry.subject];
    if (entry.parents.length > 1) {
      merges++;
      // Everything the merge brought in, oldest first, and not already part of an earlier change.
      const stack = entry.parents.slice(1);
      const found: CommitLine[] = [];
      while (stack.length > 0) {
        const sha = stack.pop()!;
        if (assigned.has(sha)) continue;
        assigned.add(sha);
        const commit = graph.get(sha);
        if (!commit) continue;
        found.push(commit);
        stack.push(...commit.parents);
      }
      found.sort((a, b) => a.time - b.time || (a.sha < b.sha ? -1 : 1));
      for (const commit of found) {
        if (commit.parents.length < 2) {
          members.push(commit.sha);
          subjects.push(commit.subject);
        }
      }
    } else {
      direct++;
      members.push(entry.sha);
    }

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
      id: entry.sha,
      time: clock,
      shas: members.filter((sha) => commits.has(sha)),
      authors: [...new Set(distinct.flatMap((c) => c.authors))].sort(),
      files,
      subjects: [...new Set(subjects)],
      how: entry.parents.length > 1 ? "merge" : "direct",
    });
  }
  return { changes: result, merges, direct };
}
