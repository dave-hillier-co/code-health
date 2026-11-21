import { describe, expect, it } from "vitest";
import { compareIds, normalise, reachableFrom, reverse, subgraph } from "../src/graph.ts";

describe("compareIds", () => {
  it("orders by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E (BMP, 3 bytes) sorts before U+1F600 (astral, 4 bytes) in UTF-8, after it in UTF-16
    expect(compareIds("～", "\u{1F600}")).toBeLessThan(0);
    expect(compareIds("a", "b")).toBeLessThan(0);
    expect(compareIds("a", "a")).toBe(0);
  });
});

describe("normalise", () => {
  it("sorts nodes and targets, dedupes edges and adds edge targets as nodes", () => {
    const g = normalise(new Map([["b", ["z", "a", "a"]], ["a", []]]));
    expect([...g.keys()]).toEqual(["a", "b", "z"]);
    expect(g.get("b")).toEqual(["a", "z"]);
    expect(g.get("z")).toEqual([]);
  });
});

describe("reverse and subgraph", () => {
  const g = normalise(new Map([["a", ["b", "c"]], ["b", ["c"]]]));
  it("reverses every edge", () => {
    const r = reverse(g);
    expect(r.get("c")).toEqual(["a", "b"]);
    expect(r.get("a")).toEqual([]);
  });
  it("restricts to a node set", () => {
    const s = subgraph(g, new Set(["a", "c"]));
    expect([...s.entries()]).toEqual([["a", ["c"]], ["c", []]]);
  });
});

describe("reachableFrom", () => {
  const g = normalise(new Map([["r", ["a"]], ["a", ["b"]], ["b", ["a"]], ["x", ["a"]]]));
  it("includes the roots and follows edges transitively", () => {
    expect([...reachableFrom(g, ["r"])].sort()).toEqual(["a", "b", "r"]);
  });
  it("ignores roots that are not nodes", () => {
    expect([...reachableFrom(g, ["nope"])]).toEqual([]);
  });
  it("handles very deep chains without recursion", () => {
    const chain = new Map<string, string[]>();
    for (let i = 0; i < 200_000; i++) chain.set(`n${i}`, [`n${i + 1}`]);
    chain.set("n200000", []);
    expect(reachableFrom(chain, ["n0"]).size).toBe(200_001);
  });
});
