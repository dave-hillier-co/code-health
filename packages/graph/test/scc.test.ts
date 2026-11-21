import { describe, expect, it } from "vitest";
import { normalise, reachableFrom } from "../src/graph.ts";
import { condense, expandComponent, stronglyConnectedComponents } from "../src/scc.ts";
import { graphCases } from "./support/seeded-graphs.ts";

const g = (edges: Record<string, string[]>) => normalise(new Map(Object.entries(edges)));

describe("stronglyConnectedComponents", () => {
  it("finds cycles and leaves acyclic nodes as singletons, in id order", () => {
    const graph = g({ a: ["b"], b: ["c"], c: ["a", "d"], d: ["e"], e: ["d"], f: ["a"] });
    expect(stronglyConnectedComponents(graph)).toEqual([["a", "b", "c"], ["d", "e"], ["f"]]);
  });

  it("does not overflow the stack on a long cycle", () => {
    const ring = new Map<string, string[]>();
    const n = 300_000;
    for (let i = 0; i < n; i++) ring.set(`n${i}`, [`n${(i + 1) % n}`]);
    const components = stronglyConnectedComponents(ring);
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(n);
  });

  it("agrees with mutual reachability on seeded graphs", () => {
    for (const { seed, graph } of graphCases(120, 14)) {
      const components = stronglyConnectedComponents(graph);
      const reach = new Map([...graph.keys()].map((id) => [id, reachableFrom(graph, [id])]));
      const seen = new Set<string>();
      for (const component of components) {
        for (const id of component) {
          expect(seen.has(id), `seed ${seed}: ${id} in two components`).toBe(false);
          seen.add(id);
        }
        for (const a of component) {
          for (const b of component) expect(reach.get(a)!.has(b), `seed ${seed}`).toBe(true);
        }
      }
      expect(seen.size).toBe(graph.size);
      // maximal: nodes in different components are never mutually reachable
      const componentOf = new Map(components.flatMap((c, i) => c.map((id) => [id, i] as const)));
      for (const a of graph.keys()) {
        for (const b of graph.keys()) {
          if (componentOf.get(a) !== componentOf.get(b)) {
            expect(reach.get(a)!.has(b) && reach.get(b)!.has(a), `seed ${seed}: ${a} ${b}`).toBe(false);
          }
        }
      }
    }
  });
});

describe("condense", () => {
  it("names each component by its lowest member and links components by their edges", () => {
    const graph = g({ a: ["b"], b: ["a", "c"], c: ["d"], d: [] });
    const condensed = condense(graph);
    expect([...condensed.graph.entries()]).toEqual([["a", ["c"]], ["c", ["d"]], ["d", []]]);
    expect(condensed.componentOf.get("b")).toBe("a");
    expect(expandComponent(condensed, "a")).toEqual(["a", "b"]);
  });

  it("never splits a cycle: edges on a cycle stay inside one unit, and the condensation is acyclic", () => {
    for (const { seed, graph } of graphCases(120, 14)) {
      const condensed = condense(graph);
      const reach = new Map([...graph.keys()].map((id) => [id, reachableFrom(graph, [id])]));
      for (const [from, targets] of graph) {
        for (const to of targets) {
          const onCycle = reach.get(to)!.has(from);
          if (onCycle) {
            expect(condensed.componentOf.get(from), `seed ${seed}: ${from}->${to}`).toBe(
              condensed.componentOf.get(to),
            );
          }
        }
      }
      expect(stronglyConnectedComponents(condensed.graph).every((c) => c.length === 1)).toBe(true);
      for (const [id, targets] of condensed.graph) expect(targets).not.toContain(id);
    }
  });
});

describe("un-normalised adjacency", () => {
  it("includes leaf targets as components", () => {
    const graph = new Map([["root", ["a"]], ["a", ["b"]]]);
    expect(stronglyConnectedComponents(graph)).toEqual([["a"], ["b"], ["root"]]);
  });
});
