import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runComplexity } from "./support/run.ts";
import { buildRepo } from "./support/scenarios.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = buildRepo();
});
afterAll(() => repo.dispose());

interface Increment {
  line: number;
  metric: string;
  construct: string;
  amount: number;
  nesting: number;
  code: string;
}

test("breaks a function down line by line, and the increments add up to its metrics", async () => {
  const run = await runComplexity(repo.path, ["explain", "src/pricing.ts#price", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  expectGolden("pricing", "explain", run.stdout);

  const document = JSON.parse(run.stdout);
  const rows = document.results as Increment[];
  const sum = (metric: string) => rows.filter((row) => row.metric === metric).reduce((total, row) => total + row.amount, 0);
  expect(sum("cognitive")).toBe(document.unit.metrics.cognitive);
  expect(sum("cyclomatic")).toBe(document.unit.metrics.cyclomatic);

  // Hand-counted: for +1, if +2 at nesting 1, && +1, else +1, ternary +3 at nesting 2.
  const cognitive = rows.filter((row) => row.metric === "cognitive").map((row) => [row.line, row.construct, row.amount, row.nesting]);
  expect(cognitive).toEqual([
    [3, "for-in", 1, 0],
    [4, "if", 2, 1],
    [4, "sequence of &&", 1, 0],
    [6, "else", 1, 0],
    [7, "ternary", 3, 2],
  ]);
  expect(rows.find((row) => row.line === 7 && row.metric === "cognitive")!.code).toBe("total += order.coupon ? item * 0.9 : item;");
});

test("describes a rule when given a name instead of a unit", async () => {
  const run = await runComplexity(repo.path, ["explain", "bumpy-road", "--json"]);
  expect(run.code).toBe(ExitCode.Success);
  expect(JSON.parse(run.stdout).results).toMatchObject({ rule: "bumpy-road" });
});

test("names the functions a file has when the unit is not found", async () => {
  const run = await runComplexity(repo.path, ["explain", "src/pricing.ts#nope"]);
  expect(run.code).toBe(ExitCode.Usage);
  expect(run.stderr).toContain('has no function "nope"; functions: price, double');
});

test("rejects a missing file, a file with no adapter, and no argument", async () => {
  expect((await runComplexity(repo.path, ["explain", "src/missing.ts#a"])).code).toBe(ExitCode.Usage);
  const go = await runComplexity(repo.path, ["explain", "src/total.go#Total"]);
  expect(go.code).toBe(ExitCode.Usage);
  expect(go.stderr).toContain("no structural adapter");
  expect((await runComplexity(repo.path, ["explain"])).code).toBe(ExitCode.Usage);
});
