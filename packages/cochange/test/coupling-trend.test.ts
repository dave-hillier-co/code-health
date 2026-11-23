import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { pairTrend } from "../src/coupling-trend.ts";
import { couplingHistory } from "./support/coupling-scenarios.ts";
import { couplingTrendHistory } from "./support/coupling-trend-scenarios.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = couplingTrendHistory();
});
afterAll(() => repo.dispose());
afterEach(() => rmSync(join(repo.path, "code-health.json"), { force: true }));

const coupling = (...args: string[]) => runCochange(repo.path, ["coupling", "--trend", ...args, "--json"]);
const rowsOf = (stdout: string) => JSON.parse(stdout).results as Record<string, any>[];
const pairOf = (rows: Record<string, any>[], file: string) => rows.find((row) => row.path === file || row.with === file)!;

test("each pair is labelled against the previous window of the same length, and matches its golden", async () => {
  const { code, stdout, stderr } = await coupling();
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  expectGolden("coupling-trend", "coupling.trend", stdout);
  const rows = rowsOf(stdout);
  expect(pairOf(rows, "src/api/orders.ts")).toMatchObject({ degree: 80, previousDegree: 20, previousSupport: 2, degreeChange: 60, trend: "stronger" });
  expect(pairOf(rows, "src/config/flags.ts")).toMatchObject({ degree: 50, previousDegree: 90, previousSupport: 9, degreeChange: -40, trend: "weaker" });
});

test("a change of exactly the tolerance is stable", async () => {
  expect(pairOf(rowsOf((await coupling()).stdout), "src/billing/ledger.ts")).toMatchObject({ degree: 70, previousDegree: 60, degreeChange: 10, trend: "stable" });
});

test("a pair that shared no change before has previous degree and support 0 and counts as stronger", async () => {
  expect(pairOf(rowsOf((await coupling()).stdout), "src/search/ranking.ts")).toMatchObject({ previousDegree: 0, previousSupport: 0, degreeChange: 100, trend: "stronger" });
});

test("the previous window ends where the current one starts, and its size is stated", async () => {
  const document = JSON.parse((await coupling()).stdout);
  expect(document.inputs.trend).toEqual({ toleranceGuideline: 10 });
  expect(document.trendWindows.previous.until).toBe(document.window.since);
  expect(Date.parse(document.window.since) - Date.parse(document.trendWindows.previous.since)).toBe(Date.parse(document.window.until) - Date.parse(document.window.since));
  expect(document.trendWindows.previous.eligibleChanges).toBe(46);
});

test("a configured tolerance moves the stable band", async () => {
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"couplingTrendTolerance":50}}\n');
  const rows = rowsOf((await coupling()).stdout);
  expect(pairOf(rows, "src/api/orders.ts").trend).toBe("stronger");
  expect(pairOf(rows, "src/config/flags.ts").trend).toBe("stable");
  expect(pairOf(rows, "src/billing/ledger.ts").trend).toBe("stable");
  writeFileSync(join(repo.path, "code-health.json"), '{"cochange":{"couplingTrendTolerance":101}}\n');
  expect((await coupling()).code).toBe(ExitCode.Usage);
});

test("without --trend the fields and the column are absent", async () => {
  const { stdout } = await runCochange(repo.path, ["coupling", "--json"]);
  const document = JSON.parse(stdout);
  expect(document.trendWindows).toBeUndefined();
  expect(document.results.every((row: Record<string, unknown>) => !("trend" in row))).toBe(true);
});

test("the table has a trend column", async () => {
  const { stdout } = await coupling("--fields", "path,with,trend,degreeChange");
  expect(rowsOf(stdout)[0]).toHaveProperty("trend");
});

test("a history with nothing before the current window gives a null trend and says why", async () => {
  const young = couplingHistory();
  try {
    const document = JSON.parse((await runCochange(young.path, ["coupling", "--trend", "--json"])).stdout);
    expect(document.trendWindows.previous.eligibleChanges).toBe(0);
    expect(document.results.every((row: Record<string, unknown>) => row.trend === null && row.previousDegree === null && row.degreeChange === null)).toBe(true);
  } finally {
    young.dispose();
  }
});

test("pairTrend labels at the tolerance in whole tenths and treats a missing earlier pair as degree 0", () => {
  const now = { a: "a", b: "b", support: 5, changesA: 10, changesB: 10 };
  const index = new Map([["a\0b", { a: "a", b: "b", support: 4, changesA: 10, changesB: 10 }]]);
  expect(pairTrend(now, index, 10)).toMatchObject({ previousDegree: 40, degreeChange: 10, trend: "stable" });
  expect(pairTrend(now, index, 9)).toMatchObject({ trend: "stronger" });
  expect(pairTrend(now, new Map(), 10)).toMatchObject({ previousDegree: 0, previousSupport: 0, trend: "stronger" });
  expect(pairTrend(now, undefined, 10)).toEqual({ previousDegree: null, previousSupport: null, degreeChange: null, trend: null });
});
