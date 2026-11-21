import { expect, test } from "vitest";
import { seededRandom } from "./support/seeded-graphs.ts";
import { depthOf, folderDistance, folderOf, treeDistance } from "../src/tree-distance.ts";

test("files are placed at the depth of their folder", () => {
  expect(folderOf("a.ts")).toBe("");
  expect(folderOf("src/a.ts")).toBe("src");
  expect(folderOf("src/billing/a.ts")).toBe("src/billing");
  expect(depthOf("")).toBe(0);
  expect(depthOf("src")).toBe(1);
  expect(depthOf("src/billing")).toBe(2);
});

test("files in the same folder are at distance zero, including at the root", () => {
  expect(treeDistance("a.ts", "b.ts")).toBe(0);
  expect(treeDistance("src/a.ts", "src/b.ts")).toBe(0);
  expect(treeDistance("src/a.ts", "src/a.ts")).toBe(0);
});

test("distance counts the folder edges through the lowest common ancestor", () => {
  expect(treeDistance("a.ts", "src/a.ts")).toBe(1);
  expect(treeDistance("src/a.ts", "src/billing/a.ts")).toBe(1);
  expect(treeDistance("src/billing/a.ts", "src/reports/a.ts")).toBe(2);
  expect(treeDistance("src/billing/a.ts", "test/billing/a.ts")).toBe(4);
  expect(treeDistance("a/b/c/d.ts", "a/x/y/z/w.ts")).toBe(5);
});

test("a folder is not confused with a folder that shares its name prefix", () => {
  expect(treeDistance("src/a.ts", "src2/a.ts")).toBe(2);
  expect(treeDistance("src/app/a.ts", "src/application/a.ts")).toBe(2);
});

test("folder distance is the same function with files at their folder's depth", () => {
  expect(folderDistance("src/billing", "src/reports")).toBe(2);
  expect(folderDistance("", "src/billing")).toBe(2);
  expect(treeDistance("src/billing/a.ts", "src/reports/b.ts")).toBe(folderDistance("src/billing", "src/reports"));
});

test("malformed paths are rejected rather than measured", () => {
  expect(() => treeDistance("", "a.ts")).toThrow(/path/);
  expect(() => treeDistance("/src/a.ts", "a.ts")).toThrow(/path/);
  expect(() => treeDistance("src//a.ts", "a.ts")).toThrow(/path/);
  expect(() => treeDistance("src/", "a.ts")).toThrow(/path/);
});

function randomPath(next: () => number): string {
  const names = ["a", "b", "c", "ab", "src", "src2"];
  const depth = Math.floor(next() * 5);
  const folders = Array.from({ length: depth }, () => names[Math.floor(next() * names.length)]!);
  return [...folders, `f${Math.floor(next() * 3)}.ts`].join("/");
}

/**
 * Reference implementation: build the folder tree as an explicit graph (every
 * folder a node, an edge to its parent) and take the breadth-first shortest
 * path between the two files' folders. Shares no code with the formula.
 */
function naiveDistance(a: string, b: string): number {
  const adjacency = new Map<string, Set<string>>();
  const link = (x: string, y: string) => {
    adjacency.set(x, (adjacency.get(x) ?? new Set()).add(y));
    adjacency.set(y, (adjacency.get(y) ?? new Set()).add(x));
  };
  const addChain = (path: string) => {
    const parts = path.split("/").slice(0, -1);
    let parent = "/";
    adjacency.set(parent, adjacency.get(parent) ?? new Set());
    for (let i = 1; i <= parts.length; i++) {
      const node = "/" + parts.slice(0, i).join("/");
      link(parent, node);
      parent = node;
    }
  };
  addChain(a);
  addChain(b);
  const start = "/" + a.split("/").slice(0, -1).join("/");
  const goal = "/" + b.split("/").slice(0, -1).join("/");
  const seen = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (node === goal) return seen.get(node)!;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.set(next, seen.get(node)! + 1);
        queue.push(next);
      }
    }
  }
  throw new Error("tree is connected through the root");
}

test("matches a naive shortest-path implementation on generated paths", () => {
  const next = seededRandom(20240601);
  for (let i = 0; i < 2000; i++) {
    const a = randomPath(next);
    const b = randomPath(next);
    expect(treeDistance(a, b), `${a} to ${b}`).toBe(naiveDistance(a, b));
  }
});

test("is a metric: zero on identity, symmetric, and obeys the triangle inequality", () => {
  const next = seededRandom(7);
  for (let i = 0; i < 2000; i++) {
    const a = randomPath(next);
    const b = randomPath(next);
    const c = randomPath(next);
    expect(treeDistance(a, a)).toBe(0);
    expect(treeDistance(a, b)).toBe(treeDistance(b, a));
    expect(treeDistance(a, c)).toBeLessThanOrEqual(treeDistance(a, b) + treeDistance(b, c));
  }
});

test("is zero exactly when the files share a folder", () => {
  const next = seededRandom(99);
  for (let i = 0; i < 1000; i++) {
    const a = randomPath(next);
    const b = randomPath(next);
    expect(treeDistance(a, b) === 0).toBe(folderOf(a) === folderOf(b));
  }
});
