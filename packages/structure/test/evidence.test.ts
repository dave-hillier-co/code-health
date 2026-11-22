import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { withoutMeta } from "@code-health/fixtures/cli-testing";
import { expectGolden } from "./support/golden.ts";
import { runStructure } from "./support/run.ts";
import { couplingRepository } from "./support/coupling-scenarios.ts";
import { hubRepository } from "./support/hub-scenarios.ts";
import { cyclesRepository, misplacementRepository, stabilityRepository } from "./support/scenarios.ts";

let cycles: GitFixture;
let stability: GitFixture;
let misplacement: GitFixture;
let quadrants: GitFixture;
let routeTable: GitFixture;
beforeAll(() => {
  quadrants = couplingRepository();
  routeTable = hubRepository();
  cycles = cyclesRepository();
  stability = stabilityRepository();
  misplacement = misplacementRepository();
});
afterAll(() => {
  cycles.dispose();
  stability.dispose();
  misplacement.dispose();
  quadrants.dispose();
  routeTable.dispose();
});

interface Pack {
  id: string;
  kind: string | null;
  kinds: string[];
  findings: string[];
  level: string;
  from: string;
  to: string;
  quadrant: { name: string };
  inBreakingSet: boolean | null;
  breakingSet: { symbol: string; sites: number; usedBy: string[] }[];
  stabilityVerdict: { basis: string; aboveGuideline: boolean };
  coChange: { shared: number; fromChanges: number; toChanges: number; expected: number; eligibleChanges: number; confidenceFromTo: number };
  misplacement: { symbol: string; mostlyOn: string; moveMayRemoveDependency: boolean; onFromSide: number; onToSide: number; elsewhere: number }[];
  unblocks: { unit: string; unblockedGain: number }[];
  nearbyMechanisms: unknown[];
  layerRule: unknown;
}

async function evidence(fixture: GitFixture, ...args: string[]) {
  const run = await runStructure(fixture.path, ["evidence", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, document: JSON.parse(run.stdout) as { results: Pack[]; inputs: Record<string, unknown> } };
}

describe("an edge in a cycle", () => {
  test("carries the cycle, the symbols across it and whether it is in the breaking set", async () => {
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    const [pack] = document.results;
    expect(pack).toMatchObject({
      id: "edge:file:src/e.ts->src/c.ts",
      kind: "cycle",
      kinds: ["cycle"],
      findings: ["cycle:file:src/c.ts"],
      level: "file",
      inBreakingSet: true,
    });
    expect(pack!.breakingSet).toMatchObject([{ symbol: "src/c.ts#gamma", sites: 1, usedBy: ["src/e.ts"] }]);
  });

  test("an edge of the cycle outside the breaking set is still part of the cycle", async () => {
    const { document } = await evidence(cycles, "src/c.ts->src/d.ts");
    expect(document.results[0]).toMatchObject({ kind: "cycle", inBreakingSet: false });
  });

  test("co-change is given both ways with the figure independence would predict", async () => {
    const { document } = await evidence(cycles, "src/c.ts->src/d.ts");
    const { coChange } = document.results[0]!;
    expect(coChange).toMatchObject({ shared: 4, fromChanges: 4, toChanges: 6, eligibleChanges: 8, confidenceFromTo: 100 });
    expect(coChange.expected).toBe(3);
  });

  test("the mechanisms are listed nearby, and with no layers configured there is no layer rule", async () => {
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]).toMatchObject({ nearbyMechanisms: [], layerRule: null });
  });

  test("the pack recommends nothing", async () => {
    const { stdout } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(Object.keys(JSON.parse(stdout).results[0]).filter((k) => /recommend|remedy|technique/i.test(k))).toEqual([]);
  });

  test("golden", async () => {
    expectGolden("evidence", "evidence.edge", (await evidence(cycles, "src/e.ts->src/c.ts")).stdout);
  });
});

describe("a finding", () => {
  test("a cycle id gives one pack per breaking edge", async () => {
    const { document } = await evidence(cycles, "cycle:file:src/c.ts");
    expect(document.results.map((p) => p.id)).toEqual(["edge:file:src/e.ts->src/c.ts"]);
  });

  test("an unstable dependency id gives the edge at its level, with the verdict", async () => {
    const { document } = await evidence(stability, "unstable:folder:src/stable->src/volatile");
    const [pack] = document.results;
    expect(pack).toMatchObject({ level: "folder", kind: "unstable-dependency", findings: ["unstable:folder:src/stable->src/volatile"], inBreakingSet: null });
    expect(pack!.stabilityVerdict).toMatchObject({ basis: "change", aboveGuideline: true });
  });

  test("golden", async () => {
    expectGolden("evidence", "evidence.finding", (await evidence(stability, "unstable:folder:src/stable->src/volatile")).stdout);
  });
});

describe("a pair that is coupled by what it changes with", () => {
  test("a hidden pair has no import, and its pack says so and reports the hidden coupling", async () => {
    const { document } = await evidence(quadrants, "coupling:folder:src/billing->src/orders");
    const [pack] = document.results;
    expect(pack).toMatchObject({
      id: "edge:folder:src/billing->src/orders",
      kind: "hidden-coupling",
      kinds: ["hidden-coupling"],
      findings: ["coupling:folder:src/billing->src/orders"],
      quadrant: { name: "hidden" },
      inBreakingSet: null,
      breakingSet: [],
      imports: { fileEdges: 0, importStatements: 0 },
      coChange: { shared: 7 },
    });
  });

  test("an incidental pair reports incidental coupling, with its import to read", async () => {
    const { document } = await evidence(quadrants, "coupling:folder:src/ui->src/format");
    const [pack] = document.results;
    expect(pack).toMatchObject({ kind: "incidental-coupling", kinds: ["incidental-coupling"], findings: ["coupling:folder:src/ui->src/format"], quadrant: { name: "incidental" } });
    expect(pack!.breakingSet.length).toBeGreaterThan(0);
  });

  test("the pair can be named without the finding id, and either way round it is oriented as the coupling command orients it", async () => {
    const named = (await evidence(quadrants, "src/orders->src/billing")).document.results[0]!;
    expect(named).toMatchObject({ id: "edge:folder:src/billing->src/orders", from: "src/billing", to: "src/orders", kind: "hidden-coupling" });
  });

  test("a real pair is no problem, so it has no kind, whatever its quadrant says", async () => {
    const { document } = await evidence(quadrants, "src/pricing->src/tax");
    expect(document.results[0]).toMatchObject({ kind: null, kinds: [], findings: [], quadrant: { name: "real" } });
  });

  test("a pair with no import and no co-change to speak of is a usage error that says so", async () => {
    const run = await runStructure(quadrants.path, ["evidence", "--json", "src/tools->src/lonely"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("no dependency from");
  });

  test("the cycle and unstable findings are not changed by it", async () => {
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]!.kinds).toEqual(["cycle"]);
  });
});

describe("a registration hub", () => {
  test("gives one pack for the hub with its features, the four signals, the symbols it uses from them and what is nearby", async () => {
    const { document } = await evidence(routeTable, "hub:src/routes.ts");
    expect(document.results).toHaveLength(1);
    const [pack] = document.results as unknown as {
      id: string;
      kind: string;
      kinds: string[];
      findings: string[];
      level: string;
      file: string;
      module: string;
      features: { module: string; referencedBy: string | null; breakingSet: unknown[]; misplacement: unknown[] }[];
      signals: { contention: { maxAuthors: number } };
      stability: Record<string, unknown>;
      nearbyMechanisms: unknown[];
      unblocks: unknown[];
    }[];
    expect(pack).toMatchObject({ id: "hub:src/routes.ts", kind: "registration-hub", kinds: ["registration-hub"], findings: ["hub:src/routes.ts"], level: "folder", file: "src/routes.ts", module: "src" });
    expect(pack!.features.map((f) => f.module)).toEqual(["src/features/invoices", "src/features/orders", "src/features/reports", "src/features/users"]);
    expect(pack!.features.every((f) => f.referencedBy === "import")).toBe(true);
    expect(pack!.signals.contention.maxAuthors).toBe(3);
    expect(pack).toHaveProperty("stability");
    expect(pack!.nearbyMechanisms).toEqual([]);
    expect(pack!.unblocks).toEqual([]);
    expect(Object.keys(pack!).filter((k) => /recommend|remedy|technique/i.test(k))).toEqual([]);
  });

  test("a file that is not a hub is a usage error", async () => {
    const run = await runStructure(routeTable.path, ["evidence", "--json", "hub:src/features/orders/page.ts"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("no registration hub");
  });

  test("golden", async () => {
    expectGolden("evidence", "evidence.hub", (await evidence(routeTable, "hub:src/routes.ts")).stdout);
  });
});

describe("the level", () => {
  test("is inferred: two folders", async () => {
    expect((await evidence(cycles, "src/ui->src/core")).document.results[0]!.level).toBe("folder");
  });

  test("is inferred: two packages", async () => {
    expect((await evidence(cycles, "packages/p1->packages/p2")).document.results[0]!.level).toBe("package");
  });

  test("can be named", async () => {
    expect((await evidence(cycles, "src/ui->src/core", "--level", "folder")).document.inputs.level).toBe("folder");
  });
});

describe("misplacement", () => {
  test("a symbol whose consumers all sit on the depending side may move there", async () => {
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]!.misplacement).toEqual([
      { symbol: "src/c.ts#gamma", consumerFiles: 1, onFromSide: 1, onToSide: 0, elsewhere: 0, mostlyOn: "from", moveMayRemoveDependency: true },
    ]);
  });

  test("a symbol whose consumers mostly sit beside it belongs where it is", async () => {
    const { document } = await evidence(misplacement, "src/x->src/y");
    expect(document.results[0]!.misplacement[0]).toMatchObject({
      symbol: "src/y/helper.ts#helper",
      onFromSide: 1,
      onToSide: 2,
      mostlyOn: "to",
      moveMayRemoveDependency: false,
    });
  });

  test("a symbol used from three places is split when no side has a majority", async () => {
    const { document } = await evidence(stability, "src/app->src/lib");
    expect(document.results[0]!.misplacement[0]).toMatchObject({ onFromSide: 1, elsewhere: 2, mostlyOn: "split" });
  });
});

describe("a locality report", () => {
  function writeLocalityReport(fixture: GitFixture, head: string, dirty: boolean, edge: { from: string; to: string }) {
    const directory = join(fixture.path, ".cache", "code-health", "reports");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "locality.analyse.json"),
      JSON.stringify({
        schemaVersion: 1,
        tool: "locality",
        command: "analyse",
        repo: { head, dirty },
        config: "0123456789abcdef",
        results: [{ path: "src/leaf.ts", blockers: [{ path: edge.to, from: [edge.from], kind: "dependency", weight: 1, otherConsumers: 0, coChange: null, unblockedGain: 7 }] }],
      }),
    );
  }

  const head = () => cycles.git("rev-parse", "HEAD");

  test("a report stamped with the head names the moves the dependency blocks, and is named in inputs", async () => {
    await evidence(cycles, "src/e.ts->src/c.ts");
    writeLocalityReport(cycles, head(), false, { from: "src/e.ts", to: "src/c.ts" });
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]!.unblocks).toEqual([{ unit: "src/leaf.ts", unblockedGain: 7 }]);
    expect(document.inputs.locality).toEqual({ report: "locality.analyse", head: head(), config: "0123456789abcdef" });
  });

  test("it lifts the cycle it unblocks above larger cycles", async () => {
    const before = JSON.parse((await runStructure(cycles.path, ["cycles", "--json"])).stdout).results as { id: string; breakingSet: { from: string; to: string }[] }[];
    expect(before.map((r) => r.id)).toEqual(["cycle:file:src/c.ts", "cycle:file:src/a.ts"]);
    writeLocalityReport(cycles, head(), false, before[1]!.breakingSet[0]!);
    const after = JSON.parse((await runStructure(cycles.path, ["cycles", "--json"])).stdout).results as { id: string; unblockedGain: number | null }[];
    expect(after.map((r) => [r.id, r.unblockedGain])).toEqual([
      ["cycle:file:src/a.ts", 7],
      ["cycle:file:src/c.ts", 0],
    ]);
  });

  test("a report for another commit is ignored", async () => {
    writeLocalityReport(cycles, "0".repeat(40), false, { from: "src/e.ts", to: "src/c.ts" });
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]!.unblocks).toEqual([]);
    expect(document.inputs.locality).toBeNull();
  });

  test("a report of a schemaVersion other than 1 is ignored", async () => {
    writeLocalityReport(cycles, head(), false, { from: "src/e.ts", to: "src/c.ts" });
    const file = join(cycles.path, ".cache", "code-health", "reports", "locality.analyse.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"schemaVersion":1', '"schemaVersion":2'));
    const { document } = await evidence(cycles, "src/e.ts->src/c.ts");
    expect(document.results[0]!.unblocks).toEqual([]);
    expect(document.inputs.locality).toBeNull();
  });

  test("a report taken on a dirty tree is ignored", async () => {
    writeLocalityReport(cycles, head(), true, { from: "src/e.ts", to: "src/c.ts" });
    expect((await evidence(cycles, "src/e.ts->src/c.ts")).document.inputs.locality).toBeNull();
  });
});

describe("goldens and determinism", () => {
  test("a symbol that belongs where it is, and one used from three places, match their goldens", async () => {
    const stays = await evidence(misplacement, "src/x->src/y");
    expect(stays.document.results[0]!.misplacement[0]).toMatchObject({ mostlyOn: "to", moveMayRemoveDependency: false });
    expectGolden("evidence", "evidence.misplacement-to", stays.stdout);
    const split = await evidence(stability, "src/app->src/lib");
    expect(split.document.results[0]!.misplacement[0]).toMatchObject({ mostlyOn: "split" });
    expectGolden("evidence", "evidence.misplacement-split", split.stdout);
  });

  test("a locality report for another commit leaves the pack as if there were none, and the goldens of an edge and a finding differ", async () => {
    const plain = (await evidence(cycles, "src/e.ts->src/c.ts")).stdout;
    expect(withoutMeta((await evidence(cycles, "src/e.ts->src/c.ts")).stdout)).toBe(withoutMeta(plain));
    const finding = (await evidence(stability, "unstable:folder:src/stable->src/volatile")).stdout;
    expect(withoutMeta(plain)).not.toBe(withoutMeta(finding));
  });

  test("evidence is byte identical between runs, for an edge and for a finding", async () => {
    for (const [fixture, target] of [[cycles, "src/e.ts->src/c.ts"], [stability, "unstable:folder:src/stable->src/volatile"]] as const) {
      expect(withoutMeta((await evidence(fixture, target)).stdout)).toBe(withoutMeta((await evidence(fixture, target)).stdout));
    }
  });
});

describe("usage errors", () => {
  test.each([
    ["no target", []],
    ["a name that is not an edge", ["src/c.ts"]],
    ["a dependency that does not exist", ["src/c.ts->src/a.ts"]],
    ["a cycle that does not exist", ["cycle:file:src/nothing.ts"]],
    ["two names that are not modules", ["nowhere->elsewhere"]],
    ["an unknown level", ["src/c.ts->src/d.ts", "--level", "galaxy"]],
  ])("%s", async (_name, args) => {
    const run = await runStructure(cycles.path, ["evidence", ...args]);
    expect(run.code).toBe(ExitCode.Usage);
  });
});
