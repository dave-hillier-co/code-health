import type { Graph } from "../../src/graph.ts";

/** mulberry32: a small seeded PRNG so generated graphs are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomGraphOptions {
  nodes: number;
  /** Probability of each ordered pair being an edge. */
  density: number;
  selfLoops?: boolean;
}

export function nodeName(i: number): string {
  return `n${String(i).padStart(3, "0")}`;
}

export function randomGraph(seed: number, options: RandomGraphOptions): Graph {
  const random = seededRandom(seed);
  const graph = new Map<string, string[]>();
  for (let i = 0; i < options.nodes; i++) graph.set(nodeName(i), []);
  for (let i = 0; i < options.nodes; i++) {
    for (let j = 0; j < options.nodes; j++) {
      if (i === j && !options.selfLoops) continue;
      if (random() < options.density) graph.get(nodeName(i))!.push(nodeName(j));
    }
  }
  return graph;
}

/** Seeds 1..count, each with a node count and density cycling through a spread of shapes. */
export function graphCases(count: number, maxNodes: number): { seed: number; graph: Graph }[] {
  const densities = [0.05, 0.1, 0.2, 0.35];
  const cases: { seed: number; graph: Graph }[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const nodes = 1 + (seed % maxNodes);
    const density = densities[seed % densities.length]!;
    cases.push({ seed, graph: randomGraph(seed, { nodes, density, selfLoops: seed % 7 === 0 }) });
  }
  return cases;
}
