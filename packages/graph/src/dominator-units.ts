import { dominatedSubtree, dominatorTree, unreachableFrom } from "./dominators.ts";
import { compareIds, type Graph } from "./graph.ts";
import { condense, expandComponent } from "./scc.ts";

export interface DominatorUnits {
  /**
   * Movable units keyed by their entry file: the lowest-id member of the entry's cycle,
   * or the file itself when it is in no cycle. Each value is every file that moves with
   * the unit (the entry's whole cycle plus everything it dominates), sorted.
   */
  units: ReadonlyMap<string, readonly string[]>;
  /** Files the root cannot reach. They take no part in unit finding. */
  unreachable: readonly string[];
}

/**
 * Locality's movable units: condense cycles so a cycle can only move whole, take dominators
 * over the condensed graph from the virtual root, then expand back into files.
 * The root itself is not a unit.
 */
export function dominatorUnits(graph: Graph, root: string): DominatorUnits {
  const condensation = condense(graph);
  const rootComponent = condensation.componentOf.get(root);
  if (rootComponent === undefined) return { units: new Map(), unreachable: [] };

  const tree = dominatorTree(condensation.graph, rootComponent);
  const units = new Map<string, readonly string[]>();
  for (const componentId of tree.idom.keys()) {
    const files = dominatedSubtree(tree, componentId).flatMap((id) => expandComponent(condensation, id));
    units.set(componentId, [...files].sort(compareIds));
  }
  return { units, unreachable: unreachableFrom(graph, root) };
}
