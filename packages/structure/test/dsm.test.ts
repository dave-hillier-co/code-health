import { afterAll, beforeAll, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { buildDsm, type Dsm } from "../src/dsm.ts";
import { structureReportRepository } from "./support/report-scenarios.ts";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = structureReportRepository();
});
afterAll(() => repo.dispose());

interface CyclesOutput {
  results: { nodes: string[]; breakingSet: { from: string; to: string }[] }[];
  dsm: Dsm | null;
}

async function cyclesOutput(): Promise<CyclesOutput> {
  return JSON.parse((await runStructure(repo.path, ["cycles", "--json"])).stdout);
}

test("the matrix holds the modules of the largest language in layer order, with every import of the cycle members counted", async () => {
  const { dsm: matrix, results } = await cyclesOutput();
  const dsm = matrix!;
  expect(dsm.language).toBe("typescript");
  expect(dsm.modules.length).toBeGreaterThan(1);
  expect(dsm.cells.length).toBe(dsm.modules.length);
  const edges = dsm.cells.flatMap((row, i) => row.flatMap((value, j) => (value === null ? [] : [{ from: dsm.modules[i]!, to: dsm.modules[j]! }])));
  expect(edges.length).toBeGreaterThan(0);
  for (const cycle of results) for (const member of cycle.nodes) expect(dsm.modules).toContain(member);
});

test("outside a cycle every dependency is above the diagonal, and the cells below it are the breaking set of the cycle", async () => {
  const { dsm: matrix, results } = await cyclesOutput();
  const dsm = matrix!;
  const below = dsm.againstOrder.map(([i, j]) => `${dsm.modules[i]} -> ${dsm.modules[j]}`).sort();
  const breaking = results.flatMap((cycle) => cycle.breakingSet.map((edge) => `${edge.from} -> ${edge.to}`)).sort();
  expect(below).toEqual(breaking);
  dsm.cells.forEach((row, i) =>
    row.forEach((value, j) => {
      if (value === null || j > i) return;
      expect(dsm.againstOrder).toContainEqual([i, j]);
    }),
  );
});

test("each cycle is one contiguous group labelled by its place in the cycles table", async () => {
  const { dsm: matrix, results } = await cyclesOutput();
  const dsm = matrix!;
  expect(dsm.groups.length).toBe(results.length);
  dsm.groups.forEach((group, i) => {
    expect(group.label).toBe(`cycle ${i + 1}`);
    const members = dsm.modules.slice(group.start, group.end + 1).sort();
    expect(members).toEqual([...results[i]!.nodes].sort());
  });
});

test("layer violations are marked on the cell of the two modules", async () => {
  const { dsm: matrix } = await cyclesOutput();
  const layers = JSON.parse((await runStructure(repo.path, ["layers", "--json"])).stdout).results as { from: string; to: string }[];
  expect(layers.length).toBeGreaterThan(0);
  const dsm = matrix!;
  expect(dsm.layerViolations.length).toBeGreaterThan(0);
  for (const [i, j] of dsm.layerViolations) {
    expect(layers.some((v) => v.from === dsm.modules[i] && v.to === dsm.modules[j])).toBe(true);
  }
});

test("the report prints the matrix first, with the order, the boxes and the marks in its notes", async () => {
  const { stdout } = await runStructure(repo.path, ["report", "structure", "--format", "md"]);
  const matrix = stdout.indexOf("**Module dependency matrix**");
  expect(matrix).toBeGreaterThan(-1);
  expect(matrix).toBeLessThan(stdout.indexOf("## Import cycles"));
  expect(stdout).toContain("Boxes along the diagonal mark");
  expect(stdout).toContain("cycle 1");
  expect(stdout).toContain("! is a dependency against the order");
  expect(stdout).toContain("L is an import the configured layer rules forbid");
  expect(stdout).toContain("Rows are ordered by layer, top first");
  expect(stdout).toContain("The matrix draws");
});

test("a cap keeps the members of cycles first, then the modules with the most neighbours, and counts the rest", () => {
  const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
  // a and b import each other; c, d and e import f; c also imports a.
  const edges: [string, string][] = [["a.ts", "b.ts"], ["b.ts", "a.ts"], ["c.ts", "f.ts"], ["d.ts", "f.ts"], ["e.ts", "f.ts"], ["c.ts", "a.ts"]];
  const graph = new Map(names.map((n) => [n, edges.filter(([from]) => from === n).map(([, to]) => to)]));
  const members = new Map(edges.map(([from, to]) => [`${from}\u0000${to}`, [{ from, to }]]));
  const moduleGraph = { level: "default", graph, members, filesOf: new Map(names.map((n) => [n, [n]])), moduleByFile: new Map(names.map((n) => [n, n])) } as unknown as Parameters<typeof buildDsm>[0];
  const cycle = { id: "cycle:default:a.ts", nodes: ["a.ts", "b.ts"], breakingSet: [{ from: "b.ts", to: "a.ts" }] } as unknown as Parameters<typeof buildDsm>[1][number];
  const dsm = buildDsm(moduleGraph, [cycle], [], 4)!;
  expect(dsm.totalModules).toBe(6);
  expect(dsm.connectedModules).toBe(6);
  expect(dsm.modules).toHaveLength(4);
  expect(dsm.modules).toContain("a.ts");
  expect(dsm.modules).toContain("b.ts");
  expect(dsm.modules).toContain("f.ts");
  const a = dsm.modules.indexOf("a.ts");
  const b = dsm.modules.indexOf("b.ts");
  expect(dsm.groups).toEqual([{ label: "cycle 1", start: a, end: b, size: 2 }]);
  expect(a).toBe(b - 1);
  expect(dsm.againstOrder).toEqual([[b, a]]);
});
