import { compareIds, normalise, reachableFrom, subgraph, type Graph } from "./graph.ts";
import { stronglyConnectedComponents } from "./scc.ts";

export interface Edge {
  from: string;
  to: string;
}

/** Co-change strength of an edge. A lower value means the edge is cheaper to cut. */
export type EdgeWeight = (edge: Edge) => number;

export interface BreakingSetOptions {
  /** Components with at most this many nodes are solved exactly. Default 16. */
  exactLimit?: number;
  /** Tie-break between equally small sets: the set with the lower total weight wins. Default: no weight. */
  weight?: EdgeWeight;
}

export interface CycleBreak {
  /** The cyclic strongly connected component, sorted. */
  nodes: readonly string[];
  /** A feedback arc set of the component: removing these edges leaves it acyclic. Sorted. */
  edges: readonly Edge[];
  /** `exact` is a minimum feedback arc set. `heuristic` is Eades-Lin-Smyth, then pruned to a minimal set. */
  method: "exact" | "heuristic";
}

export const DEFAULT_EXACT_LIMIT = 16;

const noWeight: EdgeWeight = () => 0;

function compareEdges(a: Edge, b: Edge): number {
  return compareIds(a.from, b.from) || compareIds(a.to, b.to);
}

/** Edges within a graph other than self-loops, sorted. */
function proper(graph: Graph): Edge[] {
  const edges: Edge[] = [];
  for (const [from, targets] of graph) {
    for (const to of targets) if (to !== from) edges.push({ from, to });
  }
  return edges.sort(compareEdges);
}

function selfLoops(graph: Graph): Edge[] {
  const edges: Edge[] = [];
  for (const [from, targets] of graph) if (targets.includes(from)) edges.push({ from, to: from });
  return edges.sort(compareEdges);
}

/** True when the graph has no cycle once `removed` edges are taken out. */
export function isAcyclicWithout(graph: Graph, removed: readonly Edge[]): boolean {
  const cut = new Set(removed.map((e) => `${e.from}\u0000${e.to}`));
  const kept = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    kept.set(from, targets.filter((to) => !cut.has(`${from}\u0000${to}`)));
  }
  return stronglyConnectedComponents(kept).every((c) => c.length === 1 && !kept.get(c[0]!)!.includes(c[0]!));
}

/**
 * Minimum feedback arc set by dynamic programming over node subsets: the best linear order
 * places nodes one at a time, and an edge to an already placed node is a backward edge.
 * Cost grows as 2^n, so callers bound n. Ties go to the lower total weight, then to the lower
 * node id in the last position, so the result is deterministic. Self-loops are always included.
 */
export function exactFeedbackArcSet(graph: Graph, weight: EdgeWeight = noWeight): Edge[] {
  const g = normalise(graph);
  const ids = [...g.keys()];
  const n = ids.length;
  if (n > 30) throw new RangeError(`exactFeedbackArcSet: ${n} nodes is too many for subset search`);
  const index = new Map(ids.map((id, i) => [id, i]));

  const out: number[] = ids.map((id) => {
    let mask = 0;
    for (const to of g.get(id)!) if (to !== id) mask |= 1 << index.get(to)!;
    return mask;
  });
  // cost of node v being placed after every node in `mask`: its edges into the mask are backward
  const edgeWeight = ids.map((from) =>
    ids.map((to) => (g.get(from)!.includes(to) && to !== from ? weight({ from, to }) : 0)),
  );

  const size = 1 << n;
  const count = new Int32Array(size);
  const total = new Float64Array(size);
  const last = new Int8Array(size).fill(-1);
  for (let mask = 1; mask < size; mask++) {
    let bestCount = Infinity;
    let bestTotal = Infinity;
    let bestLast = -1;
    for (let v = 0; v < n; v++) {
      if (!(mask & (1 << v))) continue;
      const rest = mask & ~(1 << v);
      let c = count[rest]!;
      let w = total[rest]!;
      let backward = out[v]! & rest;
      while (backward) {
        const bit = backward & -backward;
        backward ^= bit;
        c++;
        w += edgeWeight[v]![31 - Math.clz32(bit)]!;
      }
      if (c < bestCount || (c === bestCount && w < bestTotal)) {
        bestCount = c;
        bestTotal = w;
        bestLast = v;
      }
    }
    count[mask] = bestCount;
    total[mask] = bestTotal;
    last[mask] = bestLast;
  }

  const position = new Map<string, number>();
  let mask = size - 1;
  for (let slot = n - 1; slot >= 0; slot--) {
    const v = last[mask]!;
    position.set(ids[v]!, slot);
    mask &= ~(1 << v);
  }
  const edges = proper(g).filter((e) => position.get(e.to)! < position.get(e.from)!);
  return [...selfLoops(g), ...edges].sort(compareEdges);
}

/**
 * Eades-Lin-Smyth heuristic: repeatedly peel sinks to the right end and sources to the left end,
 * otherwise move the node with the largest out-minus-in degree to the left end. Ties go to the
 * node whose incoming edges (which become backward when it is placed) weigh least, then to the
 * lower id. Backward edges form the set, which is then pruned until no edge can be restored
 * without closing a cycle. Self-loops are always included.
 */
export function heuristicFeedbackArcSet(graph: Graph, weight: EdgeWeight = noWeight): Edge[] {
  const g = normalise(graph);
  const edges = proper(g);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of g.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const { from, to } of edges) {
    outgoing.get(from)!.push(to);
    incoming.get(to)!.push(from);
  }

  const remaining = new Set(g.keys());
  const outDegree = new Map([...g.keys()].map((id) => [id, outgoing.get(id)!.length]));
  const inDegree = new Map([...g.keys()].map((id) => [id, incoming.get(id)!.length]));
  const inWeight = new Map(
    [...g.keys()].map((id) => [id, incoming.get(id)!.reduce((s, from) => s + weight({ from, to: id }), 0)]),
  );
  const left: string[] = [];
  const right: string[] = [];

  const remove = (id: string) => {
    remaining.delete(id);
    for (const to of outgoing.get(id)!) {
      if (remaining.has(to)) {
        inDegree.set(to, inDegree.get(to)! - 1);
        inWeight.set(to, inWeight.get(to)! - weight({ from: id, to }));
      }
    }
    for (const from of incoming.get(id)!) {
      if (remaining.has(from)) outDegree.set(from, outDegree.get(from)! - 1);
    }
  };

  const ordered = [...g.keys()];
  while (remaining.size > 0) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of ordered) {
        if (remaining.has(id) && outDegree.get(id) === 0) {
          right.push(id);
          remove(id);
          progressed = true;
        }
      }
      for (const id of ordered) {
        if (remaining.has(id) && inDegree.get(id) === 0) {
          left.push(id);
          remove(id);
          progressed = true;
        }
      }
    }
    if (remaining.size === 0) break;
    let best: string | undefined;
    for (const id of ordered) {
      if (!remaining.has(id)) continue;
      if (best === undefined) {
        best = id;
        continue;
      }
      const delta = outDegree.get(id)! - inDegree.get(id)!;
      const bestDelta = outDegree.get(best)! - inDegree.get(best)!;
      if (delta > bestDelta || (delta === bestDelta && inWeight.get(id)! < inWeight.get(best)!)) best = id;
    }
    left.push(best!);
    remove(best!);
  }

  const order = [...left, ...right.reverse()];
  const position = new Map(order.map((id, i) => [id, i]));
  const backward = edges.filter((e) => position.get(e.to)! < position.get(e.from)!);

  // Prune: restore the most expensive edges first while the rest stays acyclic.
  const kept = new Map<string, string[]>();
  for (const [from, targets] of g) kept.set(from, targets.filter((to) => to !== from));
  const cut = new Set(backward.map((e) => `${e.from}\u0000${e.to}`));
  for (const [from, targets] of kept) kept.set(from, targets.filter((to) => !cut.has(`${from}\u0000${to}`)));
  const byCost = [...backward].sort((a, b) => weight(b) - weight(a) || compareEdges(a, b));
  const result: Edge[] = [];
  for (const edge of byCost) {
    if (reachableFrom(kept, [edge.to]).has(edge.from)) {
      result.push(edge);
    } else {
      kept.set(edge.from, [...kept.get(edge.from)!, edge.to]);
    }
  }
  return [...selfLoops(g), ...result].sort(compareEdges);
}

/**
 * Cycle-breaking sets for a graph, one per cyclic strongly connected component, ordered by the
 * component's lowest member. Components up to `exactLimit` nodes get a minimum set; larger
 * ones get the heuristic set. A single node with a self-loop is a cycle of its own.
 */
export function breakingSets(graph: Graph, options: BreakingSetOptions = {}): CycleBreak[] {
  const limit = options.exactLimit ?? DEFAULT_EXACT_LIMIT;
  const weight = options.weight ?? noWeight;
  const g = normalise(graph);
  const results: CycleBreak[] = [];
  for (const component of stronglyConnectedComponents(g)) {
    const induced = subgraph(g, new Set(component));
    const cyclic = component.length > 1 || induced.get(component[0]!)!.includes(component[0]!);
    if (!cyclic) continue;
    const exact = component.length <= limit;
    results.push({
      nodes: component,
      edges: exact ? exactFeedbackArcSet(induced, weight) : heuristicFeedbackArcSet(induced, weight),
      method: exact ? "exact" : "heuristic",
    });
  }
  return results;
}
