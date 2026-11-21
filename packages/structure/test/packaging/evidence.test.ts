import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, packagesRun } from "./support/run.ts";
import { manifestsRepository } from "./support/scenarios.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

async function evidence(target: string) {
  const { document, stdout } = await packages(repo, "evidence", target);
  return { result: document.results as any, document, stdout };
}

describe("one package", () => {
  test("its row, balance, closure and every finding about it", async () => {
    const { result } = await evidence("packages/lib");
    expect(result).toMatchObject({ kind: "package", id: "packages/lib" });
    expect(result.row).toMatchObject({ kind: "published", consumers: ["packages/app", "packages/testkit", "packages/ui"] });
    expect(result.balance.matters).toBe("reuse");
    expect(result.closure).toMatchObject({ changes: 6 });
    expect(result.findings.map((f: { kind: string }) => f.kind)).toEqual(expect.arrayContaining(["partial-use", "disjoint-reuse", "overexposed", "inherited-weight"]));
  });

  test("co-change with every package it changed with, most shared changes first", async () => {
    const { result } = await evidence("packages/ui");
    expect(result.coChange[0]).toMatchObject({ package: "packages/api", shared: 12, fromChanges: 15, toChanges: 15, confidenceFromTo: 0.8 });
    expect(result.coChange[0].cost).toBeGreaterThan(8);
  });

  test("the reuse profile: surface, what each consumer uses, export components, unused exports", async () => {
    const { result } = await evidence("packages/lib");
    expect(result.reuse.surface.map((e: { exportedAs: string[] }) => e.exportedAs[0])).toEqual(["diff", "parse", "render", "serialize", "validate"]);
    expect(result.reuse.consumers).toEqual([
      { package: "packages/app", used: ["packages/lib/src/parse.ts#parse"], share: 0.2 },
      { package: "packages/testkit", used: ["packages/lib/src/parse.ts#parse"], share: 0.2 },
      { package: "packages/ui", used: ["packages/lib/src/render.ts#render"], share: 0.2 },
    ]);
    expect(result.reuse.components.map((c: { exports: string[] }) => c.exports.length)).toEqual([1, 1, 1, 1, 1]);
    expect(result.reuse.unused).toEqual(["packages/lib/src/diff.ts#diff", "packages/lib/src/serialize.ts#serialize", "packages/lib/src/validate.ts#validate"]);
    expect(result.reuse.entries).toEqual(["packages/lib/src/index.ts"]);
  });

  test("the deep uses of a package past its entry points", async () => {
    const { result } = await evidence("packages/helper");
    expect(result.reuse.hasExportsMap).toBe(false);
    expect(result.reuse.deepUses).toEqual([{ from: "packages/api/src/index.ts", to: "packages/helper/src/secret.ts", package: "packages/api" }]);
  });

  test("a package the structural layer cannot read has no reuse profile", async () => {
    const fixture = manifestsRepository();
    try {
      const { document } = await packages(fixture, "evidence", "dotnet/Web");
      expect(document.results).toMatchObject({ kind: "package", id: "dotnet/Web", reuse: null });
      expect((document.results as unknown as { row: { ecosystem: string } }).row.ecosystem).toBe("dotnet");
    } finally {
      fixture.dispose();
    }
  });
});

describe("one pair", () => {
  test("co-change in both directions, and the shared changes with their files", async () => {
    const { result } = await evidence("packages/ui->packages/api");
    expect(result).toMatchObject({ kind: "pair", from: "packages/ui", to: "packages/api", sharedChangesTotal: 12 });
    expect(result.coChange).toMatchObject({ shared: 12, confidenceFromTo: 0.8, confidenceToFrom: 0.8, tail: 0 });
    expect(result.sharedChanges).toHaveLength(12);
    expect(result.sharedChanges[0].files).toEqual(["packages/api/src/work.ts", "packages/ui/src/work.ts"]);
    expect(result.sharedChanges[0].touched).toEqual(["packages/api", "packages/ui"]);
  });

  test("the shared changes are newest first", async () => {
    const { result } = await evidence("packages/ui->packages/api");
    const dates = result.sharedChanges.map((c: { date: string }) => c.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test("the symbols one package uses of the other, and the dependency each way", async () => {
    const { result } = await evidence("packages/api->packages/helper");
    expect(result.dependencies.fromTo).toMatchObject({ declared: "runtime", productionImports: 2 });
    expect(result.dependencies.toFrom).toMatchObject({ declared: null, productionImports: 0, testImports: 1 });
    expect(result.symbols.fromTo.map((s: { symbol: string }) => s.symbol)).toEqual(["packages/helper/src/index.ts#help", "packages/helper/src/secret.ts#secret"]);
    expect(result.symbols.toFrom).toEqual([]);
  });

  test("consumers both use, and the findings about the pair", async () => {
    const { result } = await evidence("packages/api->packages/ui");
    expect(result.commonConsumers).toEqual([]);
    expect(result.findings.map((f: { id: string }) => f.id)).toContain("always-together:packages/api->packages/ui");
  });
});

describe("usage", () => {
  test("a package or a pair is required", async () => {
    expect((await packagesRun(repo, "evidence")).code).toBe(2);
  });

  test("a package that does not exist is a usage error", async () => {
    const run = await packagesRun(repo, "evidence", "packages/nowhere");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("is not a package");
  });

  test("a pair needs two different packages", async () => {
    expect((await packagesRun(repo, "evidence", "packages/ui->packages/ui")).code).toBe(2);
  });
});

test("goldens", async () => {
  expectGolden("workspace", "packages.evidence.package", (await evidence("packages/lib")).stdout);
  expectGolden("workspace", "packages.evidence.pair", (await evidence("packages/ui->packages/api")).stdout);
});
