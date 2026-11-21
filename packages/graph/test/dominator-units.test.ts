import { describe, expect, it } from "vitest";
import { normalise, reachableFrom, subgraph } from "../src/graph.ts";
import { dominatorUnits } from "../src/dominator-units.ts";
import { stronglyConnectedComponents } from "../src/scc.ts";
import { graphCases, nodeName } from "./support/seeded-graphs.ts";

const g = (edges: Record<string, string[]>) => normalise(new Map(Object.entries(edges)));

describe("dominatorUnits", () => {
  it("moves a cycle whole and expands units back into files", () => {
    // r -> a -> {b, c} ; b <-> c ; c -> d
    const graph = g({ r: ["a"], a: ["b"], b: ["c"], c: ["b", "d"], d: [] });
    const result = dominatorUnits(graph, "r");
    expect(result.units.get("a")).toEqual(["a", "b", "c", "d"]);
    expect(result.units.get("b")).toEqual(["b", "c", "d"]);
    expect(result.units.has("c")).toBe(false);
    expect(result.units.get("d")).toEqual(["d"]);
    expect(result.unreachable).toEqual([]);
  });

  it("reports unreachable files and keeps them out of every unit", () => {
    const graph = g({ r: ["a"], a: [], dead: ["a"], deader: ["dead"] });
    const result = dominatorUnits(graph, "r");
    expect(result.unreachable).toEqual(["dead", "deader"]);
    for (const files of result.units.values()) expect(files).not.toContain("dead");
  });

  it("never splits a cycle, and each unit is exactly what its root's removal cuts off", () => {
    for (const { seed, graph } of graphCases(120, 12)) {
      const root = nodeName(0);
      const { units, unreachable } = dominatorUnits(graph, root);
      const components = stronglyConnectedComponents(graph);
      const reachable = reachableFrom(graph, [root]);
      expect(unreachable.length + reachable.size, `seed ${seed}`).toBe(graph.size);

      for (const [unitRoot, files] of units) {
        const fileSet = new Set(files);
        for (const component of components) {
          const inside = component.filter((id) => fileSet.has(id)).length;
          expect(inside === 0 || inside === component.length, `seed ${seed}: unit ${unitRoot} splits a cycle`).toBe(true);
        }
        // the unit root's whole cycle is the entry, and removing it cuts off exactly the rest of the unit
        const entry = components.find((c) => c.includes(unitRoot))!;
        if (entry.includes(root)) continue;
        const without = subgraph(graph, new Set([...graph.keys()].filter((id) => !entry.includes(id))));
        const stillReachable = reachableFrom(without, [root]);
        const cutOff = [...reachable].filter((id) => !stillReachable.has(id)).sort();
        expect(files, `seed ${seed}: unit ${unitRoot}`).toEqual(cutOff);
      }
    }
  });
});

describe("dominatorUnits on un-normalised adjacency", () => {
  it("treats leaf targets as nodes", () => {
    const graph = new Map([["root", ["a"]], ["a", ["b"]]]);
    const result = dominatorUnits(graph, "root");
    expect(result.units.get("a")).toEqual(["a", "b"]);
    expect(result.units.get("b")).toEqual(["b"]);
  });

  it("reports every node as unreachable when the root is not in the graph", () => {
    const result = dominatorUnits(new Map([["x", ["y"]], ["y", []]]), "root");
    expect(result.units.size).toBe(0);
    expect(result.unreachable).toEqual(["x", "y"]);
  });
});
