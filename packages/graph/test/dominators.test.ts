import { describe, expect, it } from "vitest";
import { normalise, reachableFrom, subgraph, type Graph } from "../src/graph.ts";
import {
  dominates,
  dominatedSubtree,
  dominatorTree,
  lowestCommonDominator,
  unreachableFrom,
} from "../src/dominators.ts";
import { graphCases, nodeName } from "./support/seeded-graphs.ts";

const g = (edges: Record<string, string[]>) => normalise(new Map(Object.entries(edges)));

/** Textbook definition: d dominates n iff n is reachable from the root but not once d is removed. */
function textbookDominates(graph: Graph, root: string, d: string, n: string): boolean {
  if (!reachableFrom(graph, [root]).has(n)) return false;
  if (d === n || d === root) return true;
  const without = subgraph(graph, new Set([...graph.keys()].filter((id) => id !== d)));
  return !reachableFrom(without, [root]).has(n);
}

describe("dominatorTree", () => {
  const diamond = g({ r: ["a", "b"], a: ["c"], b: ["c"], c: ["d"], d: [] });

  it("computes immediate dominators", () => {
    const tree = dominatorTree(diamond, "r");
    expect(Object.fromEntries(tree.idom)).toEqual({ a: "r", b: "r", c: "r", d: "c" });
  });

  it("handles loops and irreducible flow", () => {
    // the classic CHK irreducible example: 5 -> 4,3 ; 4 -> 1 ; 3 -> 2 ; 1 <-> 2
    const graph = g({ "6": ["5", "4"], "5": ["1"], "4": ["2", "3"], "3": ["2"], "2": ["1", "3"], "1": ["2"] });
    const tree = dominatorTree(graph, "6");
    for (const id of ["1", "2", "3", "4", "5"]) expect(tree.idom.get(id)).toBe("6");
  });

  it("reports nodes the root cannot reach as unreachable and leaves them out of the tree", () => {
    const graph = g({ r: ["a"], a: [], x: ["a"] });
    const tree = dominatorTree(graph, "r");
    expect(tree.idom.has("x")).toBe(false);
    expect(unreachableFrom(graph, "r")).toEqual(["x"]);
  });

  it("answers dominance, subtrees and the lowest common dominator", () => {
    const tree = dominatorTree(diamond, "r");
    expect(dominates(tree, "c", "d")).toBe(true);
    expect(dominates(tree, "a", "c")).toBe(false);
    expect(dominates(tree, "d", "d")).toBe(true);
    expect(dominatedSubtree(tree, "c")).toEqual(["c", "d"]);
    expect(dominatedSubtree(tree, "r")).toEqual(["a", "b", "c", "d", "r"]);
    expect(lowestCommonDominator(tree, "a", "b")).toBe("r");
    expect(lowestCommonDominator(tree, "c", "d")).toBe("c");
    expect(lowestCommonDominator(tree, "a", "x")).toBeUndefined();
  });

  it("matches the textbook definition on seeded graphs", () => {
    for (const { seed, graph } of graphCases(150, 12)) {
      const root = nodeName(0);
      const tree = dominatorTree(graph, root);
      for (const d of graph.keys()) {
        for (const n of graph.keys()) {
          expect(dominates(tree, d, n), `seed ${seed}: ${d} dom ${n}`).toBe(textbookDominates(graph, root, d, n));
        }
      }
    }
  });

  it("is independent of the order nodes and edges are listed in", () => {
    for (const { seed, graph } of graphCases(60, 12)) {
      const shuffled = new Map<string, string[]>();
      for (const id of [...graph.keys()].reverse()) shuffled.set(id, [...graph.get(id)!].reverse());
      const a = dominatorTree(graph, nodeName(0));
      const b = dominatorTree(shuffled, nodeName(0));
      expect([...a.idom].sort(), `seed ${seed}`).toEqual([...b.idom].sort());
    }
  });

  it("copes with a very long chain", () => {
    const chain = new Map<string, string[]>();
    for (let i = 0; i < 20_000; i++) chain.set(`n${i}`, [`n${i + 1}`]);
    chain.set("n20000", []);
    const tree = dominatorTree(chain, "n0");
    expect(tree.idom.get("n20000")).toBe("n19999");
  });
});
