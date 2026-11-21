import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { acyclicRepository, cyclesRepository } from "./support/scenarios.ts";

let repo: GitFixture;
let acyclic: GitFixture;
beforeAll(() => {
  repo = cyclesRepository();
  acyclic = acyclicRepository();
});
afterAll(() => {
  repo.dispose();
  acyclic.dispose();
});

interface Row {
  id: string;
  level: string;
  size: number;
  nodes: string[];
  method: string;
  breakingSet: { from: string; to: string; coChange: number; symbols: { symbol: string; sites: number }[] }[];
}

async function cycles(fixture: GitFixture, ...args: string[]) {
  const run = await runStructure(fixture.path, ["cycles", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as { results: Row[]; inputs: Record<string, unknown> } };
}

describe("file level", () => {
  test("finds each strongly connected component, largest first", async () => {
    const { document } = await cycles(repo, "--level", "file");
    expect(document.results.map((r) => r.nodes)).toEqual([
      ["src/c.ts", "src/d.ts", "src/e.ts"],
      ["src/a.ts", "src/b.ts"],
    ]);
    expect(document.results.map((r) => r.id)).toEqual(["cycle:file:src/c.ts", "cycle:file:src/a.ts"]);
  });

  test("a file that only depends on a cycle is not part of it", async () => {
    const { document } = await cycles(repo, "--level", "file");
    expect(document.results.flatMap((r) => r.nodes)).not.toContain("src/leaf.ts");
  });

  test("breaks the triangle at the edge whose sides co-change least, and names the symbol used", async () => {
    const { document, stdout } = await cycles(repo, "--level", "file");
    const triangle = document.results[0]!;
    expect(triangle.method).toBe("exact");
    expect(triangle.breakingSet).toHaveLength(1);
    expect(triangle.breakingSet[0]).toMatchObject({
      from: "src/e.ts",
      to: "src/c.ts",
      coChange: 1,
      symbols: [{ symbol: "src/c.ts#gamma", sites: 1 }],
    });
  });

  test("breaks a two file cycle at one edge", async () => {
    const { document } = await cycles(repo, "--level", "file");
    expect(document.results[1]!.breakingSet).toHaveLength(1);
  });

  test("golden", async () => {
    expectGolden("cycles", "cycles.file", (await cycles(repo, "--level", "file")).stdout);
  });
});

describe("folder level", () => {
  test("finds cycles between folders that no file cycle shows, the more co-changing one first", async () => {
    const { document } = await cycles(repo, "--level", "folder");
    expect(document.results.map((r) => r.nodes)).toEqual([
      ["src/core", "src/ui"],
      ["packages/p1/src", "packages/p2/src"],
    ]);
  });

  test("a folder edge lists the symbols used across the boundary", async () => {
    const { document } = await cycles(repo, "--level", "folder");
    const edge = document.results.find((r) => r.nodes.includes("src/ui"))!.breakingSet[0]!;
    expect(edge.symbols.length).toBeGreaterThan(0);
    expect(edge.symbols[0]!.symbol).toMatch(/^src\/(core|ui)\/\w+\.ts#\w+$/);
  });

  test("golden", async () => {
    expectGolden("cycles", "cycles.folder", (await cycles(repo, "--level", "folder")).stdout);
  });
});

describe("package level", () => {
  test("groups files under the nearest package.json", async () => {
    const { document } = await cycles(repo, "--level", "package");
    expect(document.results.map((r) => r.nodes)).toEqual([["packages/p1", "packages/p2"]]);
  });

  test("golden", async () => {
    expectGolden("cycles", "cycles.package", (await cycles(repo, "--level", "package")).stdout);
  });
});

test("the default level is file", async () => {
  const { document } = await cycles(repo);
  expect(document.inputs.level).toBe("file");
});

test("a repository with no cycle reports none", async () => {
  const { document, stdout } = await cycles(acyclic);
  expect(document.results).toEqual([]);
  expectGolden("acyclic", "cycles", stdout);
});

test("output is byte identical between runs", async () => {
  const first = await runStructure(repo.path, ["cycles", "--json", "--level", "folder"]);
  const second = await runStructure(repo.path, ["cycles", "--json", "--level", "folder"]);
  const strip = (s: string) => JSON.stringify({ ...JSON.parse(s), meta: undefined });
  expect(strip(second.stdout)).toBe(strip(first.stdout));
});

test("an unknown level is a usage error", async () => {
  const run = await runStructure(repo.path, ["cycles", "--level", "galaxy"]);
  expect(run.code).toBe(ExitCode.Usage);
});

test("a component larger than structure.exactLimit gets the heuristic set, which still breaks the cycle", async () => {
  const config = join(repo.path, "code-health.json");
  writeFileSync(config, JSON.stringify({ structure: { exactLimit: 2 } }));
  try {
    const { document, stdout } = await cycles(repo, "--level", "file");
    const triangle = document.results[0]!;
    expect(triangle.method).toBe("heuristic");
    expect(triangle.breakingSet).toHaveLength(1);
    expect(document.results[1]!.method).toBe("exact");
    expectGolden("cycles", "cycles.heuristic", stdout);
  } finally {
    rmSync(config);
  }
});
