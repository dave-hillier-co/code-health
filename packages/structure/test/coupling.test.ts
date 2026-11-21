import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { couplingRepository } from "./support/coupling-scenarios.ts";
import { runStructure } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = couplingRepository();
});
afterAll(() => repo.dispose());

interface Row {
  id: string;
  quadrant: string;
  from: string;
  to: string;
  staticCoupling: { sites: number; symbols: number; fromTo: number; toFrom: number; high: boolean };
  coChange: { shared: number; fromChanges: number; toChanges: number; expected: number; pValue: number; high: boolean };
}

async function coupling(command: string, ...args: string[]) {
  const run = await runStructure(repo.path, [command, "--json", ...args]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  return { stdout: run.stdout, rows: (JSON.parse(run.stdout) as { results: Row[] }).results };
}

const byPair = (rows: Row[]) => Object.fromEntries(rows.map((r) => [`${r.from}->${r.to}`, r]));

describe("structure coupling", () => {
  test("places each pair of folders in the quadrant its static coupling and co-change give it", async () => {
    const { rows, stdout } = await coupling("coupling");
    const pairs = byPair(rows);
    expect(Object.fromEntries(Object.entries(pairs).map(([pair, row]) => [pair, row.quadrant]))).toEqual({
      "src/pricing->src/tax": "real",
      "src/ui->src/format": "incidental",
      "src/app->src/kernel": "stable",
      "src/billing->src/orders": "hidden",
      "src/tools->src/misc": "independent",
      "src/lonely->src/shared": "insufficient-evidence",
    });
    expectGolden("coupling", "coupling", stdout);
  });

  test("a real pair shares every change and the figure independence predicts is far below it", async () => {
    const { rows } = await coupling("coupling");
    const real = byPair(rows)["src/pricing->src/tax"]!;
    expect(real.staticCoupling).toMatchObject({ sites: 3, symbols: 3, fromTo: 3, toFrom: 0, high: true });
    expect(real.coChange).toMatchObject({ shared: 7, fromChanges: 7, toChanges: 7, high: true });
    expect(real.coChange.expected).toBeCloseTo(1.167, 3);
    expect(real.coChange.pValue).toBeLessThan(1e-6);
  });

  test("an incidental pair is busy on both sides yet shares nothing beyond the first commit", async () => {
    const { rows } = await coupling("coupling");
    const row = byPair(rows)["src/ui->src/format"]!;
    expect(row.staticCoupling.high).toBe(true);
    expect(row.coChange).toMatchObject({ shared: 1, fromChanges: 7, toChanges: 7, high: false });
    expect(row.coChange.pValue).toBeGreaterThan(0.01);
  });

  test("a hidden pair has no import between its sides", async () => {
    const { rows } = await coupling("coupling");
    const row = byPair(rows)["src/billing->src/orders"]!;
    expect(row.staticCoupling).toMatchObject({ sites: 0, symbols: 0, high: false });
    expect(row.coChange).toMatchObject({ shared: 7, high: true });
  });

  test("--quadrant keeps one quadrant, and hidden is shorthand for it", async () => {
    const only = await coupling("coupling", "--quadrant", "hidden");
    const hidden = await coupling("hidden");
    expect(only.rows.map((r) => r.id)).toEqual(["coupling:folder:src/billing->src/orders"]);
    expect(hidden.rows.map((r) => r.id)).toEqual(only.rows.map((r) => r.id));
    expectGolden("coupling", "hidden", hidden.stdout);
  });

  test("an unknown quadrant is a usage error", async () => {
    const run = await runStructure(repo.path, ["coupling", "--quadrant", "stale"]);
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("--quadrant");
  });

  test("at file level the same pairs are found between files", async () => {
    const { rows } = await coupling("coupling", "--by", "file");
    const pairs = byPair(rows);
    expect(pairs["src/pricing/engine.ts->src/tax/rates.ts"]).toMatchObject({ quadrant: "real" });
    expect(pairs["src/billing/charge.ts->src/orders/place.ts"]).toMatchObject({ quadrant: "hidden" });
  });
});

describe("the quadrant of an evidence pack", () => {
  test("carries the figures behind it", async () => {
    const run = await runStructure(repo.path, ["evidence", "--json", "--level", "folder", "src/pricing->src/tax"]);
    const [pack] = JSON.parse(run.stdout).results;
    expect(pack.quadrant).toMatchObject({
      name: "real",
      staticCoupling: { sites: 3, high: true },
      coChange: { shared: 7, high: true },
      bothActive: true,
    });
  });

  test("says insufficient evidence where activity is too thin to tell", async () => {
    const run = await runStructure(repo.path, ["evidence", "--json", "--level", "folder", "src/lonely->src/shared"]);
    expect(JSON.parse(run.stdout).results[0].quadrant).toMatchObject({ name: "insufficient-evidence", bothActive: false });
  });
});
