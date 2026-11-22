import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { hubRepository } from "./support/hub-scenarios.ts";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../src/cli.ts";
import { runStructure } from "./support/run.ts";
import { compareHubs, type Hub as ListedHub } from "../src/hubs.ts";

// Each case builds a repository of sixty commits, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Hub {
  id: string;
  file: string;
  module: string;
  level: string;
  featureCount: number;
  revisions: number;
  features: { module: string; shared: number; featureChanges: number; confidenceFeatureToHub: number; referencedBy: string | null }[];
  signalsReached: number;
  signals: {
    starCoChange: { reached: boolean; features: number; featurePairs: { classified: number; high: number } };
    outwardDependencies: { reached: boolean; referenced: number; of: number };
    appendShapedEdits: { reached: boolean; hunks: number; appendShaped: number; additions: number; removals: number; collection: { line: number; text: string } | null };
    contention: { reached: boolean; maxAuthors: number; windowDays: number };
  };
}

const fixtures: GitFixture[] = [];
afterAll(() => fixtures.forEach((f) => f.dispose()));

async function hubs(fixture: GitFixture, ...args: string[]) {
  const run = await runStructure(fixture.path, ["hubs", "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, rows: (JSON.parse(run.stdout) as { results: Hub[] }).results };
}

let routeTable: GitFixture;
beforeAll(() => {
  routeTable = hubRepository();
  fixtures.push(routeTable);
});

describe("structure hubs", () => {
  test("finds the route table that every feature has to edit, with the four signals", async () => {
    const { rows, stdout } = await hubs(routeTable);
    expect(rows.map((r) => r.file)).toEqual(["src/routes.ts"]);
    const [hub] = rows;
    expect(hub).toMatchObject({ id: "hub:src/routes.ts", module: "src", featureCount: 4, revisions: 13, signalsReached: 4 });
    expect(Object.values(hub!.signals).map((signal) => signal.reached)).toEqual([true, true, true, true]);
    expect(hub!.features.map((f) => f.module)).toEqual([
      "src/features/invoices",
      "src/features/orders",
      "src/features/reports",
      "src/features/users",
    ]);
    expect(hub!.features[0]).toMatchObject({ shared: 4, featureChanges: 4, confidenceFeatureToHub: 100, referencedBy: "import" });
    expect(hub!.signals.starCoChange.featurePairs).toMatchObject({ classified: 6, high: 0 });
    expect(hub!.signals.outwardDependencies).toMatchObject({ referenced: 4, of: 4 });
    expect(hub!.signals.appendShapedEdits).toMatchObject({ hunks: 22, appendShaped: 22, additions: 22, removals: 0 });
    expect(hub!.signals.appendShapedEdits.collection).toEqual({ line: 15, text: "export const routes = [" });
    expect(hub!.signals.contention).toMatchObject({ maxAuthors: 3 });
    expectGolden("hubs", "hubs", stdout);
  });

  test("counts the files it omitted for reaching fewer than two signals, in JSON and under the table", async () => {
    const run = await runStructure(routeTable.path, ["hubs", "--json"]);
    const { omitted } = JSON.parse(run.stdout) as { omitted: Record<string, number> };
    expect(omitted).toEqual({ minSignals: 2, considered: 6, files: 5, withoutDiffs: 5, belowMinRevisions: 0 });
    const table = await runInProcess(cli, routeTable.path, ["hubs"], true);
    expect(table.stdout).toContain("Notice: Omitted 5 of 6 files with at least");
    expect(table.stdout).toContain("each reached fewer than 2 of the 4 signals (5 of them without reading their diffs");
  });

  const reached = (hub: Hub) => Object.entries(hub.signals).filter(([, signal]) => signal.reached).map(([name]) => name).sort();

  test("lists the table with three signals when it is rewritten rather than appended to, and says which did not reach", async () => {
    const fixture = hubRepository({ edits: "rewrite" });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows.map((r) => [r.file, r.signalsReached])).toEqual([["src/routes.ts", 3]]);
    expect(reached(rows[0]!)).toEqual(["contention", "outwardDependencies", "starCoChange"]);
    expect(rows[0]!.signals.appendShapedEdits.reached).toBe(false);
  });

  test("lists the table with three signals when one person makes every edit, so there is no contention", async () => {
    const fixture = hubRepository({ authors: 1 });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows.map((r) => r.signalsReached)).toEqual([3]);
    expect(rows[0]!.signals.contention).toMatchObject({ reached: false, maxAuthors: 1 });
  });

  test("lists the table with two signals when it is rewritten by one person", async () => {
    const fixture = hubRepository({ edits: "rewrite", authors: 1 });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows.map((r) => r.signalsReached)).toEqual([2]);
    expect(reached(rows[0]!)).toEqual(["outwardDependencies", "starCoChange"]);
  });

  test("lists the table when too few features feed it, with the star signal not reached", async () => {
    const fixture = hubRepository({ features: ["orders", "invoices"] });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signals.starCoChange).toMatchObject({ reached: false, features: 2 });
    expect(rows[0]!.signalsReached).toBe(3);
  });

  test("a hub is ranked by the features feeding it", async () => {
    const fixture = hubRepository({ features: ["orders", "invoices", "users", "reports", "billing", "audit"] });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows[0]).toMatchObject({ file: "src/routes.ts", featureCount: 6 });
  });
});

describe("hub order", () => {
  const hub = (file: string, signalsReached: number, featureCount: number, maxAuthors = 3): ListedHub => ({
    id: `hub:${file}`,
    file,
    module: "src",
    level: "folder",
    featureCount,
    revisions: 10,
    features: [],
    signalsReached,
    signals: {
      starCoChange: { reached: true, features: featureCount, featurePairs: { classified: 0, high: 0 } },
      outwardDependencies: { reached: true, referenced: featureCount, of: featureCount },
      appendShapedEdits: { reached: true, hunks: 10, appendShaped: 10, additions: 10, removals: 0, collection: null },
      contention: { reached: true, maxAuthors, windowDays: 14 },
    },
  });

  test("sorts by signals reached first, then by the figures behind them", () => {
    const rows = [hub("src/a.ts", 2, 9), hub("src/b.ts", 4, 3), hub("src/c.ts", 3, 9), hub("src/d.ts", 4, 5), hub("src/e.ts", 4, 5, 6)];
    expect(rows.sort(compareHubs).map((r) => r.file)).toEqual(["src/e.ts", "src/d.ts", "src/b.ts", "src/c.ts", "src/a.ts"]);
  });
});
