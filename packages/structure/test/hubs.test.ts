import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { hubRepository } from "./support/hub-scenarios.ts";
import { runStructure } from "./support/run.ts";

// Each case builds a repository of sixty commits, and these suites run beside every other.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Hub {
  id: string;
  file: string;
  module: string;
  featureCount: number;
  revisions: number;
  features: { module: string; shared: number; featureChanges: number; confidenceFeatureToHub: number; referencedBy: string | null }[];
  signals: {
    starCoChange: { features: number; featurePairs: { classified: number; high: number } };
    outwardDependencies: { referenced: number; of: number };
    appendShapedEdits: { hunks: number; appendShaped: number; additions: number; removals: number; collection: { line: number; text: string } | null };
    contention: { maxAuthors: number; windowDays: number };
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
    expect(hub).toMatchObject({ id: "hub:src/routes.ts", module: "src", featureCount: 4, revisions: 13 });
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

  test("no hub when the table is rewritten rather than appended to", async () => {
    const fixture = hubRepository({ edits: "rewrite" });
    fixtures.push(fixture);
    expect((await hubs(fixture)).rows).toEqual([]);
  });

  test("no hub when one person makes every edit, so there is no contention", async () => {
    const fixture = hubRepository({ authors: 1 });
    fixtures.push(fixture);
    expect((await hubs(fixture)).rows).toEqual([]);
  });

  test("no hub when too few features feed it", async () => {
    const fixture = hubRepository({ features: ["orders", "invoices"] });
    fixtures.push(fixture);
    expect((await hubs(fixture)).rows).toEqual([]);
  });

  test("a hub is ranked by the features feeding it", async () => {
    const fixture = hubRepository({ features: ["orders", "invoices", "users", "reports", "billing", "audit"] });
    fixtures.push(fixture);
    const { rows } = await hubs(fixture);
    expect(rows[0]).toMatchObject({ file: "src/routes.ts", featureCount: 6 });
  });
});
