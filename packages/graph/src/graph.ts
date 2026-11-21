/** Plain adjacency over string node ids (paths, or symbol ids "path#Qualified.name"). */
export type Graph = ReadonlyMap<string, readonly string[]>;

/** UTF-8 byte order, which is how git orders paths and how the rest of the suite breaks ties. */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * Canonical form: every edge target is also a node, nodes iterate in id order,
 * and each target list is sorted and free of duplicates.
 */
export function normalise(graph: Graph): Graph {
  const ids = new Set<string>();
  for (const [from, targets] of graph) {
    ids.add(from);
    for (const to of targets) ids.add(to);
  }
  const result = new Map<string, string[]>();
  for (const id of [...ids].sort(compareIds)) {
    result.set(id, [...new Set(graph.get(id) ?? [])].sort(compareIds));
  }
  return result;
}

export function reverse(graph: Graph): Graph {
  const result = new Map<string, string[]>();
  for (const id of graph.keys()) result.set(id, []);
  for (const [from, targets] of graph) {
    for (const to of targets) {
      let list = result.get(to);
      if (!list) result.set(to, (list = []));
      list.push(from);
    }
  }
  return normalise(result);
}

/** The graph induced by `nodes`: only those nodes and the edges between them. */
export function subgraph(graph: Graph, nodes: ReadonlySet<string>): Graph {
  const result = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    if (!nodes.has(from)) continue;
    result.set(from, targets.filter((to) => nodes.has(to)));
  }
  return result;
}

/** Every node reachable from the roots (roots included), by iterative traversal. */
export function reachableFrom(graph: Graph, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) {
    if (graph.has(root) && !seen.has(root)) {
      seen.add(root);
      stack.push(root);
    }
  }
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const to of graph.get(id) ?? []) {
      if (graph.has(to) && !seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}
