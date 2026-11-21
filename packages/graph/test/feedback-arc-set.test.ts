import { describe, expect, it } from "vitest";
import {
  breakingSets,
  exactFeedbackArcSet,
  heuristicFeedbackArcSet,
  isAcyclicWithout,
  type Edge,
  type EdgeWeight,
} from "../src/feedback-arc-set.ts";
import { normalise, type Graph } from "../src/graph.ts";
import { randomGraph, seededRandom } from "./support/seeded-graphs.ts";

const g = (edges: Record<string, string[]>) => normalise(new Map(Object.entries(edges)));
const key = (e: Edge) => `${e.from}>${e.to}`;

function allEdges(graph: Graph): Edge[] {
  return [...graph].flatMap(([from, targets]) => targets.map((to) => ({ from, to })));
}

/** Reference: try every edge subset in order of size, then total weight. */
function bruteForceBest(graph: Graph, weight: EdgeWeight): { size: number; weight: number } {
  const edges = allEdges(graph);
  let best = { size: Infinity, weight: Infinity };
  for (let mask = 0; mask < 1 << edges.length; mask++) {
    const chosen = edges.filter((_, i) => mask & (1 << i));
    if (chosen.length > best.size) continue;
    const w = chosen.reduce((s, e) => s + weight(e), 0);
    if (chosen.length < best.size || w < best.weight) {
      if (isAcyclicWithout(graph, chosen)) best = { size: chosen.length, weight: w };
    }
  }
  return best;
}

function smallGraphs(count: number, nodes: number, density: number) {
  const cases: { seed: number; graph: Graph }[] = [];
  for (let seed = 1; seed <= count; seed++) {
    let graph = randomGraph(seed, { nodes, density, selfLoops: seed % 5 === 0 });
    // keep brute force tractable: thin the graph deterministically until it has few enough edges
    for (let attempt = 1; allEdges(graph).length > 13; attempt++) {
      graph = randomGraph(seed + attempt * 1000, { nodes, density: density * 0.9 ** attempt, selfLoops: seed % 5 === 0 });
    }
    cases.push({ seed, graph });
  }
  return cases;
}

describe("exactFeedbackArcSet", () => {
  it("cuts one edge of a simple cycle, the cheapest one", () => {
    const cycle = g({ a: ["b"], b: ["c"], c: ["a"] });
    expect(exactFeedbackArcSet(cycle).map(key)).toEqual(["a>b"]);
    const weight: EdgeWeight = (e) => (key(e) === "b>c" ? 0 : 5);
    expect(exactFeedbackArcSet(cycle, weight).map(key)).toEqual(["b>c"]);
  });

  it("includes self-loops", () => {
    expect(exactFeedbackArcSet(g({ a: ["a"] })).map(key)).toEqual(["a>a"]);
  });

  it("finds the one symbol used in the wrong direction", () => {
    // many edges point down, one points back up: cutting it breaks every cycle
    const layered = g({ top: ["mid1", "mid2"], mid1: ["low"], mid2: ["low"], low: ["top"] });
    expect(exactFeedbackArcSet(layered).map(key)).toEqual(["low>top"]);
  });

  it("matches a brute-force minimum on seeded graphs, including the weight tie-break", () => {
    for (const { seed, graph } of smallGraphs(80, 6, 0.3)) {
      const random = seededRandom(seed);
      const weights = new Map(allEdges(graph).map((e) => [key(e), Math.floor(random() * 4)]));
      const weight: EdgeWeight = (e) => weights.get(key(e)) ?? 0;
      const result = exactFeedbackArcSet(graph, weight);
      const best = bruteForceBest(graph, weight);
      expect(isAcyclicWithout(graph, result), `seed ${seed}`).toBe(true);
      expect(result.length, `seed ${seed}`).toBe(best.size);
      expect(result.reduce((s, e) => s + weight(e), 0), `seed ${seed}`).toBe(best.weight);
    }
  });

  it("is deterministic whatever order the graph is listed in", () => {
    for (const { seed, graph } of smallGraphs(40, 6, 0.3)) {
      const shuffled = new Map<string, string[]>();
      for (const id of [...graph.keys()].reverse()) shuffled.set(id, [...graph.get(id)!].reverse());
      expect(exactFeedbackArcSet(shuffled), `seed ${seed}`).toEqual(exactFeedbackArcSet(graph));
    }
  });
});

describe("heuristicFeedbackArcSet", () => {
  it("always leaves an acyclic graph, with a minimal set, and never beats the exact optimum", () => {
    let heuristicTotal = 0;
    let exactTotal = 0;
    for (const { seed, graph } of smallGraphs(150, 8, 0.25)) {
      const heuristic = heuristicFeedbackArcSet(graph);
      const exact = exactFeedbackArcSet(graph);
      expect(isAcyclicWithout(graph, heuristic), `seed ${seed}`).toBe(true);
      expect(heuristic.length, `seed ${seed}`).toBeGreaterThanOrEqual(exact.length);
      // minimal: restoring any one edge closes a cycle
      for (const edge of heuristic) {
        const without = heuristic.filter((e) => e !== edge);
        expect(isAcyclicWithout(graph, without), `seed ${seed}: ${key(edge)} is redundant`).toBe(false);
      }
      heuristicTotal += heuristic.length;
      exactTotal += exact.length;
    }
    // aggregate quality guard: close to optimal on small graphs
    expect(heuristicTotal).toBeLessThanOrEqual(Math.ceil(exactTotal * 1.25));
  });

  it("is deterministic whatever order the graph is listed in", () => {
    for (const { seed, graph } of smallGraphs(40, 8, 0.25)) {
      const shuffled = new Map<string, string[]>();
      for (const id of [...graph.keys()].reverse()) shuffled.set(id, [...graph.get(id)!].reverse());
      expect(heuristicFeedbackArcSet(shuffled), `seed ${seed}`).toEqual(heuristicFeedbackArcSet(graph));
    }
  });

  it("handles a large dense component", () => {
    const graph = randomGraph(7, { nodes: 300, density: 0.05 });
    const result = heuristicFeedbackArcSet(graph);
    expect(isAcyclicWithout(graph, result)).toBe(true);
  });
});

describe("breakingSets", () => {
  const graph = g({
    a: ["b"], b: ["a", "c"], c: [], // small cycle a<->b
    x: ["x"], // self-loop
    p: ["q"], q: ["r"], r: ["s"], s: ["p"], // 4-cycle
  });

  it("reports one set per cyclic component and nothing for acyclic nodes", () => {
    const sets = breakingSets(graph);
    expect(sets.map((s) => s.nodes)).toEqual([["a", "b"], ["p", "q", "r", "s"], ["x"]]);
    expect(sets.map((s) => s.edges.length)).toEqual([1, 1, 1]);
    expect(sets.every((s) => s.method === "exact")).toBe(true);
  });

  it("switches to the heuristic above the configured size and says so", () => {
    const sets = breakingSets(graph, { exactLimit: 3 });
    expect(sets.map((s) => s.method)).toEqual(["exact", "heuristic", "exact"]);
    expect(isAcyclicWithout(graph, sets.flatMap((s) => s.edges))).toBe(true);
  });

  it("breaking sets together leave the whole graph acyclic, exact or heuristic", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = randomGraph(seed, { nodes: 12, density: 0.15, selfLoops: true });
      for (const exactLimit of [16, 0]) {
        const edges = breakingSets(random, { exactLimit }).flatMap((s) => s.edges);
        expect(isAcyclicWithout(random, edges), `seed ${seed} limit ${exactLimit}`).toBe(true);
      }
    }
  });

  it("uses the heuristic only when the exact solver is out of range, and the exact set is never larger", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = randomGraph(seed, { nodes: 10, density: 0.2 });
      const exact = breakingSets(random, { exactLimit: 16 });
      const heuristic = breakingSets(random, { exactLimit: 0 });
      expect(heuristic.map((s) => s.nodes)).toEqual(exact.map((s) => s.nodes));
      exact.forEach((s, i) => expect(s.edges.length).toBeLessThanOrEqual(heuristic[i]!.edges.length));
    }
  });
});
