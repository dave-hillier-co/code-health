import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { consumerGraph, importGraph, symbolGraph } from "../src/dependency-graphs.ts";
import { treeFromDirectory } from "../src/source-tree.ts";

const fixtures = fileURLToPath(new URL("../../../fixtures/ts-adapter/", import.meta.url));

async function analyse(name: string) {
  return analyseTree(await treeFromDirectory(`${fixtures}${name}`));
}

function plain(graph: Map<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(graph);
}

describe("importGraph", () => {
  it("is plain adjacency over paths, sorted, with barrels kept as nodes", async () => {
    const graph = importGraph(await analyse("barrels"));
    expect(plain(graph)["src/index.ts"]).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/inner/index.ts",
    ]);
    expect([...graph.keys()]).toEqual([...graph.keys()].sort());
  });
});

describe("consumerGraph", () => {
  it("points consumers at defining files and leaves test files out by default", async () => {
    const analysis = await analyse("consumers");
    expect(plain(consumerGraph(analysis))).toEqual({
      "app.ts": ["def.ts", "lib.ts"],
      "view.tsx": ["lib.ts"],
    });
    expect(plain(consumerGraph(analysis, { includeTests: true }))).toEqual({
      "__tests__/helper.ts": ["lib.ts"],
      "app.ts": ["def.ts", "lib.ts"],
      "lib.spec.ts": ["lib.ts"],
      "view.tsx": ["lib.ts"],
    });
  });

  it("follows barrels to the defining files, so a barrel is not a node", async () => {
    const graph = consumerGraph(await analyse("barrels"));
    expect(plain(graph)["consumer.ts"]).toContain("src/inner/x.ts");
    expect(graph.has("src/index.ts")).toBe(false);
  });
});

describe("symbolGraph", () => {
  it("uses symbol ids for units and paths for everything else", async () => {
    const graph = symbolGraph(await analyse("consumers"));
    expect(plain(graph)["app.ts#run"]).toEqual([
      "def.ts#def",
      "lib.ts#K",
      "lib.ts#f",
      "lib.ts#g",
      "lib.ts",
    ].sort(byBytes));
    expect(plain(graph)["app.ts"]).toEqual(["lib.ts#deco"]);
  });
});

function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
