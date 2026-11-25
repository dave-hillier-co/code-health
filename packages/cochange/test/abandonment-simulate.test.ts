import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { auth, deps, engine, knowledgeHistory, lexer, log, parser, routes, view } from "./support/knowledge-scenario.ts";
import { runCochange } from "./support/run.ts";
import { steadyHistory } from "./support/scenarios.ts";

vi.setConfig({ testTimeout: 120_000 });

let repo: GitFixture;
beforeAll(() => {
  repo = knowledgeHistory();
});
afterAll(() => repo.dispose());

function configure(knowledge: Record<string, unknown> = {}, more: Record<string, unknown> = {}): void {
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ ...more, cochange: { knowledge: { enabled: true, ...knowledge } } }));
}
beforeEach(() => {
  rmSync(join(repo.path, ".code-health"), { recursive: true, force: true });
  configure();
});

const abandonment = (...args: string[]) => runCochange(repo.path, ["abandonment", ...args]);
const json = async (...args: string[]) => {
  const { code, stdout, stderr } = await abandonment(...args);
  expect(stderr).toBe("");
  expect(code).toBe(ExitCode.Success);
  return JSON.parse(stdout);
};

test("turnover is departures over the people on the team at each period's start, with counts and no names, by hand", async () => {
  const document = await json("turnover", "--limit", "all");
  // Cy's last commit is in September 2023 and Di's in March 2024. Periods are quarters counted back from the
  // last commit, and the two latest are left out because a departure is known only a window (six months) later.
  expect(document.results.map((r: { developers: number; departed: number }) => [r.developers, r.departed])).toEqual([
    [2, 0],
    [4, 0],
    [4, 1],
    [3, 0],
    [3, 1],
    [2, 0],
  ]);
  expect(document.turnover).toEqual({ rate: 0.1111, atRisk: 18, departed: 2, periods: 6, configuredRatePercent: null });
  expect(JSON.stringify(document)).not.toMatch(/example\.com|Ann|Bob|Cy|Eve/);
  expectGolden("abandonment", "abandonment.turnover", (await abandonment("turnover", "--limit", "all")).stdout);
});

test("a configured turnover rate is reported beside the estimate and is the one simulation uses", async () => {
  configure({ turnoverRate: 5 });
  const document = await json("turnover");
  expect(document.turnover).toMatchObject({ rate: 0.1111, configuredRatePercent: 5 });
});

test("simulate in rate mode, byte for byte", async () => {
  const { stdout } = await abandonment("simulate", "--trials", "2000", "--seed", "42");
  expectGolden("abandonment", "abandonment.simulate", stdout);
});

test("the rate is the one observed in history, compounded over the horizon", async () => {
  const document = await json("simulate", "--trials", "200");
  // 2 departures in 18 developer-periods is 1/9 a quarter, and over a year 1 - (8/9)^4.
  expect(document.results.selection).toEqual({ source: "history", ratePerPeriod: 0.1111, leavers: null, leaverProbability: 0.3757, configuredRateIgnored: false });
  expect(document.results.horizonPeriods).toBe(4);
  expect(document.results.population).toEqual({ activeDevelopers: 3, files: 8, peopleLines: 75 });
});

test("with a rate of 0 the loss is what is already abandoned, and with a rate of 100 percent it is everything", async () => {
  configure({ turnoverRate: 0 });
  const none = (await json("simulate", "--trials", "50")).results.loss;
  expect(none.lines.increment.expected).toBe(0);
  expect(none.lines.total.expected).toBe(32);
  expect(none.lines.increment.atRisk[1].tailRatio).toBeNull();
  expect(none.files.total.expected).toBe(3);
  configure({ turnoverRate: 100 });
  const all = (await json("simulate", "--trials", "50")).results.loss;
  expect(all.lines.total.expected).toBe(75);
  expect(all.lines.total.expectedShare).toBe(1);
  expect(all.files.total.expected).toBe(8);
});

test("loss is reported as the increment over what is already abandoned, and in total", async () => {
  const { loss } = (await json("simulate", "--mode", "k-leavers", "--k", "3", "--trials", "20")).results;
  expect(loss.lines.baseline).toBe(32);
  expect(loss.lines.population).toBe(75);
  expect(loss.lines.increment.expected).toBe(43);
  expect(loss.lines.total.expected).toBe(75);
  expect(loss.lines.increment.atRisk[0]).toEqual({ alpha: 95, kar: 43, karShare: 0.5733, tailRatio: 1, expectedTailLoss: 43 });
  expect(loss.files).toMatchObject({ baseline: 3, population: 8 });
  expect(loss.files.increment.expected).toBe(5);
  expect(loss.files.total.expected).toBe(8);
});

test("historical mode samples the periods of the repository's own past and compounds them over the horizon", async () => {
  const document = await json("simulate", "--mode", "historical", "--trials", "6000", "--seed", "4");
  // The observed quarters ran at 0, 0, 25, 0, 33.3 and 0 percent, 9.72 percent on average. Four quarters are
  // sampled independently, so the mean probability is 1 - (1 - 0.0972)^4.
  expect(document.results.selection).toMatchObject({ source: "history", ratePerPeriod: null, leavers: null });
  expect(document.results.selection.leaverProbability).toBeGreaterThan(0.3358 - 0.02);
  expect(document.results.selection.leaverProbability).toBeLessThan(0.3358 + 0.02);
  const { stdout } = await abandonment("simulate", "--mode", "historical", "--trials", "2000", "--seed", "42");
  expectGolden("abandonment", "abandonment.simulate.historical", stdout);
});

test("historical mode ignores a configured rate, which describes the future rather than the past", async () => {
  configure({ turnoverRate: 100 });
  const document = await json("simulate", "--mode", "historical", "--trials", "300");
  expect(document.results.selection.leaverProbability).toBeLessThan(0.6);
});

test("k-leavers is a stress test: exactly k active developers leave, and the people are never named", async () => {
  const document = await json("simulate", "--mode", "k-leavers", "--k", "1", "--trials", "3000", "--seed", "5");
  expect(document.results.selection).toMatchObject({ source: "k-leavers", leavers: 1, ratePerPeriod: null, leaverProbability: 0.3333 });
  // One of three leaves: Ann costs 16 lines, Bob 17 and Eve 10, so no scenario loses more than 17.
  expect(document.results.loss.lines.increment.atRisk[1].kar).toBe(17);
  expect(document.results.loss.lines.increment.expected).toBeGreaterThan(14.0);
  expect(document.results.loss.lines.increment.expected).toBeLessThan(14.7);
  expect(JSON.stringify(document)).not.toMatch(/example\.com|Ann|Bob|Cy|Eve/);
});

test("k-leavers needs a k that can be drawn", async () => {
  expect((await abandonment("simulate", "--mode", "k-leavers")).code).toBe(ExitCode.Usage);
  const tooMany = await abandonment("simulate", "--mode", "k-leavers", "--k", "4");
  expect(tooMany.code).toBe(ExitCode.Usage);
  expect(tooMany.stderr).toContain("3 active developers");
  const stray = await abandonment("simulate", "--k", "2");
  expect(stray.code).toBe(ExitCode.Usage);
  expect(stray.stderr).toContain("k-leavers");
});

test("the same seed gives the same output byte for byte, and another seed does not", async () => {
  const strip = (text: string) => JSON.stringify({ ...JSON.parse(text), meta: undefined });
  const first = strip((await abandonment("simulate", "--trials", "500", "--seed", "9")).stdout);
  expect(strip((await abandonment("simulate", "--trials", "500", "--seed", "9")).stdout)).toBe(first);
  expect(strip((await abandonment("simulate", "--trials", "500", "--seed", "10")).stdout)).not.toBe(first);
});

test("the loss never falls as the turnover rate rises", async () => {
  const expected: number[] = [];
  for (const rate of [0, 2, 5, 10, 25, 60, 100]) {
    configure({ turnoverRate: rate });
    expected.push((await json("simulate", "--trials", "300")).results.loss.lines.increment.expected);
  }
  expect(expected).toEqual([...expected].sort((a, b) => a - b));
  expect(expected[0]).toBe(0);
  expect(expected[6]).toBe(43);
});

interface FileRow {
  path: string;
  findings: string[];
  [key: string]: unknown;
}
const byPath = (document: { results: { files: FileRow[] } }): Record<string, FileRow> =>
  Object.fromEntries(document.results.files.map((f) => [f.path, f]));

test("findings follow the table: abandoned, at risk where it changes, at risk where it is cold", async () => {
  const document = await json("simulate", "--trials", "3000", "--seed", "8", "--top", "20");
  const files = byPath(document);
  // Nobody active holds a line of the engine or of the dependency file, or changes a file coupled with them. Ann holds one line of the parser.
  expect(files[engine]!.findings).toEqual(["abandoned", "no-successor"]);
  expect(files[parser]!.findings).toEqual(["abandoned"]);
  expect(files[deps]!.findings).toEqual(["abandoned", "no-successor"]);
  // Auth and routes change together every ten days, so they are hotspots.
  expect(files[auth]).toMatchObject({ hotspot: true, hotspotPercentile: 0.6667, findings: ["at-risk-hot"] });
  expect(files[routes]).toMatchObject({ hotspot: true, findings: ["at-risk-hot"] });
  // The view changed once in the window: it is scored, low, and not a hotspot. The lexer and the log never changed in it.
  // None of the three has a file that changes with it, but an active developer holds lines in each, so each has a successor.
  expect(files[view]).toMatchObject({ hotspot: false, hotspotPercentile: 0.1667, findings: ["at-risk-cold"] });
  for (const cold of [lexer, log]) expect(files[cold]).toMatchObject({ hotspot: false, hotspotPercentile: 0, findings: ["at-risk-cold"] });
});

test("the at-risk line is configurable: routes, with two holders, falls under a higher one", async () => {
  configure({ atRiskProbability: 25 });
  const files = byPath(await json("simulate", "--trials", "3000", "--seed", "8"));
  expect(files[routes]!.findings).toEqual([]);
  expect(files[auth]!.findings).toEqual(["at-risk-hot"]);
});

test("files are ranked by probability weighted by the hotspot percentile, so what changes comes first", async () => {
  const document = await json("simulate", "--trials", "3000", "--seed", "8");
  const order = document.results.files.map((f: { path: string }) => f.path);
  expect(order.slice(0, 2)).toEqual([auth, routes]);
  // The view has a small weight. Files that never changed carry none: they keep the order of their probability, abandoned files first.
  expect(order.slice(2, 6)).toEqual([view, engine, parser, deps]);
  expect(document.results.files[0].score).toBeCloseTo(document.results.files[0].probability * 0.6667, 3);
});

test("--rank abandonment is the raw view, by probability alone", async () => {
  const document = await json("simulate", "--trials", "3000", "--seed", "8", "--rank", "abandonment");
  const order = document.results.files.map((f: { path: string }) => f.path);
  expect(order.slice(0, 3)).toEqual([engine, parser, deps]);
  expect(order[order.length - 1]).toBe(routes);
  expect(document.inputs.rank).toBe("abandonment");
  expect(document.results.files[0].score).toBe(1);
});

test("a component whose tail ratio reaches the configured one is concentrated, and the unassigned group never is", async () => {
  configure({ concentratedTailRatio: 1 }, { components: { api: "src/api/**", core: "src/core/**" } });
  const flagged = async () => {
    const document = await json("simulate", "--trials", "2000", "--seed", "8");
    return document.results.components.filter((c: { findings: string[] }) => c.findings.length > 0).map((c: { path: string }) => c.path).sort();
  };
  expect(await flagged()).toEqual(["api", "core"]);
  configure({ concentratedTailRatio: 100 }, { components: { api: "src/api/**", core: "src/core/**" } });
  expect(await flagged()).toEqual([]);
});

test("components report the tail ratio against the guideline, and rank by expected loss whatever the ratio", async () => {
  configure({ concentratedTailRatio: 100 }, { components: { api: "src/api/**", core: "src/core/**" } });
  const document = await json("simulate", "--trials", "2000", "--seed", "8");
  for (const c of document.results.components) {
    expect(c.guideline).toBe(100);
    if (c.tailRatio !== null) expect(c.ratioToGuideline).toBeCloseTo(c.tailRatio / 100, 3);
  }
  expect(document.results.components.map((c: { findings: string[] }) => c.findings)).toEqual(document.results.components.map(() => []));
});

test("historical mode says when it ignored a configured rate", async () => {
  configure({ turnoverRate: 0.2 });
  expect((await json("simulate", "--mode", "historical", "--trials", "200")).results.selection.configuredRateIgnored).toBe(true);
  expect((await json("simulate", "--trials", "200")).results.selection.configuredRateIgnored).toBe(false);
});

test("the options of each subcommand stay with it", async () => {
  expect((await abandonment("current", "--mode", "rate")).code).toBe(ExitCode.Usage);
  expect((await abandonment("turnover", "--trials", "10")).code).toBe(ExitCode.Usage);
  expect((await abandonment("simulate", "--by", "component")).code).toBe(ExitCode.Usage);
  expect((await abandonment("simulate", "--trials", "0")).code).toBe(ExitCode.Usage);
  expect((await abandonment("simulate", "--mode", "everyone")).code).toBe(ExitCode.Usage);
});

test("a history too short to estimate turnover asks for a configured rate instead of inventing one", async () => {
  const young = steadyHistory();
  try {
    writeFileSync(join(young.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true } } }));
    const refused = await runCochange(young.path, ["abandonment", "simulate", "--trials", "10"]);
    expect(refused.code).toBe(ExitCode.Usage);
    expect(refused.stderr).toContain("turnoverRate");
    const historical = await runCochange(young.path, ["abandonment", "simulate", "--mode", "historical", "--trials", "10"]);
    expect(historical.code).toBe(ExitCode.Usage);
    writeFileSync(join(young.path, "code-health.json"), JSON.stringify({ cochange: { knowledge: { enabled: true, turnoverRate: 5 } } }));
    const stated = await runCochange(young.path, ["abandonment", "simulate", "--trials", "10"]);
    expect(stated.code).toBe(ExitCode.Success);
    expect(JSON.parse(stated.stdout).results.selection.source).toBe("configured");
  } finally {
    young.dispose();
  }
});
