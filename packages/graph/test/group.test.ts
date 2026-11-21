import { expect, it } from "vitest";
import { groupGraph } from "../src/group.ts";
import { normalise } from "../src/graph.ts";

const g = (edges: Record<string, string[]>) => normalise(new Map(Object.entries(edges)));
const byFolder = (path: string) => path.slice(0, path.lastIndexOf("/"));

it("collapses nodes into their groups, dropping edges inside one group", () => {
  const grouped = groupGraph(g({ "a/x": ["a/y", "b/x"], "a/y": [], "b/x": ["a/y"] }), byFolder);
  expect([...grouped.graph]).toEqual([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
});

it("keeps the member edges behind each group edge, in order", () => {
  const grouped = groupGraph(g({ "a/y": ["b/x"], "a/x": ["b/x", "b/y"], "b/x": [], "b/y": [] }), byFolder);
  expect(grouped.members.get("a\u0000b")).toEqual([
    { from: "a/x", to: "b/x" },
    { from: "a/x", to: "b/y" },
    { from: "a/y", to: "b/x" },
  ]);
});

it("lists every group as a node, even one with no edges", () => {
  expect([...groupGraph(g({ "a/x": [], "b/x": [] }), byFolder).graph.keys()]).toEqual(["a", "b"]);
});

it("leaves out a node the grouping does not name", () => {
  const grouped = groupGraph(g({ "a/x": ["z"], z: ["a/x"] }), (p) => (p === "z" ? undefined : byFolder(p)));
  expect([...grouped.graph]).toEqual([["a", []]]);
});
