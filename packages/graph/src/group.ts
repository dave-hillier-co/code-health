import { compareIds, normalise, type Graph } from "./graph.ts";
import type { Edge } from "./feedback-arc-set.ts";

export interface GroupedGraph {
  /** The graph over group ids. Edges inside one group are dropped. */
  graph: Graph;
  /**
   * The member edges behind each group edge, sorted, keyed by `groupEdgeKey(from, to)`.
   * They are what a breaking set at group level actually cuts.
   */
  members: ReadonlyMap<string, readonly Edge[]>;
}

export const groupEdgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

/**
 * Collapses nodes into groups (files into folders or packages) so cycles can be found at a
 * coarser level. `groupOf` returns undefined for a node that belongs to no group, which is left out.
 */
export function groupGraph(graph: Graph, groupOf: (node: string) => string | undefined): GroupedGraph {
  const edges = new Map<string, string[]>();
  const members = new Map<string, Edge[]>();
  for (const [from, targets] of graph) {
    const source = groupOf(from);
    if (source === undefined) continue;
    if (!edges.has(source)) edges.set(source, []);
    for (const to of targets) {
      const target = groupOf(to);
      if (target === undefined) continue;
      if (!edges.has(target)) edges.set(target, []);
      if (target === source) continue;
      edges.get(source)!.push(target);
      const key = groupEdgeKey(source, target);
      if (!members.has(key)) members.set(key, []);
      members.get(key)!.push({ from, to });
    }
  }
  for (const list of members.values()) list.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
  return { graph: normalise(edges), members };
}
