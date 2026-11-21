import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { scorePredictions } from "../src/abandonment/backtest.ts";
import { expectGolden } from "./support/golden.ts";
import { auth, deps, engine, knowledgeHistory, lexer, log, parser, routes, view } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, trials: 2000, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  configure();
});

const backtest = (...args: string[]) => runCochange(repo.path, ["abandonment", "backtest", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await backtest(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

test("precision and recall of a set of predictions, by hand", () => {
  const score = scorePredictions(new Set(["a", "b", "c", "d"]), new Set(["b", "c", "e"]));
  expect(score.hits).toEqual(["b", "c"]);
  expect(score.precision).toBe(0.5);
  expect(score.recall).toBeCloseTo(2 / 3, 12);
  expect(scorePredictions(new Set(), new Set(["a"]))).toMatchObject({ precision: null, recall: 0 });
  expect(scorePredictions(new Set(["a"]), new Set())).toMatchObject({ precision: 0, recall: null });
});

test("a model that expects everyone to leave predicts every file, and finds the three that were abandoned a year later", async () => {
  configure({ turnoverRate: 100 });
  const document = await json("--at", "2024-02-29", "--limit", "all");
  const { results } = document;
  expect(results.at).toBe("2024-02-29");
  // At that date nothing was abandoned yet: Cy and Di had each committed within the last six months.
  expect(results.candidates).toBe(7);
  expect(results.predicted).toEqual({ files: 7, goneByOutcome: 0 });
  // A year later Cy and Di had left: engine, parser (90 percent) and deps were abandoned, the lexer (80 percent) not.
  expect(results.actual).toEqual({ files: 3 });
  expect(results.truePositives).toBe(3);
  expect(results.precision).toBe(0.4286);
  expect(results.recall).toBe(1);
  const outcomes = Object.fromEntries(results.files.map((f: { path: string; outcome: string }) => [f.path, f.outcome]));
  expect(outcomes).toEqual({
    [engine]: "hit",
    [parser]: "hit",
    [deps]: "hit",
    [lexer]: "false-alarm",
    [routes]: "false-alarm",
    [auth]: "false-alarm",
    [log]: "false-alarm",
  });
  expect(outcomes[view]).toBeUndefined();
  expect(JSON.stringify(document)).not.toMatch(/example\.com|Ann|Bob|Cy|Eve/);
});

test("a model that expects nobody to leave predicts nothing, so it has no precision and misses everything", async () => {
  configure({ turnoverRate: 0 });
  const { results } = await json("--at", "2024-02-29");
  expect(results.predicted.files).toBe(0);
  expect(results.precision).toBeNull();
  expect(results.recall).toBe(0);
  expect(results.expectedAbandoned).toBe(0);
  expect(results.actual.files).toBe(3);
});

test("a prediction that came to nothing is a false alarm, and recall is undefined when nothing was abandoned", async () => {
  configure({ turnoverRate: 30, atRiskProbability: 20 });
  // One quarter from 29 November 2024: Ann, Bob and Eve are all still around at the end of it.
  const { results } = await json("--at", "2024-11-29", "--horizon", "1", "--limit", "all");
  expect(results.actual.files).toBe(0);
  expect(results.recall).toBeNull();
  expect(results.precision).toBe(0);
  expect(results.model.leaverProbability).toBe(0.3);
  // Files with one holder left at 30 percent cross the 20 percent line, and so does the lexer once Bob alone is left.
  // Routes has two holders, which is 9 percent.
  const falseAlarms = results.files.filter((f: { outcome: string }) => f.outcome === "false-alarm").map((f: { path: string }) => f.path);
  expect(falseAlarms.sort()).toEqual([auth, lexer, log, view].sort());
});

test("the rate comes from history up to the date and nothing after it", async () => {
  const { results } = await json("--at", "2024-02-29");
  // Cy's last commit is five and a half months before: he is not yet a departure, and nobody else has gone.
  expect(results.model).toMatchObject({ source: "history", ratePerPeriod: 0, departures: { departed: 0 } });
  expect(results.model.departures.atRisk).toBeGreaterThan(0);
});

test("the default date is one horizon before the last commit", async () => {
  configure({ turnoverRate: 10 });
  const { results } = await json();
  expect(results.at).toBe("2024-03-01");
  expect(results.outcomeAt).toBe("2025-03-01");
});

test("backtest, byte for byte", async () => {
  configure({ turnoverRate: 10 });
  const { stdout } = await backtest("--at", "2024-02-29", "--seed", "3", "--limit", "all");
  expectGolden("abandonment", "abandonment.backtest", stdout);
});

test("a date without a whole horizon after it, or before any history, or badly written, is refused", async () => {
  configure({ turnoverRate: 10 });
  const late = await backtest("--at", "2024-12-01");
  expect(late.code).toBe(ExitCode.Usage);
  expect(late.stderr).toContain("latest date is 2024-02-29");
  expect((await backtest("--at", "2022-01-01")).code).toBe(ExitCode.Usage);
  expect((await backtest("--at", "March")).code).toBe(ExitCode.Usage);
  expect((await backtest("--at", "2024-02-30")).code).toBe(ExitCode.Usage);
});

test("before enough history to estimate turnover it asks for a stated rate", async () => {
  configure({});
  const refused = await backtest("--at", "2023-04-01", "--horizon", "1");
  expect(refused.code).toBe(ExitCode.Usage);
  expect(refused.stderr).toContain("turnoverRate");
});

test("the options of other subcommands are not accepted", async () => {
  expect((await backtest("--mode", "k-leavers")).code).toBe(ExitCode.Usage);
  expect((await runCochange(repo.path, ["abandonment", "current", "--at", "2024-01-01"])).code).toBe(ExitCode.Usage);
});
