import { dominatorTree, dominates } from "./dominators.ts";
import { compareIds, normalise, reachableFrom, reverse, type Graph } from "./graph.ts";

export interface SiblingUnit {
  folder: string;
  /** The sibling set: files of one folder that are imported from outside it. Sorted. */
  entries: readonly string[];
  /** Every file that moves with the set: the entries plus everything only reachable through them. Sorted. */
  files: readonly string[];
}

/**
 * Multi-entry units (locality pipeline step 4). A folder's files that are imported from outside
 * the folder form a sibling set S. S is a unit when no single file of S dominates the rest
 * (otherwise the single-entry unit already covers it) and every edge into S plus the files
 * dominated by S, from outside that set, lands on a file in S.
 * `folderOf` maps a node id to its folder, for example the dirname of a repo-relative path.
 * Nodes the root cannot reach are ignored. The root is never part of a set.
 */
export function siblingSetUnits(input: Graph, root: string, folderOf: (id: string) => string): SiblingUnit[] {
  const graph = normalise(input);
  const reachable = reachableFrom(graph, [root]);
  const incoming = reverse(graph);
  const tree = dominatorTree(graph, root);

  const byFolder = new Map<string, string[]>();
  for (const id of reachable) {
    if (id === root) continue;
    const folder = folderOf(id);
    const outside = (incoming.get(id) ?? []).some((from) => reachable.has(from) && (from === root || folderOf(from) !== folder));
    if (!outside) continue;
    let list = byFolder.get(folder);
    if (!list) byFolder.set(folder, (list = []));
    list.push(id);
  }

  const units: SiblingUnit[] = [];
  for (const folder of [...byFolder.keys()].sort(compareIds)) {
    const entries = byFolder.get(folder)!.sort(compareIds);
    if (entries.length < 2) continue;
    if (entries.some((head) => entries.every((other) => dominates(tree, head, other)))) continue;

    const members = new Set(entries);
    const withoutSet = reachableFrom(removeNodes(graph, members), [root]);
    const files = [...reachable].filter((id) => id !== root && (members.has(id) || !withoutSet.has(id)));
    const unit = new Set(files);
    const closed = files.every((id) =>
      (incoming.get(id) ?? []).every((from) => unit.has(from) || !reachable.has(from) || members.has(id)),
    );
    if (!closed) continue;
    units.push({ folder, entries, files: files.sort(compareIds) });
  }
  return units;
}

function removeNodes(graph: Graph, removed: ReadonlySet<string>): Graph {
  const result = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    if (!removed.has(from)) result.set(from, targets.filter((to) => !removed.has(to)));
  }
  return result;
}
